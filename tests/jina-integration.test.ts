import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as jina from '../src/providers/jina.js';
import { executeRequest } from '../src/execution.js';
import type { ExecutionClock } from '../src/execution.js';
import { prepareRetrieval, retrieve } from '../src/retrieval.js';
import type { JsonObject } from '../src/result.js';
import { envelope, fixture, page, url } from './jina-helpers.js';

const key = { UNISEARCH_JINA_API_KEY: 'fixture-jina-key' };
const answer = {
  model: 'actual',
  status: 'completed',
  output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer.' }] },
  ],
};

function timer() {
  let now = 0;
  const caps: number[] = [];
  const waits: number[] = [];
  let cleared = 0;
  const clock: ExecutionClock = {
    now: () => now,
    wallNow: () => 0,
    schedule(ms) {
      caps.push(ms);
      return () => {
        cleared++;
      };
    },
    async sleep(ms, signal) {
      signal.throwIfAborted();
      waits.push(ms);
      now += ms;
    },
  };
  return {
    clock,
    caps,
    waits,
    advance(ms: number) {
      now += ms;
    },
    cleared: () => cleared,
  };
}

test('Jina retries local 429/503 responses with unchanged requests and per-attempt billing', async (t) => {
  const f = await fixture(t);
  for (const http of [429, 503]) {
    const time = timer();
    let count = 0;
    f.handle((_call, res) => {
      count++;
      if (count === 1) {
        res.writeHead(http, { 'retry-after': '2' });
        res.end(
          JSON.stringify({ code: http, status: http * 100 + 3, meta: { usage: { tokens: 11 } } }),
        );
      } else res.end(JSON.stringify(envelope(page, 22)));
    });
    const request = jina.prepareFetch(
      url,
      {},
      {},
      { ...f.env, ...key, UNISEARCH_RETRIES: '1' },
      'en',
    );
    const record: JsonObject = {};
    const result = await executeRequest((ctx) => jina.request(request, ctx, 'en'), {
      ...request,
      provider: 'jina',
      requestLimit: jina.requestLimit,
      signal: new AbortController().signal,
      language: 'en',
      clock: time.clock,
      record,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(time.waits, [2000]);
    assert.deepEqual(time.caps, [60000, 60000]);
    assert.equal(time.cleared(), 2);
    assert.deepEqual(
      (record.attempts as JsonObject[]).map((item) => item.billed_tokens),
      [11, 22],
    );
    assert.deepEqual(f.calls.at(-1)?.body, f.calls.at(-2)?.body);
    assert.equal(f.calls.at(-1)?.headers.authorization, f.calls.at(-2)?.headers.authorization);
  }
});

test('Jina controlled deadlines include complete response bodies and never retry terminal results', async (t) => {
  const f = await fixture(t);
  for (const [budget, spent, expectedScope, body] of [
    [100, 60001, 'request', envelope({ url })],
    [2, 2001, 'total', {}],
  ] as const) {
    const time = timer();
    f.reply(body);
    const request = jina.prepareFetch(url, { timeout: budget }, {}, f.env, 'en');
    const record: JsonObject = {};
    const before = f.calls.length;
    const result = await executeRequest(
      async (ctx) => {
        const value = await jina.request(request, ctx, 'en');
        time.advance(spent);
        return value;
      },
      {
        ...request,
        retries: 2,
        provider: 'jina',
        requestLimit: jina.requestLimit,
        signal: new AbortController().signal,
        language: 'en',
        clock: time.clock,
        record,
      },
    );
    assert.equal(result.result.error?.details?.timeout_scope, expectedScope);
    assert.deepEqual(time.caps, [Math.min(60000, budget * 1000)]);
    assert.equal(f.calls.length, before + 1);
  }
});

test('Jina aborts an incomplete response at its request cap without recording billing', async (t) => {
  const f = await fixture(t);
  let expire!: () => void;
  f.handle((_call, res) => {
    res.writeHead(200);
    res.write('{');
  });
  const request = jina.prepareFetch(url, {}, {}, f.env, 'en');
  const time = timer();
  const record: JsonObject = {};
  const transport: typeof fetch = async (...args) => {
    const response = await fetch(...args);
    const readBody = response.arrayBuffer.bind(response);
    response.arrayBuffer = () => {
      const pending = readBody();
      expire();
      return pending;
    };
    return response;
  };
  const result = await executeRequest((ctx) => jina.request(request, ctx, 'en', transport), {
    ...request,
    provider: 'jina',
    requestLimit: jina.requestLimit,
    signal: new AbortController().signal,
    language: 'en',
    record,
    clock: {
      ...time.clock,
      schedule(ms, callback) {
        assert.equal(ms, 60000);
        expire = () => {
          time.advance(ms);
          callback();
        };
        return () => {};
      },
    },
  });
  assert.equal(result.result.error?.details?.timeout_scope, 'request');
  assert.equal((record.attempts as JsonObject[])[0].http_status, 200);
  assert.equal((record.attempts as JsonObject[])[0].billed_tokens, undefined);
});

test('Jina usage is validated independently of verbose and belongs only to complete attempts', async (t) => {
  const f = await fixture(t);
  for (const tokens of [undefined, null, 0, 123, -1, 1.5, '12', Number.MAX_SAFE_INTEGER + 1]) {
    f.reply(envelope(page, tokens));
    const ordinary = await f.run(['jina', 'fetch', url, '--format=json']);
    const verbose = await f.run(['jina', 'fetch', url, '--format=json', '--verbose']);
    const valid =
      tokens == null || (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0);
    assert.equal(ordinary.exit, valid ? 0 : 4);
    assert.equal(verbose.exit, ordinary.exit);
    assert.deepEqual(ordinary.json().data, verbose.json().data);
    assert.equal(ordinary.json().data.results[0].text, page.content);
    assert.equal(ordinary.json().meta, undefined);
    assert.equal(
      verbose.json().meta.attempts[0].billed_tokens,
      valid && tokens != null ? tokens : undefined,
    );
  }
  f.reply({ ...envelope([page]), data: [{ ...page, usage: { tokens: 9999 } }] });
  const search = await f.run(['jina', 'search', 'q', '--verbose', '--format=json'], key);
  assert.equal(search.json().meta.attempts[0].billed_tokens, undefined);
  for (const [command, data] of [
    [['jina', 'fetch', url], []],
    [['jina', 'search', 'q'], {}],
  ] as const) {
    for (const tokens of [0, 23]) {
      f.reply(envelope(data, tokens));
      const before = f.calls.length;
      const result = await f.run([...command, '--verbose', '--format=json'], {
        ...key,
        UNISEARCH_RETRIES: '2',
      });
      assert.equal(result.exit, 4);
      assert.equal(result.json().error.code, 'INVALID_RESPONSE');
      assert.equal(result.json().data, undefined);
      assert.equal(result.json().meta.attempts[0].billed_tokens, tokens);
      assert.equal(f.calls.length, before + 1);
    }
  }
});

test('Jina output and files preserve partial data, diagnostic redaction and ordinary Markdown under verbose', async (t) => {
  const f = await fixture(t);
  f.save({ providers: { jina: { api_key: 'old-secret' }, exa: { api_key: 'peer-secret' } } });
  const secretText = 'old-secret peer-secret fixture-jina-key';
  f.reply(
    envelope(
      { ...page, content: secretText, warning: `${secretText}\nAuthorization: Bearer hidden` },
      99,
    ),
    200,
    { 'x-request-id': secretText },
  );
  const json = await f.run(['jina', 'fetch', url, '--format=json', '--verbose'], key);
  assert.equal(json.json().data.results[0].text, secretText);
  assert.doesNotMatch(
    JSON.stringify(json.json().data.results[0].warnings),
    /old-secret|peer-secret|fixture-jina-key|hidden/,
  );
  assert.doesNotMatch(JSON.stringify(json.json().meta), /old-secret|peer-secret|fixture-jina-key/);
  const file = join(f.root, 'page.md');
  const normal = await f.run(['jina', 'fetch', url], key);
  const saved = await f.run(['jina', 'fetch', url, '--verbose', '--output', file], key);
  assert.equal(saved.channels.out, '');
  assert.equal(readFileSync(file, 'utf8'), normal.channels.out);
  assert.match(saved.channels.err, /\b99\b/);
  f.reply(envelope([{ url, title: 'No body' }]));
  const partial = await f.run(
    ['jina', 'search', 'q', '--include-text', '--format=json', '--output', file],
    key,
  );
  assert.equal(partial.exit, 6);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'partial');
  const before = readFileSync(file, 'utf8');
  f.reply({ code: 401, status: 40102, message: secretText }, 401);
  const error = await f.run(['jina', 'fetch', url, '--format=json', '--output', file], key);
  assert.equal(error.exit, 3);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.doesNotMatch(
    error.channels.out + error.channels.err,
    /old-secret|peer-secret|fixture-jina-key/,
  );
  const calls = f.calls.length;
  assert.equal(
    (await f.run(['jina', 'fetch', url, '--output', join(f.root, 'missing', 'out')])).exit,
    5,
  );
  assert.equal(f.calls.length, calls);
});

test('Jina switches in both directions, aggregates errors and retains the latest body over later metadata', async (t) => {
  const f = await fixture(t);
  const env = { UNISEARCH_EXA_API_KEY: 'fixture-exa-key', UNISEARCH_EXA_BASE_URL: `${f.base}/exa` };
  for (const order of [
    ['jina', 'exa'],
    ['exa', 'jina'],
  ]) {
    f.save({ fetch: { providers: order } });
    f.handle((call, res) => {
      const provider = call.path.startsWith('/exa') ? 'exa' : 'jina';
      if (provider === order[0]) {
        res.writeHead(401);
        res.end(JSON.stringify({ code: 401, status: 40102 }));
      } else
        res.end(
          JSON.stringify(
            provider === 'exa'
              ? { results: [{ url, title: 'Exa', text: 'Exa body' }] }
              : envelope(page, 10),
          ),
        );
    });
    const result = await f.run(['fetch', url, '--format=json', '--verbose'], env);
    assert.equal(result.exit, 0);
    assert.equal(result.json().data.provider, order[1]);
    assert.deepEqual(
      result.json().meta.attempts.map((a: JsonObject) => a.provider),
      order,
    );
    assert.equal(result.json().meta.service_fallbacks[0].from, order[0]);
  }
  f.save({ fetch: { providers: ['exa', 'jina'] } });
  f.handle((call, res) =>
    res.end(
      JSON.stringify(
        call.path.startsWith('/exa')
          ? {
              results: [
                { url, text: 'Exa body' },
                { url, text: 'Other body' },
              ],
            }
          : envelope({ url, title: 'Later metadata' }, 5),
      ),
    ),
  );
  const bodyFirst = await f.run(['fetch', url, '--format=json', '--verbose'], env);
  assert.equal(bodyFirst.exit, 4);
  assert.equal(bodyFirst.json().data.provider, 'exa');
  assert.equal(bodyFirst.json().error.code, 'ALL_PROVIDERS_FAILED');
  assert.equal(bodyFirst.json().meta.attempts[1].billed_tokens, 5);
  f.save({ fetch: { providers: ['jina', 'exa'] } });
  f.handle((call, res) =>
    res.end(
      JSON.stringify(
        call.path.startsWith('/exa') ? { results: [] } : envelope({ url, title: 'Only metadata' }),
      ),
    ),
  );
  const metadata = await f.run(['fetch', url, '--format=json'], env);
  assert.equal(metadata.json().data.provider, 'jina');
  assert.equal(metadata.json().data.results[0].title, 'Only metadata');
  f.handle((call, res) =>
    res.end(
      JSON.stringify(
        call.path.startsWith('/exa')
          ? { results: [{ url, title: 'Exa', text: 'Success' }] }
          : envelope({ ...page, httpStatus: 403 }),
      ),
    ),
  );
  assert.equal((await f.run(['fetch', url, '--format=json'], env)).json().data.provider, 'exa');
});

test('Unified fetch shares remaining deadline with Jina and keeps its billed attempt when another provider succeeds', async (t) => {
  const f = await fixture(t);
  const env = {
    ...f.env,
    UNISEARCH_EXA_API_KEY: 'fixture-key',
    UNISEARCH_EXA_BASE_URL: `${f.base}/exa`,
  };
  for (const timeout of [10, 2]) {
    const time = timer();
    const plan = prepareRetrieval(
      'fetch',
      url,
      { timeout },
      { fetch: { providers: ['jina', 'exa'] } },
      env,
      'en',
    );
    f.handle((call, res) =>
      res.end(
        JSON.stringify(
          call.path.startsWith('/exa')
            ? { results: [{ url, title: 'Exa', text: 'Success' }] }
            : envelope({ url }, 7),
        ),
      ),
    );
    const record: JsonObject = {};
    const before = f.calls.length;
    const result = await retrieve(plan, new AbortController().signal, 'en', record, {
      clock: time.clock,
      transport: async (...args) => {
        const response = await fetch(...args);
        const bytes = await response.arrayBuffer();
        time.advance(2000);
        return new Response(bytes, { status: response.status, headers: response.headers });
      },
    });
    assert.equal(result.exitCode, timeout === 2 ? 4 : 0);
    assert.deepEqual(time.caps, timeout === 2 ? [2000] : [10000, 8000]);
    assert.equal(f.calls.length - before, timeout === 2 ? 1 : 2);
    assert.equal((record.attempts as JsonObject[])[0].billed_tokens, 7);
  }
});

test('Root search keeps Jina metadata and invalid data when model fails, with local preflight before any request', async (t) => {
  const f = await fixture(t);
  const env = {
    ...key,
    UNISEARCH_MODEL_API_KEY: 'model-fixture',
    UNISEARCH_MODEL_ID: 'primary',
    UNISEARCH_MODEL_BASE_URL: `${f.base}/model`,
  };
  for (const modelOk of [true, false])
    for (const entries of [[page], [{ url }], [{ ...page, title: 0 }]]) {
      f.handle((call, res) => {
        if (call.path.startsWith('/model')) {
          res.writeHead(modelOk ? 200 : 401);
          res.end(JSON.stringify(modelOk ? answer : { error: { message: 'No access' } }));
        } else res.end(JSON.stringify(envelope(entries)));
      });
      const result = await f.run(['search', 'q', '--sources', 'model,jina', '--format=json'], env);
      const invalid = 'title' in entries[0] && entries[0].title === 0;
      let expectedExit = 6;
      if (modelOk && !invalid) expectedExit = 0;
      else if (!modelOk && invalid) expectedExit = 4;
      assert.equal(result.exit, expectedExit);
      assert.equal(
        result
          .json()
          .data.sources.filter((source: { provider: string }) => source.provider !== 'model')[0]
          .data.results.length,
        1,
      );
      if (!modelOk) assert.equal(result.json().error.details.failures[0].provider, 'model');
    }
  const calls = f.calls.length;
  assert.equal(
    (
      await f.run(['search', 'q', '--sources', 'model,jina'], {
        ...env,
        UNISEARCH_JINA_API_KEY: undefined,
      })
    ).exit,
    3,
  );
  assert.equal(f.calls.length, calls);
});
