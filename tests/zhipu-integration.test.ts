import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { combinedSearch, prepareCombinedSearch } from '../src/search.js';
import { prepareRetrieval, retrieve } from '../src/retrieval.js';
import type { JsonObject } from '../src/result.js';
import { fixture, hit, page, payloads, reader, search, timer, url } from './zhipu-fixture.js';

const keys = {
  UNISEARCH_EXA_API_KEY: 'fixture-exa-key',
  UNISEARCH_MODEL_API_KEY: 'fixture-model-key',
};

test(
  'root search runs Zhipu and other sources concurrently and preserves the explicit output order',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const pending: { path: string; res: ServerResponse }[] = [];
    f.handle((call, res) => {
      pending.push({ path: call.path, res });
      if (pending.length === 3)
        for (const task of [...pending].reverse())
          task.res.end(JSON.stringify(payloads[task.path]));
    });
    const result = await f.run(
      ['search', 'q', '--extra-sources', 'zhipu,exa', '--format=json', '--verbose'],
      keys,
    );
    assert.equal(result.exit, 0);
    assert.deepEqual(
      result.json().data.extra_sources.map((s: JsonObject) => s.provider),
      ['zhipu', 'exa'],
    );
    assert.equal(result.json().data.extra_sources[0].data.provider, undefined);
    assert.equal(result.json().data.extra_sources[0].data.search_engine, 'search_std');
    assert.equal(
      f.calls.find((call) => call.path === '/gateway/web_search')?.headers.authorization,
      'Bearer fixture-zhipu-key',
    );
    assert.equal(
      f.calls.find((call) => call.path === '/exa/search')?.headers['x-api-key'],
      'fixture-exa-key',
    );
  },
);

test('root search preserves failed Zhipu evidence, accepts empty results and never reissues supplements on model fallback', async (t) => {
  const f = await fixture(t);
  for (const mode of ['empty', 'partial', 'model-failure', 'fallback'] as const) {
    f.save({ providers: { model: { fallback_models: [{ id: 'backup' }] } } });
    f.handle((call, res) => {
      if (call.path.startsWith('/model')) {
        if (mode === 'model-failure') {
          res.writeHead(401);
          res.end('{}');
        } else if (mode === 'fallback' && call.body?.model !== 'backup') res.end('{}');
        else res.end(JSON.stringify(payloads['/model/responses']));
      } else
        res.end(JSON.stringify({ search_result: mode === 'empty' ? [] : [hit, { link: 'bad' }] }));
    });
    const before = f.calls.length;
    const result = await f.run(
      ['search', 'q', '--extra-sources', 'zhipu', '--format=json', '--verbose'],
      keys,
    );
    assert.equal(result.exit, { empty: 0, partial: 6, 'model-failure': 3, fallback: 6 }[mode]);
    assert.equal(result.json().data.extra_sources[0].data.results.length, mode === 'empty' ? 0 : 1);
    const calls = f.calls.slice(before);
    assert.equal(calls.filter((call) => call.path === '/gateway/web_search').length, 1);
    if (mode !== 'empty')
      assert.ok(
        result
          .json()
          .error.details.failures.some(
            (f: JsonObject) => f.provider === 'zhipu' && f.code === 'INVALID_RESPONSE',
          ),
      );
    if (mode === 'fallback')
      assert.equal(calls.filter((call) => call.path.startsWith('/model')).length, 2);
  }
  const before = f.calls.length;
  for (const args of [
    ['search', '😀'.repeat(71), '--extra-sources', 'zhipu'],
    ['search', 'q', '--extra-sources', 'zhipu,zhipu'],
  ])
    assert.equal((await f.run(args, keys)).exit, 2);
  assert.equal(f.calls.length, before);
});

test('completed Zhipu search evidence survives sibling cancellation, timeout and internal failure', async (t) => {
  const f = await fixture(t);
  for (const mode of ['cancel', 'timeout', 'internal'] as const) {
    const time = timer();
    const controller = new AbortController();
    let complete!: () => void;
    const ready = new Promise<void>((resolve) => {
      complete = resolve;
    });
    f.reply(search);
    const plan = prepareCombinedSearch(
      'q',
      { extraSources: 'zhipu', timeout: 3 },
      {},
      { ...f.env, ...keys },
      'en',
    );
    const result = await combinedSearch(
      plan,
      controller.signal,
      'en',
      {},
      {
        clock: time.clock,
        transport: async (target, init) => {
          if (String(target).includes('/gateway/')) {
            const response = await fetch(target, init);
            const bytes = await response.arrayBuffer();
            setTimeout(complete, 0);
            return new Response(bytes);
          }
          await ready;
          if (mode === 'cancel') controller.abort();
          if (mode === 'timeout') time.advance(3001);
          if (mode === 'internal') throw new Error('fixture bug');
          return Response.json(payloads['/model/responses']);
        },
      },
    );
    assert.equal(result.exitCode, { cancel: 130, timeout: 4, internal: 5 }[mode]);
    const source = result.result.data?.extra_sources?.[0];
    assert.ok(source?.provider === 'zhipu');
    assert.equal(source.data.results[0].description, hit.content);
  }
});

test('root fetch includes configured Zhipu by default and validates all eligible candidates before requests', async (t) => {
  const f = await fixture(t);
  const defaultResult = await f.run(['fetch', url, '--format=json']);
  assert.equal(defaultResult.exit, 0, defaultResult.channels.out);
  assert.equal(defaultResult.json().data.provider, 'zhipu');
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ['/gateway/reader'],
  );
  f.calls.length = 0;
  assert.equal((await f.run(['config', 'set', 'fetch.providers', '["zhipu"]'])).exit, 0);
  assert.equal((await f.run(['fetch', url, '--format=json'])).json().data.provider, 'zhipu');
  f.save({ fetch: { providers: ['zhipu', 'exa'] }, providers: { exa: { base_url: 'bad' } } });
  const before = f.calls.length;
  assert.equal((await f.run(['fetch', url], { UNISEARCH_EXA_BASE_URL: undefined })).exit, 3);
  assert.equal(f.calls.length, before);
  assert.equal(
    (await f.run(['fetch', url, '--no-fallback'], { UNISEARCH_EXA_BASE_URL: undefined })).exit,
    0,
  );
  f.save({ fetch: { providers: ['exa', 'zhipu'] } });
  const malformed = { ...keys, UNISEARCH_ZHIPU_PLATFORM: 'unknown' };
  const next = f.calls.length;
  assert.equal((await f.run(['fetch', url], malformed)).exit, 3);
  assert.equal(f.calls.length, next);
  assert.equal((await f.run(['fetch', url, '--no-fallback'], malformed)).exit, 0);
});

test('root fetch switches both ways, respects permanent business errors and preserves distinct diagnostic IDs', async (t) => {
  const f = await fixture(t);
  for (const order of [
    ['zhipu', 'exa'],
    ['exa', 'zhipu'],
  ]) {
    f.save({ fetch: { providers: order } });
    f.handle((call, res) => {
      const provider = call.path.startsWith('/exa') ? 'exa' : 'zhipu';
      if (provider === order[0]) {
        res.writeHead(401);
        res.end(
          JSON.stringify({
            error: { code: '1000', message: 'key' },
            request_id: 'failed-request',
            id: 'failed-response',
          }),
        );
      } else res.end(JSON.stringify(payloads[call.path]));
    });
    const result = await f.run(['fetch', url, '--format=json', '--verbose'], keys);
    assert.equal(result.exit, 0);
    assert.equal(result.json().data.provider, order[1]);
    assert.deepEqual(
      result.json().meta.attempts.map((a: JsonObject) => a.provider),
      order,
    );
    if (order[0] === 'zhipu') {
      assert.equal(result.json().meta.attempts[0].request_id, 'failed-request');
      assert.equal(result.json().meta.attempts[0].response_id, 'failed-response');
    }
    assert.equal((await f.run(['fetch', url, '--no-fallback'], keys)).exit, 3);
  }
  f.save({ fetch: { providers: ['zhipu', 'exa'] } });
  for (const [code, status, switches] of [
    ['1113', 200, true],
    ['1200', 200, true],
    ['1301', 503, false],
    ['1210', 200, false],
    ['unknown', 200, false],
    ['1701', 200, false],
  ] as const) {
    f.handle((call, res) => {
      if (call.path.startsWith('/gateway')) {
        res.writeHead(status);
        res.end(JSON.stringify({ error: { code, message: 'fixture' } }));
      } else res.end(JSON.stringify(payloads[call.path]));
    });
    const before = f.calls.length;
    const result = await f.run(['fetch', url, '--format=json'], keys);
    assert.equal(f.calls.length - before, switches ? 2 : 1, code);
    assert.equal(result.exit === 0, switches);
  }
});

test('root fetch keeps the latest reliable body when subsequent failures have only metadata', async (t) => {
  const f = await fixture(t);
  for (const order of [
    ['zhipu', 'exa'],
    ['exa', 'zhipu'],
  ]) {
    f.save({ fetch: { providers: order } });
    f.handle((call, res) => {
      const provider = call.path.startsWith('/gateway') ? 'zhipu' : 'exa';
      if (provider === 'zhipu')
        res.end(
          JSON.stringify({
            ...reader,
            reader_result: {
              ...page,
              title: provider === order[0] ? 1 : 'Metadata',
              content: provider === order[0] ? page.content : '',
            },
          }),
        );
      else
        res.end(
          JSON.stringify({
            results:
              provider === order[0]
                ? [
                    { url, text: 'Exa body' },
                    { url, text: 'Extra body' },
                  ]
                : [],
          }),
        );
    });
    const result = await f.run(['fetch', url, '--format=json', '--verbose'], keys);
    assert.equal(result.exit, 4);
    assert.equal(result.json().data.provider, order[0]);
    assert.equal(
      result.json().data.results[0].text,
      order[0] === 'zhipu' ? page.content : 'Exa body',
    );
    assert.equal(result.json().error.code, 'ALL_PROVIDERS_FAILED');
    const zhipuAttempt = result
      .json()
      .meta.attempts.find((a: JsonObject) => a.provider === 'zhipu');
    assert.equal(zhipuAttempt.request_id, undefined);
    assert.equal(zhipuAttempt.response_id, undefined);
    assert.equal(
      result.json().error.details.failures.find((e: JsonObject) => e.provider === 'zhipu').details
        .response_id,
      reader.id,
    );
  }
});

test('Zhipu service switching uses the classified error even when its business code is redacted', async (t) => {
  const f = await fixture(t);
  f.save({ fetch: { providers: ['zhipu', 'exa'] } });
  for (const [code, status, switches] of [
    ['1301', 503, false],
    ['1200', 200, true],
  ] as const) {
    f.handle((call, res) => {
      if (call.path.startsWith('/gateway')) {
        res.writeHead(status);
        res.end(JSON.stringify({ error: { code, message: 'fixture failure' } }));
      } else res.end(JSON.stringify(payloads[call.path]));
    });
    const before = f.calls.length;
    const result = await f.run(['fetch', url, '--format=json'], {
      ...keys,
      UNISEARCH_ZHIPU_API_KEY: code,
    });
    assert.equal(result.exit, switches ? 0 : 4);
    assert.equal(f.calls.length - before, switches ? 2 : 1);
    if (!switches) assert.equal(result.json().error.details.upstream_code, '[REDACTED]');
  }
});

test('root fetch does not turn an interrupted permanent refusal into a retry or unauthorized switch', async (t) => {
  const f = await fixture(t);
  for (const status of [400, 401, 404]) {
    const time = timer();
    f.handle((call, res) => {
      res.writeHead(call.path.startsWith('/gateway') ? status : 200);
      res.end(JSON.stringify(payloads[call.path]));
    });
    const plan = prepareRetrieval(
      'fetch',
      url,
      {},
      { fetch: { providers: ['zhipu', 'exa'] } },
      { ...f.env, ...keys, UNISEARCH_RETRIES: '2' },
      'en',
    );
    const before = f.calls.length;
    const result = await retrieve(
      plan,
      new AbortController().signal,
      'en',
      {},
      {
        clock: time.clock,
        transport: async (...args) => {
          const response = await fetch(...args);
          if (String(args[0]).includes('/gateway')) {
            const read = response.arrayBuffer.bind(response);
            response.arrayBuffer = async () => {
              await read();
              throw new TypeError('fetch failed', {
                cause: Object.assign(new Error('interrupted body'), { code: 'ECONNRESET' }),
              });
            };
          }
          return response;
        },
      },
    );
    assert.equal(f.calls.length - before, status === 401 ? 2 : 1);
    assert.equal(result.exitCode, status === 401 ? 0 : 4);
    assert.deepEqual(time.waits, []);
  }
});

test('root fetch uses one controlled deadline across Zhipu and subsequent providers', async (t) => {
  const f = await fixture(t);
  f.handle((call, res) =>
    res.end(
      JSON.stringify(
        call.path.startsWith('/gateway')
          ? { reader_result: { url, title: 'Metadata', content: '' } }
          : payloads[call.path],
      ),
    ),
  );
  for (const timeout of [2, 10]) {
    const time = timer();
    const plan = prepareRetrieval(
      'fetch',
      url,
      { timeout },
      { fetch: { providers: ['zhipu', 'exa'] } },
      { ...f.env, ...keys },
      'en',
    );
    const result = await retrieve(
      plan,
      new AbortController().signal,
      'en',
      {},
      {
        clock: time.clock,
        transport: async (...args) => {
          const response = await fetch(...args);
          const bytes = await response.arrayBuffer();
          time.advance(2000);
          return new Response(bytes);
        },
      },
    );
    assert.equal(result.exitCode, timeout === 2 ? 4 : 0);
    assert.deepEqual(time.caps, timeout === 2 ? [2000] : [10000, 8000]);
  }
});

test('Zhipu JSON, Markdown, verbose and file output preserve content and save reliable failed data', async (t) => {
  const f = await fixture(t);
  const output = join(f.root, '结果 file');
  for (const format of ['json', 'markdown'])
    for (const op of ['search', 'fetch']) {
      const body = op === 'fetch' ? reader : search;
      f.reply(body);
      const result = await f.run([
        'zhipu',
        op,
        op === 'search' ? 'q' : url,
        '--format',
        format,
        '--output',
        output,
        '--verbose',
      ]);
      assert.equal(result.exit, 0);
      assert.equal(result.channels.out, '');
      const saved = readFileSync(output, 'utf8');
      if (format === 'json') {
        const data = JSON.parse(saved);
        assert.equal(data.meta.attempts[0].request_id, body.request_id);
        assert.equal(result.channels.err, '');
      } else {
        assert.ok(saved.includes(op === 'fetch' ? page.content : hit.content));
        assert.doesNotMatch(
          saved,
          /fixture-reader-model|fixture-reader-task|fixture-search-request/,
        );
        assert.match(result.channels.err, /Request ID/);
        if (op === 'fetch') {
          assert.match(result.channels.err, /Response ID fixture-reader-task/);
          assert.match(result.channels.err, /Model: fixture-reader-model/);
        }
      }
      f.reply(
        op === 'fetch'
          ? { reader_result: { ...page, title: 1 } }
          : { search_result: [hit, { link: 'bad' }] },
      );
      const failed = await f.run([
        'zhipu',
        op,
        op === 'search' ? 'q' : url,
        '--format',
        format,
        '--output',
        output,
      ]);
      assert.equal(failed.exit, 4);
      const retained = readFileSync(output, 'utf8');
      assert.match(retained, /INVALID_RESPONSE/);
      if (format === 'markdown') assert.match(retained, /Response field/);
      f.reply({ error: { code: '1113', message: 'quota' } });
      assert.equal(
        (
          await f.run([
            'zhipu',
            op,
            op === 'search' ? 'q' : url,
            '--format',
            format,
            '--output',
            output,
          ])
        ).exit,
        4,
      );
      assert.equal(readFileSync(output, 'utf8'), retained);
    }
  const before = f.calls.length;
  assert.equal(
    (await f.run(['zhipu', 'fetch', url, '--output', join(f.root, 'missing', 'file')])).exit,
    5,
  );
  assert.equal(f.calls.length, before);
});
