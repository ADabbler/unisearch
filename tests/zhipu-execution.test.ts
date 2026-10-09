import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as zhipu from '../src/providers/zhipu.js';
import { executeRequest } from '../src/execution.js';
import { redactSecrets } from '../src/providers/transport.js';
import type { JsonObject } from '../src/result.js';
import { fixture, reader, search, timer, url } from './zhipu-fixture.js';

test('Zhipu explicit business codes override HTTP status and never use message keyword classification', async (t) => {
  const f = await fixture(t);
  const request = zhipu.prepare('search', 'q', {}, {}, f.env, 'en');
  for (const [business, code, exit, retry] of [
    ['1000', 'AUTHENTICATION_ERROR', 3, false],
    ['1001', 'AUTHENTICATION_ERROR', 3, false],
    ['1113', 'QUOTA_EXCEEDED', 4, false],
    ['1321', 'QUOTA_EXCEEDED', 4, false],
    ['1210', 'INVALID_ARGUMENT', 2, false],
    ['1261', 'INVALID_ARGUMENT', 2, false],
    ['1220', 'ACCESS_DENIED', 3, false],
    ['1315', 'ACCESS_DENIED', 3, false],
    ['1221', 'UPSTREAM_ERROR', 4, false],
    ['1301', 'UPSTREAM_ERROR', 4, false],
    ['1302', 'RATE_LIMITED', 4, true],
    ['1305', 'RATE_LIMITED', 4, true],
    ['1200', 'UPSTREAM_ERROR', 4, true],
    ['1234', 'UPSTREAM_ERROR', 4, true],
    ['1701', 'RATE_LIMITED', 4, true],
    ['1702', 'UPSTREAM_ERROR', 4, false],
    ['1703', 'UPSTREAM_ERROR', 4, false],
    ['unknown', 'UPSTREAM_ERROR', 4, false],
  ] as const) {
    const status = business === 'unknown' ? 200 : 503;
    f.reply(
      {
        error: { code: business, message: 'rate limit quota token not found empty result' },
        ...search,
      },
      status,
    );
    const result = await zhipu.request(request, { signal: new AbortController().signal }, 'en');
    assert.equal(result.outcome.result.error?.code, code, business);
    assert.equal(result.outcome.exitCode, exit, business);
    assert.equal(result.retry, retry, business);
    assert.equal(result.outcome.result.data, undefined);
    assert.equal(result.outcome.result.error?.details?.upstream_code, business);
  }
  for (const platform of ['bigmodel', 'zai'])
    for (const op of ['search', 'fetch'] as const) {
      f.reply({ error: { code: '1701', message: 'fixture' } });
      const req = zhipu.prepare(
        op,
        op === 'search' ? 'q' : url,
        {},
        {},
        { ...f.env, UNISEARCH_ZHIPU_PLATFORM: platform },
        'en',
      );
      const result = await zhipu.request(req, { signal: new AbortController().signal }, 'en');
      assert.equal(result.retry, platform === 'bigmodel' && op === 'search');
    }
});

test('Zhipu supports both documented international error shapes, rejects malformed errors and classifies HTTP failures', async (t) => {
  const f = await fixture(t);
  for (const body of [
    { code: 1113, message: 'quota' },
    { error: { code: '1113', message: 'quota' } },
  ]) {
    f.reply(body);
    const result = await f.run(['zhipu', 'fetch', url, '--format=json'], {
      UNISEARCH_ZHIPU_PLATFORM: 'zai',
    });
    assert.equal(result.json().error.code, 'QUOTA_EXCEEDED');
    assert.equal(result.json().error.details.upstream_code, '1113');
  }
  for (const body of [
    { error: null, ...reader },
    { error: { code: 1113, message: 'quota' }, ...reader },
    { error: {}, code: 1113, message: 'quota', ...reader },
    { code: '1113', message: 'quota', ...reader },
  ]) {
    f.reply(body);
    const result = await f.run(['zhipu', 'fetch', url, '--format=json'], {
      UNISEARCH_ZHIPU_PLATFORM: 'zai',
    });
    assert.equal(result.json().error.code, 'INVALID_RESPONSE');
    assert.equal(result.json().data, undefined);
  }
  const request = zhipu.prepare('fetch', url, {}, {}, f.env, 'en');
  for (const [status, code, retry] of [
    [400, 'INVALID_ARGUMENT', false],
    [401, 'AUTHENTICATION_ERROR', false],
    [403, 'ACCESS_DENIED', false],
    [408, 'TIMEOUT', true],
    [504, 'TIMEOUT', true],
    [429, 'RATE_LIMITED', true],
    [500, 'UPSTREAM_ERROR', true],
    [502, 'UPSTREAM_ERROR', true],
    [503, 'UPSTREAM_ERROR', true],
    [404, 'UPSTREAM_ERROR', false],
    [501, 'UPSTREAM_ERROR', false],
    [302, 'UPSTREAM_ERROR', false],
  ] as const) {
    f.reply({}, status, { location: `${f.base}/must-not-follow` });
    const before = f.calls.length;
    const result = await zhipu.request(request, { signal: new AbortController().signal }, 'en');
    assert.equal(result.outcome.result.error?.code, code, String(status));
    assert.equal(result.outcome.result.error?.details?.reason, 'error_body_invalid');
    assert.equal(result.retry, retry);
    assert.equal(f.calls.length, before + 1);
  }
});

test('Zhipu validates JSON and UTF-8 without exposing invalid raw error bodies', async (t) => {
  const f = await fixture(t);
  for (const status of [200, 503])
    for (const bytes of [
      Buffer.from('{secret-raw'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('[1]'),
    ]) {
      f.handle((_call, res) => {
        res.writeHead(status);
        res.end(bytes);
      });
      const result = await f.run(['zhipu', 'fetch', url, '--format=json']);
      assert.equal(
        result.json().error.code,
        status === 200 ? 'INVALID_RESPONSE' : 'UPSTREAM_ERROR',
      );
      assert.doesNotMatch(result.channels.out + result.channels.err, /secret-raw/);
    }
});

test('Zhipu Reader retains independent valid metadata and attributes when a JSON number overflows', async (t) => {
  const f = await fixture(t);
  f.handle((_call, res) =>
    res.end(
      `{"reader_result":{"url":"https://example.org","content":"body","metadata":{"bad":1e999,"good":false,"nested":{"value":null}},"external":{"alternate":{"https://example.org/pdf":{"bad":1e999,"good":0}}}}}`,
    ),
  );
  const result = await f.run(['zhipu', 'fetch', url, '--format=json']);
  assert.equal(result.exit, 4);
  assert.deepEqual(result.json().data.results[0].metadata, {
    good: false,
    nested: { value: null },
  });
  assert.deepEqual(result.json().data.results[0].external.alternate['https://example.org/pdf'], {
    good: 0,
  });
});

test('Zhipu request IDs prefer supplier body IDs and distinct response IDs appear only in diagnostics', async (t) => {
  const f = await fixture(t);
  for (const failed of [false, true])
    for (const id of ['body-id', 'task-id']) {
      const body = failed ? { error: { code: '1113', message: 'quota' } } : reader;
      f.reply({ ...body, request_id: 'body-id', id, model: 'processing-model' }, 200, {
        'x-request-id': 'header-id',
      });
      const result = (await f.run(['zhipu', 'fetch', url, '--format=json', '--verbose'])).json();
      const details = failed ? result.error.details : result.meta.attempts[0];
      assert.equal(details.request_id, 'body-id');
      assert.equal(details.response_id, id === 'body-id' ? undefined : id);
      assert.equal(result.meta.attempts[0].model, 'processing-model');
      assert.equal(result.data?.model, undefined);
      if (failed) {
        assert.equal(result.meta.attempts[0].request_id, undefined);
        assert.equal(result.meta.attempts[0].response_id, undefined);
      }
      assert.doesNotMatch(JSON.stringify(result), /header-id/);
    }
  f.reply({ reader_result: reader.reader_result }, 200, { 'x-request-id': 'header-only' });
  assert.equal(
    (await f.run(['zhipu', 'fetch', url, '--format=json', '--verbose'])).json().meta.attempts[0]
      .request_id,
    'header-only',
  );
});

test('Zhipu precisely masks known credentials in upstream keys and values while retaining normal authentication examples', async (t) => {
  const f = await fixture(t);
  f.save({
    providers: { zhipu: { api_key: 'old-fixture-key' }, exa: { api_key: 'peer-fixture-key' } },
  });
  const example = 'Authorization: Bearer example-token\n\nconst token = "sample";';
  const content = `${example}\nfixture-zhipu-key old-fixture-key peer-fixture-key`;
  const upstream = {
    ...reader,
    reader_result: {
      ...reader.reader_result,
      content,
      metadata: {
        'fixture-zhipu-key': {
          code: 'old-fixture-key',
          provider: 'peer-fixture-key',
          safe: example,
        },
        collision: { '[REDACTED]': false },
      },
      external: {
        'peer-fixture-key': {
          'https://example.org/old-fixture-key': { token: 'fixture-zhipu-key' },
        },
      },
    },
  };
  f.reply(upstream);
  for (const format of ['json', 'markdown']) {
    const result = await f.run(['zhipu', 'fetch', url, '--format', format, '--verbose']);
    assert.equal(result.exit, 0);
    assert.doesNotMatch(
      result.channels.out + result.channels.err,
      /fixture-zhipu-key|old-fixture-key|peer-fixture-key/,
    );
    if (format === 'json') {
      const data = result.json().data;
      assert.equal(data.provider, 'zhipu');
      assert.equal(data.results[0].metadata['[REDACTED]'].provider, '[REDACTED]');
      assert.equal(data.results[0].metadata['[REDACTED]'].code, '[REDACTED]');
      assert.match(data.results[0].text, /Authorization: Bearer example-token/);
    } else assert.ok(result.channels.out.includes(example));
  }
  f.reply({
    error: { code: '1113', message: 'fixture-zhipu-key Authorization: Bearer unknown-token' },
    request_id: 'old-fixture-key',
    id: 'peer-fixture-key',
  });
  const failure = await f.run(['zhipu', 'search', 'q', '--format=json', '--verbose']);
  assert.doesNotMatch(
    failure.channels.out,
    /fixture-zhipu-key|old-fixture-key|peer-fixture-key|unknown-token/,
  );
  assert.equal(failure.json().error.code, 'QUOTA_EXCEEDED');
});

test('exact credential masking retains colliding dictionary entries and reserves unchanged names', () => {
  const entries: [string, JsonObject | number | boolean | null][] = [
    ['fixture-first-key', { first: true }],
    ['fixture-second-key', { second: true }],
    ['[REDACTED]', null],
    ['[REDACTED]#2', false],
    ['fixture-first-key#3', 0],
  ];
  for (const input of [entries, [...entries].reverse()]) {
    const result = redactSecrets(Object.fromEntries(input), [
      'fixture-first-key',
      'fixture-second-key',
    ]);
    assert.equal(Object.keys(result).length, entries.length);
    assert.equal(result['[REDACTED]'], null);
    assert.equal(result['[REDACTED]#2'], false);
    assert.equal(result['[REDACTED]#3'], 0);
    assert.deepEqual(new Set(Object.values(result)), new Set(entries.map(([, value]) => value)));
    assert.doesNotMatch(JSON.stringify(result), /fixture-first-key|fixture-second-key/);
  }
  assert.deepEqual(
    redactSecrets(
      [
        { 'fixture-first-key': false, 'fixture-second-key': null },
        { 'prefix-fixture-first-key': 0, 'prefix-fixture-second-key': [] },
      ],
      ['fixture-first-key', 'fixture-second-key'],
    ),
    [
      { '[REDACTED]': false, '[REDACTED]#2': null },
      { 'prefix-[REDACTED]': 0, 'prefix-[REDACTED]#2': [] },
    ],
  );
});

test('Zhipu Reader keeps colliding metadata and external relationship keys in JSON and Markdown', async (t) => {
  const f = await fixture(t);
  f.save({ providers: { exa: { api_key: 'peer-fixture-key' } } });
  const firstUrl = 'https://example.org/fixture-zhipu-key';
  const secondUrl = 'https://example.org/peer-fixture-key';
  f.reply({
    reader_result: {
      ...reader.reader_result,
      metadata: { 'fixture-zhipu-key': 'first value', 'peer-fixture-key': 'second value' },
      external: {
        'fixture-zhipu-key': {
          [firstUrl]: { title: 'first link' },
          [secondUrl]: { title: 'second link' },
        },
        'peer-fixture-key': { [firstUrl]: { title: 'third link' } },
      },
    },
  });
  for (const format of ['json', 'markdown']) {
    const result = await f.run(['zhipu', 'fetch', url, '--format', format]);
    assert.equal(result.exit, 0);
    assert.doesNotMatch(result.channels.out, /fixture-zhipu-key|peer-fixture-key/);
    for (const value of ['first value', 'second value', 'first link', 'second link', 'third link'])
      assert.ok(result.channels.out.includes(value));
    if (format === 'json') {
      const page = result.json().data.results[0];
      assert.deepEqual(page.metadata, {
        '[REDACTED]': 'first value',
        '[REDACTED]#2': 'second value',
      });
      assert.deepEqual(Object.keys(page.external), ['[REDACTED]', '[REDACTED]#2']);
      assert.deepEqual(Object.keys(page.external['[REDACTED]']), [
        'https://example.org/[REDACTED]',
        'https://example.org/[REDACTED]#2',
      ]);
    }
  }
});

test('Zhipu redacts credential values and upstream keys without renaming public result fields', async (t) => {
  const f = await fixture(t);
  for (const secret of [
    'results',
    'search_engine',
    'search_intent',
    'intent',
    'keywords',
    'url',
    'title',
    'text',
    'metadata',
  ]) {
    f.save({ providers: { exa: { api_key: secret } }, fetch: { providers: ['zhipu'] } });
    f.handle((call, res) =>
      res.end(
        JSON.stringify(
          call.path.endsWith('/web_search')
            ? {
                search_result: [{ link: url, title: 'Guide', content: `Summary ${secret}` }],
                search_intent: [{ intent: `intent ${secret}`, keywords: `keywords ${secret}` }],
              }
            : {
                reader_result: {
                  url,
                  title: 'Guide',
                  content: `Body ${secret}`,
                  metadata: { [secret]: { code: secret, provider: secret } },
                },
              },
        ),
      ),
    );
    for (const format of ['json', 'markdown']) {
      const searched = await f.run(['zhipu', 'search', 'q', '--format', format]);
      const fetched = await f.run(['fetch', url, '--format', format]);
      assert.equal(searched.exit, 0, searched.channels.out);
      assert.equal(fetched.exit, 0, fetched.channels.out);
      if (format === 'json') {
        const data = searched.json().data;
        assert.deepEqual(Object.keys(data).sort(), [
          'provider',
          'results',
          'search_engine',
          'search_intent',
        ]);
        assert.equal(data.results[0].description, 'Summary [REDACTED]');
        assert.equal(typeof data.search_intent[0].intent, 'string');
        assert.equal(typeof data.search_intent[0].keywords, 'string');
        assert.equal(data.search_intent[0].intent.includes(secret), false);
        const page = fetched.json().data.results[0];
        assert.equal(page.url, url);
        assert.equal(page.title, 'Guide');
        assert.equal(page.text, 'Body [REDACTED]');
        assert.deepEqual(page.metadata, {
          '[REDACTED]': { code: '[REDACTED]', provider: '[REDACTED]' },
        });
      } else {
        assert.match(searched.channels.out, /Summary \[REDACTED\]/);
        assert.match(fetched.channels.out, /Body \[REDACTED\]/);
      }
    }
  }
});

test('Zhipu retries retain request bodies and share controlled Retry-After, backoff, cancellation and total budgets', async (t) => {
  const f = await fixture(t);
  for (const mode of [
    'retry-after',
    'invalid',
    'budget',
    'disabled',
    'backoff',
    'cancel',
  ] as const) {
    const time = timer();
    let count = 0;
    const abort = new AbortController();
    f.handle((_call, res) => {
      count++;
      time.advance(200);
      if (count > (mode === 'backoff' ? 2 : 1)) res.end(JSON.stringify(reader));
      else {
        let retryAfter = '1';
        if (mode === 'budget') retryAfter = '3';
        else if (mode === 'invalid') retryAfter = 'bad';
        res.writeHead(503, mode === 'backoff' ? {} : { 'retry-after': retryAfter });
        res.end(
          JSON.stringify({
            error: { code: '1200', message: 'busy' },
            request_id: `failed-${count}`,
          }),
        );
      }
    });
    const request = zhipu.prepare('fetch', url, {}, {}, f.env, 'en');
    const record: JsonObject = {};
    const before = f.calls.length;
    const result = await executeRequest((ctx) => zhipu.request(request, ctx, 'en'), {
      provider: 'zhipu',
      timeout: mode === 'backoff' ? 100 : 3,
      retries: mode === 'disabled' ? 0 : 2,
      requestLimit: 60,
      signal: abort.signal,
      language: 'en',
      record,
      clock: {
        ...time.clock,
        async sleep(ms, signal) {
          await time.clock.sleep(ms, signal);
          if (mode === 'cancel') abort.abort();
        },
      },
    });
    assert.equal(
      result.exitCode,
      { 'retry-after': 0, invalid: 0, budget: 4, disabled: 4, backoff: 0, cancel: 130 }[mode],
    );
    assert.deepEqual(
      time.waits,
      {
        'retry-after': [1000],
        invalid: [1000],
        budget: [],
        disabled: [],
        backoff: [1000, 2000],
        cancel: [1000],
      }[mode],
    );
    assert.equal(time.cleared(), count);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    for (const call of f.calls.slice(before))
      assert.deepEqual(call.body, { url, return_format: 'markdown', timeout: 20 });
    if (mode === 'budget')
      assert.equal(result.result.error?.details?.reason, 'retry_wait_exceeds_budget');
    if (mode === 'invalid')
      assert.equal((record.attempts as JsonObject[])[0].retry_after_invalid, true);
    if (result.exitCode === 0)
      assert.equal((record.attempts as JsonObject[])[0].request_id, 'failed-1');
  }
});

test('Zhipu controlled request deadlines abort native bodies and never retry a known permanent HTTP refusal', async (t) => {
  const f = await fixture(t);
  for (const op of ['search', 'fetch'] as const)
    for (const status of [200, 401])
      for (const total of [2, 300]) {
        const time = timer();
        let expire!: () => void;
        let count = 0;
        f.handle((_call, res) => {
          count++;
          res.writeHead(status);
          if (count === 1 || status === 401) res.write('{');
          else res.end(JSON.stringify(op === 'search' ? search : reader));
        });
        const request = zhipu.prepare(op, op === 'search' ? 'q' : url, {}, {}, f.env, 'en');
        const record: JsonObject = {};
        const result = await executeRequest(
          (ctx) =>
            zhipu.request(request, ctx, 'en', async (...args) => {
              const response = await fetch(...args);
              if (count === 1) {
                const read = response.arrayBuffer.bind(response);
                response.arrayBuffer = () => {
                  const pending = read();
                  expire();
                  return pending;
                };
              }
              return response;
            }),
          {
            provider: 'zhipu',
            timeout: total,
            retries: 1,
            requestLimit: zhipu.requestLimits[op],
            signal: new AbortController().signal,
            language: 'en',
            record,
            clock: {
              ...time.clock,
              schedule(ms, cb) {
                assert.equal(ms, Math.min(zhipu.requestLimits[op] * 1000, total * 1000));
                expire = () => {
                  time.advance(ms);
                  cb();
                };
                return () => {};
              },
            },
          },
        );
        const retried = status === 200 && total === 300;
        assert.equal(count, retried ? 2 : 1);
        assert.equal(result.exitCode, retried ? 0 : 4);
        if (!retried)
          assert.equal(
            result.result.error?.details?.timeout_scope,
            total === 2 ? 'total' : 'request',
          );
      }
});

test('Zhipu transport faults distinguish transient, permanent and programming failures', async (t) => {
  const f = await fixture(t);
  const request = zhipu.prepare('search', 'q', {}, {}, f.env, 'en');
  for (const [system, code, retry] of [
    ['ECONNRESET', 'NETWORK_ERROR', true],
    ['ENOTFOUND', 'NETWORK_ERROR', false],
    ['CERT_HAS_EXPIRED', 'NETWORK_ERROR', false],
    ['ETIMEDOUT', 'TIMEOUT', true],
    [undefined, 'INTERNAL_ERROR', false],
  ] as const) {
    const result = await zhipu.request(
      request,
      { signal: new AbortController().signal },
      'en',
      async () => {
        if (!system) throw new Error('programming bug');
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('fixture'), { code: system }),
        });
      },
    );
    assert.equal(result.outcome.result.error?.code, code);
    assert.equal(result.retry, retry);
  }
});

test('Zhipu permanent transport failures do not retry when they reach the request deadline', async (t) => {
  const f = await fixture(t);
  for (const operation of ['search', 'fetch'] as const) {
    const time = timer();
    const request = zhipu.prepare(
      operation,
      operation === 'search' ? 'q' : url,
      {},
      {},
      f.env,
      'en',
    );
    let calls = 0;
    const result = await executeRequest(
      (context) =>
        zhipu.request(request, context, 'en', async () => {
          calls++;
          time.advance(zhipu.requestLimits[operation] * 1000);
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('fixture DNS failure'), { code: 'ENOTFOUND' }),
          });
        }),
      {
        provider: 'zhipu',
        timeout: 300,
        retries: 1,
        requestLimit: zhipu.requestLimits[operation],
        signal: new AbortController().signal,
        language: 'en',
        record: {},
        clock: time.clock,
      },
    );
    assert.equal(result.exitCode, 4);
    assert.equal(calls, 1);
    assert.deepEqual(time.waits, []);
  }
});

test(
  'Zhipu SIGINT during headers or body consumption preserves old files and cleans listeners',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const output = join(f.root, 'saved.json');
    writeFileSync(output, 'original');
    for (const op of ['search', 'fetch'])
      for (const phase of ['headers', 'body']) {
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
          started = resolve;
        });
        f.handle((_call, res) => {
          if (phase === 'body') {
            res.writeHead(200);
            res.write('{');
          }
          started();
        });
        const before = process.listenerCount('SIGINT');
        const pending = f.run([
          'zhipu',
          op,
          op === 'search' ? 'q' : url,
          '--format=json',
          '--output',
          output,
        ]);
        await ready;
        process.emit('SIGINT');
        const result = await pending;
        assert.equal(result.exit, 130);
        assert.equal(readFileSync(output, 'utf8'), 'original');
        assert.equal(process.listenerCount('SIGINT'), before);
        assert.deepEqual(readdirSync(f.root).sort(), ['config.json', 'saved.json']);
      }
  },
);
