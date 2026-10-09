import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { prepareRetrieval, retrieve } from '../src/retrieval.js';
import { prepareCombinedSearch, combinedSearch } from '../src/search.js';
import type { JsonObject } from '../src/result.js';
import type { ExecutionClock } from '../src/execution.js';
import { fixture, envelope, page, pageUrl, payloads } from './anysearch-fixture.js';

test('AnySearch is an anonymous default fetch candidate and explicit lists replace defaults', async (t) => {
  const f = await fixture(t);
  const defaults = (await f.run(['config', 'get', 'fetch.providers'])).json().data
    .value as string[];
  assert.equal(defaults.at(-1), 'anysearch');
  const fetched = await f.run(['fetch', pageUrl, '--format=json']);
  assert.equal(fetched.exit, 0, fetched.channels.out);
  assert.equal(fetched.json().data.provider, 'anysearch');
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ['/gateway/v1/extract'],
  );
  assert.deepEqual(f.calls[0].body, { url: pageUrl });
  assert.equal(f.calls[0].headers.authorization, undefined);
  for (const providers of [[], ['exa']]) {
    f.save({ fetch: { providers } });
    const before = f.calls.length;
    assert.equal((await f.run(['fetch', pageUrl])).exit, 3);
    assert.equal(f.calls.length, before);
  }
  f.save({ providers: { jina: { enabled: false }, anysearch: { enabled: false } } });
  assert.equal((await f.run(['fetch', pageUrl])).exit, 3);
  f.save({
    fetch: { providers: ['anysearch', 'exa'] },
    providers: { exa: { api_key: 'fixture-exa', base_url: 'bad' } },
  });
  const before = f.calls.length;
  assert.equal((await f.run(['fetch', pageUrl], { UNISEARCH_EXA_BASE_URL: undefined })).exit, 3);
  assert.equal(f.calls.length, before);
  assert.equal(
    (await f.run(['fetch', pageUrl, '--no-fallback'], { UNISEARCH_EXA_BASE_URL: undefined })).exit,
    0,
  );
});

test('AnySearch and Exa fetch switch in both directions with normalized data and stable diagnostics', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_EXA_API_KEY = 'fixture-exa';
  for (const order of [
    ['anysearch', 'exa'],
    ['exa', 'anysearch'],
  ]) {
    f.calls.length = 0;
    f.save({ fetch: { providers: order } });
    const first = order[0] === 'anysearch' ? '/gateway/v1/extract' : '/exa/contents';
    f.handle((call, res) => {
      if (call.path === first) {
        res.writeHead(401, { 'x-request-id': 'failed-id' });
        res.end(JSON.stringify({ code: -1, message: 'bad key' }));
      } else {
        res.writeHead(200, { 'x-request-id': 'good-id' });
        res.end(JSON.stringify(payloads[call.path]));
      }
    });
    const result = await f.run(['fetch', pageUrl, '--format=json', '--verbose']);
    assert.equal(result.exit, 0, result.channels.out);
    assert.equal(result.json().data.provider, order[1]);
    assert.equal(result.json().data.results[0].text, page.content);
    assert.deepEqual(
      result.json().meta.service_fallbacks.map((x: JsonObject) => [x.from, x.to]),
      [order],
    );
    assert.equal(result.json().meta.attempts[0].request_id, 'failed-id');
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls.find((c) => c.path === '/gateway/v1/extract')?.body, { url: pageUrl });
    const before = f.calls.length;
    assert.equal((await f.run(['fetch', pageUrl, '--no-fallback'])).exit, 3);
    assert.equal(f.calls.length, before + 1);
  }
});

test('AnySearch fetch switches on eligible failures and aggregates errors without duplicate IDs', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_EXA_API_KEY = 'fixture-exa';
  f.save({ fetch: { providers: ['anysearch', 'exa'] } });
  for (const [status, body, switched] of [
    ...[401, 403, 402, 422, 429, 500].map(
      (s) => [s, { code: -1, message: 'failure' }, true] as const,
    ),
    [200, envelope({ ...page, content: ' ' }), true],
    [200, {}, true],
    [500, { code: -1, message: 'upstream failure', error_code: 'SCRAPE_JOB_CANCELLED' }, true],
    [400, { code: -1, message: 'bad input' }, false],
    [404, { code: -1, message: 'unknown' }, false],
    [200, { code: -1, message: 'business failure' }, false],
  ] as const) {
    f.calls.length = 0;
    f.handle((call, res) => {
      if (call.path.startsWith('/gateway/')) {
        res.writeHead(status);
        res.end(JSON.stringify(body));
      } else res.end(JSON.stringify(payloads[call.path]));
    });
    const result = await f.run(['fetch', pageUrl, '--format=json']);
    assert.equal(f.calls.length, switched ? 2 : 1, `${status}: ${JSON.stringify(body)}`);
    if (switched) assert.equal(result.json().data.provider, 'exa');
    else assert.ok(result.exit > 0);
  }
  for (const [second, expectedExit] of [
    [401, 3],
    [402, 4],
    [400, 2],
  ] as const) {
    f.handle((call, res) => {
      const status = call.path.startsWith('/gateway/') ? 401 : second;
      res.writeHead(status, { 'x-request-id': call.path });
      res.end(JSON.stringify({ code: -1, message: 'failure' }));
    });
    const result = await f.run(['fetch', pageUrl, '--format=json', '--verbose']);
    assert.equal(result.exit, expectedExit);
    assert.equal(
      result.json().error.code,
      second === 400 ? 'INVALID_ARGUMENT' : 'ALL_PROVIDERS_FAILED',
    );
    assert.deepEqual(
      result.json().error.details.failures.map((x: JsonObject) => x.provider),
      ['anysearch', 'exa'],
    );
    assert.ok(result.json().meta.attempts.every((x: JsonObject) => x.request_id === undefined));
    assert.equal(result.json().meta.service_fallbacks, undefined);
  }
});

test('AnySearch fetch shares the deadline across retries and switching and stops on cancellation or internal errors', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_EXA_API_KEY = 'fixture-exa';
  const values = { fetch: { providers: ['anysearch', 'exa'] } };
  for (const mode of ['switch', 'total', 'cancel', 'internal'] as const) {
    let now = 0;
    const caps: number[] = [];
    const controller = new AbortController();
    const time: ExecutionClock = {
      now: () => now,
      wallNow: () => 0,
      schedule(ms) {
        caps.push(ms);
        return () => {};
      },
      async sleep(ms) {
        now += ms;
      },
    };
    f.calls.length = 0;
    f.handle((call, res) => {
      if (call.path.startsWith('/gateway/')) {
        now += mode === 'total' ? 4000 : 1000;
        res.writeHead(429, { 'retry-after': '5' });
        res.end(JSON.stringify({ code: -1, message: 'busy' }));
      } else res.end(JSON.stringify(payloads[call.path]));
    });
    const transport: typeof fetch = async (url, init) => {
      if (mode === 'internal') throw new Error('unexpected');
      const response = await fetch(url, init);
      if (mode === 'cancel') controller.abort();
      return response;
    };
    const result = await retrieve(
      prepareRetrieval(
        'fetch',
        pageUrl,
        { timeout: 4 },
        values,
        { ...f.env, UNISEARCH_RETRIES: '1' },
        'en',
      ),
      controller.signal,
      'en',
      {},
      { clock: time, transport },
    );
    assert.equal(result.exitCode, { switch: 0, total: 4, cancel: 130, internal: 5 }[mode]);
    assert.deepEqual(caps, mode === 'switch' ? [4000, 3000] : [4000]);
    assert.equal(f.calls.length, { switch: 2, total: 1, cancel: 1, internal: 0 }[mode]);
  }
});

test(
  'model, AnySearch and Exa start concurrently and keep explicit source order after reverse completion',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    f.env.UNISEARCH_MODEL_API_KEY = 'fixture-model';
    f.env.UNISEARCH_EXA_API_KEY = 'fixture-exa';
    f.save({ providers: { anysearch: { search: { limit: 2 } } } });
    const pending: { path: string; res: ServerResponse }[] = [];
    f.handle((call, res) => {
      pending.push({ path: call.path, res });
      if (
        !['/model/responses', '/gateway/v1/search', '/exa/search'].every((path) =>
          pending.some((p) => p.path === path),
        )
      )
        return;
      for (const item of pending.toReversed()) item.res.end(JSON.stringify(payloads[item.path]));
    });
    const result = await f.run([
      'search',
      'q',
      '--extra-sources',
      'anysearch,exa',
      '--format=json',
      '--timeout',
      '2',
    ]);
    assert.equal(result.exit, 0, result.channels.out);
    assert.deepEqual(
      result.json().data.extra_sources.map((s: JsonObject) => s.provider),
      ['anysearch', 'exa'],
    );
    assert.deepEqual(f.calls.find((c) => c.path === '/gateway/v1/search')?.body, {
      query: 'q',
      max_results: 2,
      format: 'markdown',
    });
    assert.ok(
      result
        .json()
        .data.extra_sources.every((s: { data: JsonObject }) => s.data.provider === undefined),
    );
    f.handle((call, res) => res.end(JSON.stringify(payloads[call.path])));
    f.calls.length = 0;
    await f.run(['search', 'q', '--format=json']);
    assert.deepEqual(
      f.calls.map((c) => c.path),
      ['/model/responses'],
    );
  },
);

test('AnySearch search failures, valid empty supplements and model fallback retain independent results', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_MODEL_API_KEY = 'fixture-model';
  f.env.UNISEARCH_EXA_API_KEY = 'fixture-exa';
  for (const mode of ['empty', 'any-failure', 'all-extras', 'model-failure', 'fallback'] as const) {
    f.calls.length = 0;
    f.save({ providers: { model: { fallback_models: [{ id: 'backup' }] } } });
    f.handle((call, res) => {
      const model = call.path === '/model/responses';
      const any = call.path === '/gateway/v1/search';
      if (
        (model && mode === 'model-failure') ||
        (!model && mode === 'all-extras') ||
        (any && mode === 'any-failure')
      ) {
        res.writeHead(401);
        res.end(JSON.stringify({ code: -1, message: 'bad key' }));
      } else if (model && mode === 'fallback' && call.body?.model !== 'backup') res.end('{}');
      else if (any && mode === 'empty') res.end(JSON.stringify(envelope({ results: [] })));
      else res.end(JSON.stringify(payloads[call.path]));
    });
    const result = await f.run([
      'search',
      'q',
      '--extra-sources',
      'anysearch,exa',
      '--format=json',
    ]);
    assert.equal(
      result.exit,
      { empty: 0, 'any-failure': 6, 'all-extras': 6, 'model-failure': 3, fallback: 0 }[mode],
      result.channels.out,
    );
    const sources = result.json().data.extra_sources;
    if (mode === 'empty') assert.deepEqual(sources[0].data.results, []);
    if (mode === 'all-extras') assert.equal(sources, undefined);
    if (mode === 'any-failure')
      assert.deepEqual(
        sources.map((s: JsonObject) => s.provider),
        ['exa'],
      );
    if (mode === 'model-failure') {
      assert.equal(result.json().data.answer, undefined);
      assert.equal(sources[0].provider, 'anysearch');
    }
    if (mode === 'fallback') {
      assert.equal(f.calls.filter((c) => c.path === '/model/responses').length, 2);
      assert.equal(f.calls.filter((c) => c.path === '/gateway/v1/search').length, 1);
    }
  }
  const before = f.calls.length;
  for (const override of [
    { UNISEARCH_ANYSEARCH_API_KEY: '' },
    { UNISEARCH_ANYSEARCH_BASE_URL: 'bad' },
  ]) {
    const result = await f.run(['search', 'q', '--extra-sources', 'anysearch,exa'], override);
    assert.equal(result.exit, 3);
  }
  assert.equal(f.calls.length, before);
});

test(
  'combined search cancellation and internal failures stop pending AnySearch work and preserve completed evidence',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    f.env.UNISEARCH_MODEL_API_KEY = 'fixture-model';
    f.env.UNISEARCH_EXA_API_KEY = 'fixture-exa';
    for (const mode of ['cancel', 'internal']) {
      const controller = new AbortController();
      let complete!: () => void;
      const evidence = new Promise<void>((done) => {
        complete = done;
      });
      let modelStarted!: () => void;
      const started = new Promise<void>((done) => {
        modelStarted = done;
      });
      f.handle((call, res) => {
        if (call.path === '/model/responses') {
          res.writeHead(200);
          res.write('{');
          modelStarted();
        } else res.end(JSON.stringify(payloads[call.path]));
      });
      const transport: typeof fetch = async (url, init) => {
        if (String(url).includes('/exa/')) {
          await evidence;
          await started;
          // Let the completed AnySearch operation settle before terminating the group.
          await new Promise<void>((done) => setImmediate(done));
          if (mode === 'internal') throw new Error('fixture bug');
          controller.abort();
          return fetch(url, init);
        }
        const response = await fetch(url, init);
        if (String(url).includes('/gateway/')) {
          const read = response.arrayBuffer.bind(response);
          response.arrayBuffer = async () => {
            const value = await read();
            complete();
            return value;
          };
        }
        return response;
      };
      const result = await combinedSearch(
        prepareCombinedSearch('q', { extraSources: 'anysearch,exa' }, {}, f.env, 'en'),
        controller.signal,
        'en',
        {},
        { transport },
      );
      assert.equal(result.exitCode, mode === 'cancel' ? 130 : 5);
      assert.equal(result.result.data?.extra_sources?.[0].provider, 'anysearch');
      assert.equal(result.result.data?.answer, undefined);
    }
  },
);
