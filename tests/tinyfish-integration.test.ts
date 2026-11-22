import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeRequest } from '../src/execution.js';
import * as tinyfish from '../src/providers/tinyfish.js';
import { prepareRetrieval, retrieve } from '../src/retrieval.js';
import type { JsonObject } from '../src/result.js';
import { payloads } from './anysearch-fixture.js';
import { envelope as jinaEnvelope } from './jina-helpers.js';
import { fixture, fetched, error, page, search, url } from './tinyfish-fixture.js';
import { timer } from './zhipu-fixture.js';

test('TinyFish unified fetch preserves default relative order and supports both switch directions', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_EXA_API_KEY = 'exa-fixture-key';
  for (const order of [undefined, ['tinyfish', 'exa']] as const) {
    f.save(
      order
        ? { fetch: { providers: order } }
        : { providers: { jina: { enabled: false }, anysearch: { enabled: false } } },
    );
    f.calls.length = 0;
    f.handle((call, res) => {
      if (f.calls.length === 1) {
        res.writeHead(401);
        res.end(JSON.stringify(error()));
      } else
        res.end(JSON.stringify(call.path === '/tf-fetch/' ? fetched() : payloads['/exa/contents']));
    });
    const r = await f.run(['fetch', url, '--format=json', '--verbose']);
    assert.equal(r.exit, 0, r.channels.out);
    const expected = order ? ['tinyfish', 'exa'] : ['exa', 'tinyfish'];
    assert.deepEqual(
      r.json().meta.attempts.map((a: JsonObject) => a.provider),
      expected,
    );
    assert.equal(r.json().data.provider, expected[1]);
    assert.equal(r.json().meta.service_fallbacks[0].from, expected[0]);
    assert.equal(f.calls.length, 2);
  }
  delete f.env.UNISEARCH_EXA_API_KEY;
  f.save({ providers: { jina: { enabled: false } } });
  f.calls.length = 0;
  f.handle((call, res) =>
    res.end(JSON.stringify(call.path === '/tf-fetch/' ? fetched() : payloads[call.path])),
  );
  assert.equal((await f.run(['fetch', url, '--format=json'])).json().data.provider, 'tinyfish');
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ['/tf-fetch/'],
  );
});

test('TinyFish candidate preflight, disabled fallback and stop conditions do not leak requests', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_EXA_API_KEY = 'exa-fixture-key';
  f.save({
    fetch: { providers: ['tinyfish', 'exa'] },
  });
  assert.equal((await f.run(['fetch', url], { UNISEARCH_EXA_BASE_URL: 'bad' })).exit, 3);
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.run(['fetch', url, '--no-fallback'], { UNISEARCH_EXA_BASE_URL: 'bad' })).exit,
    0,
  );
  assert.equal(f.calls[0].body!.ttl, undefined);
  assert.equal(f.calls[0].body!.per_url_timeout_ms, undefined);
  for (const [tag, expected] of [
    ['invalid_url', 2],
    ['unknown_error', 4],
  ] as const) {
    f.reply({ results: [], errors: [{ url, error: tag }] });
    f.calls.length = 0;
    assert.equal((await f.run(['fetch', url])).exit, expected);
    assert.equal(f.calls.length, 1);
  }
  f.save({ fetch: { providers: [] } });
  f.calls.length = 0;
  assert.equal((await f.run(['fetch', url])).exit, 3);
  assert.equal(f.calls.length, 0);
  f.save({ fetch: { providers: ['tinyfish', 'exa'] } });
  f.reply(error(), 401);
  const both = await f.run(['fetch', url, '--format=json']);
  assert.equal(both.exit, 3);
  assert.equal(both.json().error.code, 'ALL_PROVIDERS_FAILED');
  assert.deepEqual(
    both.json().error.details.failures.map((e: JsonObject) => e.provider),
    ['tinyfish', 'exa'],
  );
});

test('TinyFish complete body survives later metadata-only failure, cancellation and internal errors', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_JINA_READER_URL = `${f.base}/reader`;
  const values = { fetch: { providers: ['tinyfish', 'jina'] } };
  f.save(values);
  f.handle((call, res) =>
    res.end(
      JSON.stringify(
        call.path === '/tf-fetch/'
          ? { results: [{ ...page(), title: false }], errors: [] }
          : jinaEnvelope({ url, title: 'Metadata only' }),
      ),
    ),
  );
  const r = await f.run(['fetch', url, '--format=json']);
  assert.equal(r.exit, 4);
  assert.equal(r.json().data.provider, 'tinyfish');
  assert.equal(r.json().data.results[0].text, page().text);
  for (const [mode, exitCode, provider] of [
    ['cancel', 130, 'tinyfish'],
    ['internal', 5, 'tinyfish'],
    ['success', 0, 'jina'],
  ] as const) {
    const abort = new AbortController();
    const record: JsonObject = {};
    const plan = prepareRetrieval('fetch', url, {}, values, f.env, 'en');
    f.handle((call, res) =>
      res.end(
        JSON.stringify(
          call.path === '/tf-fetch/'
            ? { results: [{ ...page(), title: false }], errors: [] }
            : jinaEnvelope({ url, content: 'Final text' }),
        ),
      ),
    );
    const outcome = await retrieve(plan, abort.signal, 'en', record, {
      transport: async (input, init) => {
        if (String(input).includes('/reader/')) {
          if (mode === 'internal') throw new Error('fixture internal error');
          if (mode === 'cancel') abort.abort();
        }
        return fetch(input, init);
      },
    });
    assert.equal(outcome.exitCode, exitCode);
    assert.equal(outcome.result.data!.provider, provider);
    if (mode !== 'success') {
      const data = outcome.result.data!;
      assert.ok('results' in data);
      assert.equal(data.results[0].text, page().text);
    }
  }
});

test('TinyFish and model search start concurrently with other explicit sources and preserve source order', async (t) => {
  const f = await fixture(t);
  Object.assign(f.env, {
    UNISEARCH_MODEL_API_KEY: 'model-fixture-key',
    UNISEARCH_EXA_API_KEY: 'exa-fixture-key',
  });
  const pending: { path: string; res: ServerResponse }[] = [];
  f.handle((call, res) => {
    pending.push({ path: call.path, res });
    if (pending.length === 3)
      for (const item of [...pending].reverse())
        item.res.end(JSON.stringify(item.path === '/tf-search/' ? search : payloads[item.path]));
  });
  const r = await f.run([
    'search',
    'query',
    '--sources',
    'model,tinyfish,exa',
    '--format=json',
    '--timeout',
    '2',
  ]);
  assert.equal(r.exit, 0, r.channels.out);
  assert.equal(pending.length, 3);
  assert.deepEqual(
    r
      .json()
      .data.sources.filter((source: { provider: string }) => source.provider !== 'model')
      .map((s: JsonObject) => s.provider),
    ['tinyfish', 'exa'],
  );
  assert.equal(
    r.json().data.sources.filter((source: { provider: string }) => source.provider !== 'model')[0]
      .data.provider,
    undefined,
  );
  assert.equal(
    r.json().data.sources.filter((source: { provider: string }) => source.provider !== 'model')[0]
      .data.page,
    0,
  );
  assert.equal(
    f.calls.find((c) => c.path === '/tf-search/')!.url.searchParams.get('query'),
    'query',
  );
  f.calls.length = 0;
  assert.equal(
    (
      await f.run(['search', 'q', '--sources', 'model,tinyfish'], {
        UNISEARCH_TINYFISH_API_KEY: '',
      })
    ).exit,
    3,
  );
  assert.equal(f.calls.length, 0);
  assert.equal((await f.run(['search', 'x'.repeat(2001), '--sources', 'model,tinyfish'])).exit, 2);
  assert.equal(f.calls.length, 0);
});

test('TinyFish fetch resends the same request after a retryable service response', async (t) => {
  const f = await fixture(t);
  const time = timer();
  f.handle((_call, res) => {
    if (f.calls.length === 1) {
      res.writeHead(503, { 'retry-after': '2' });
      res.end(JSON.stringify(error('SERVICE_BUSY')));
    } else res.end(JSON.stringify(fetched()));
  });
  const request = tinyfish.prepareFetch([url], {}, {}, f.env, 'en');
  const result = await executeRequest((context) => tinyfish.request(request, context, 'en'), {
    provider: 'tinyfish',
    timeout: 300,
    retries: 1,
    requestLimit: tinyfish.requestLimits.fetch,
    signal: new AbortController().signal,
    language: 'en',
    record: {},
    clock: time.clock,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(time.waits, [2000]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url.href, f.calls[0].url.href);
  assert.deepEqual(f.calls[1].body, f.calls[0].body);
});

test('TinyFish retains explicit non-retryable error codes when the error message is malformed', async (t) => {
  const f = await fixture(t);
  for (const [status, tag, message, code, exit] of [
    [429, 'DAILY_LIMIT_EXCEEDED', undefined, 'QUOTA_EXCEEDED', 4],
    [402, 'INSUFFICIENT_CREDITS', null, 'QUOTA_EXCEEDED', 4],
    [503, 'INVALID_API_KEY', false, 'AUTHENTICATION_ERROR', 3],
    [503, 'INVALID_INPUT', '', 'INVALID_ARGUMENT', 2],
    [503, 'UNAUTHORIZED', ' ', 'AUTHENTICATION_ERROR', 3],
  ] as const) {
    const time = timer();
    f.calls.length = 0;
    f.reply({ error: { code: tag, message } }, status);
    const request = tinyfish.prepareSearch('query', {}, {}, f.env, 'en');
    const result = await executeRequest((context) => tinyfish.request(request, context, 'en'), {
      provider: 'tinyfish',
      timeout: request.timeout,
      retries: 2,
      requestLimit: tinyfish.requestLimits.search,
      signal: new AbortController().signal,
      language: 'en',
      record: {},
      clock: time.clock,
    });
    assert.equal(result.exitCode, exit, tag);
    assert.equal(result.result.error!.code, code, tag);
    assert.equal(result.result.error!.details!.upstream_code, tag);
    assert.equal(result.result.error!.details!.http_status, status);
    assert.equal(result.result.error!.details!.reason, 'error_body_invalid');
    assert.equal(f.calls.length, 1, tag);
    assert.deepEqual(time.waits, []);
  }
});

test('TinyFish interrupted HTTP refusals retain their classification and cannot trigger service switching', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_EXA_API_KEY = 'fixture-exa';
  f.env.UNISEARCH_RETRIES = '2';
  for (const status of [400, 422, 404, 302]) {
    const time = timer();
    const requests: string[] = [];
    const record: JsonObject = {};
    const result = await retrieve(
      prepareRetrieval(
        'fetch',
        url,
        {},
        { fetch: { providers: ['tinyfish', 'exa'] } },
        f.env,
        'en',
      ),
      new AbortController().signal,
      'en',
      record,
      {
        clock: time.clock,
        transport: async (target) => {
          requests.push(String(target));
          if (String(target).includes('/tf-fetch/'))
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(
                    Object.assign(new Error('Body interrupted'), { code: 'ECONNRESET' }),
                  );
                },
              }),
              { status },
            );
          return Response.json(payloads['/exa/contents']);
        },
      },
    );
    assert.equal(result.exitCode, status === 400 || status === 422 ? 2 : 4);
    assert.deepEqual(requests, [`${f.base}/tf-fetch/`]);
    assert.deepEqual(time.waits, []);
    const failure = result.result.error;
    assert.equal(
      failure?.code,
      status === 400 || status === 422 ? 'INVALID_ARGUMENT' : 'UPSTREAM_ERROR',
    );
    assert.equal(failure?.details?.http_status, status);
    assert.equal(failure?.details?.reason, 'error_body_invalid');
  }
});

test('TinyFish shares the deadline with later providers, counts full bodies and skips waits outside budget', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_EXA_API_KEY = 'exa-fixture-key';
  const values = { fetch: { providers: ['tinyfish', 'exa'] } };
  for (const mode of ['wait', 'body', 'total'] as const) {
    const time = timer();
    f.calls.length = 0;
    f.handle((call, res) => {
      if (call.path === '/tf-fetch/') {
        if (mode === 'wait') {
          time.advance(1000);
          res.writeHead(429, { 'retry-after': '60' });
          res.end(JSON.stringify(error('RATE_LIMIT_EXCEEDED')));
        } else {
          res.writeHead(200);
          res.flushHeaders();
          res.write('{"results":');
          setImmediate(() => {
            time.advance(mode === 'total' ? 5001 : 1000);
            res.end('[],"errors":[{"url":' + JSON.stringify(url) + ',"error":"timeout"}]}');
          });
        }
      } else res.end(JSON.stringify(payloads['/exa/contents']));
    });
    const plan = prepareRetrieval(
      'fetch',
      url,
      { timeout: 5 },
      values,
      { ...f.env, UNISEARCH_RETRIES: '1' },
      'en',
    );
    const record: JsonObject = {};
    const r = await retrieve(plan, new AbortController().signal, 'en', record, {
      clock: time.clock,
    });
    assert.equal(r.exitCode, mode === 'total' ? 4 : 0);
    assert.deepEqual(time.waits, []);
    assert.equal(time.caps[0], 5000);
    if (mode === 'total') {
      assert.equal(f.calls.length, 1);
      assert.equal(r.result.error!.code, 'TIMEOUT');
      assert.equal(r.result.error!.details!.timeout_scope, 'total');
    } else {
      assert.equal(f.calls.length, 2);
      assert.equal(time.caps[1], 4000);
    }
  }
});

test('TinyFish error diagnostics redact all configured credentials, including overridden values', async (t) => {
  const f = await fixture(t);
  f.save({
    providers: { tinyfish: { api_key: 'old-tinyfish-key' }, exa: { api_key: 'other-exa-key' } },
  });
  const secrets = ['tinyfish-fixture-key', 'old-tinyfish-key', 'other-exa-key'];
  f.reply(error('INVALID_API_KEY', secrets.join(' ')), 401, { 'x-request-id': secrets.join('-') });
  for (const format of ['json', 'markdown']) {
    const r = await f.run(['tinyfish', 'fetch', url, '--format', format, '--verbose']);
    assert.equal(r.exit, 3);
    for (const secret of secrets) assert.ok(!(r.channels.out + r.channels.err).includes(secret));
    assert.ok((r.channels.out + r.channels.err).includes('[REDACTED]'));
  }
  f.reply({
    results: [{ ...page(), text: 'Business text: old-tinyfish-key', title: false }],
    errors: [],
    request_id: 'old-tinyfish-key',
  });
  const path = join(f.root, 'diagnostics.json');
  assert.equal(
    (await f.run(['tinyfish', 'fetch', url, '--format=json', '--output', path, '--verbose'])).exit,
    4,
  );
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.data.results[0].text, 'Business text: old-tinyfish-key');
  assert.ok(!JSON.stringify(saved.error).includes('old-tinyfish-key'));
  assert.ok(!JSON.stringify(saved.meta).includes('old-tinyfish-key'));
});
