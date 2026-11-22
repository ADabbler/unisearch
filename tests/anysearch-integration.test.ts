import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonObject } from '../src/result.js';
import { fixture, envelope, page, pageUrl, payloads } from './anysearch-fixture.js';

test('AnySearch is an anonymous default fetch candidate and explicit lists replace defaults', async (t) => {
  const f = await fixture(t);
  const defaults = (await f.run(['config', 'get', 'fetch.providers'])).json().data
    .value as string[];
  assert.deepEqual(defaults.slice(-2), ['anysearch', 'deepseek']);
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
  for (const [status, body, exit, code] of [
    [422, { code: -1, message: 'failure' }, 0, undefined],
    [200, envelope({ ...page, content: ' ' }), 0, undefined],
    [200, {}, 0, undefined],
    [
      500,
      { code: -1, message: 'upstream failure', error_code: 'SCRAPE_JOB_CANCELLED' },
      0,
      undefined,
    ],
    [400, { code: -1, message: 'bad input' }, 2, 'INVALID_ARGUMENT'],
    [404, { code: -1, message: 'unknown' }, 4, 'UPSTREAM_ERROR'],
    [200, { code: -1, message: 'business failure' }, 4, 'UPSTREAM_ERROR'],
  ] as const) {
    f.calls.length = 0;
    f.handle((call, res) => {
      if (call.path.startsWith('/gateway/')) {
        res.writeHead(status);
        res.end(JSON.stringify(body));
      } else res.end(JSON.stringify(payloads[call.path]));
    });
    const result = await f.run(['fetch', pageUrl, '--format=json']);
    assert.equal(result.exit, exit, `${status}: ${JSON.stringify(body)}`);
    assert.equal(f.calls.length, exit === 0 ? 2 : 1);
    if (exit === 0) assert.equal(result.json().data.provider, 'exa');
    else assert.equal(result.json().error.code, code);
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

test('Combined search retains an empty AnySearch result and reports an AnySearch failure separately', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_MODEL_API_KEY = 'fixture-model';
  const args = ['search', 'q', '--sources', 'model,anysearch', '--format=json'];
  for (const rejected of [false, true]) {
    f.handle((call, res) => {
      if (call.path === '/model/responses') res.end(JSON.stringify(payloads[call.path]));
      else if (rejected) {
        res.writeHead(401);
        res.end(JSON.stringify({ code: -1, message: 'bad key' }));
      } else res.end(JSON.stringify(envelope({ results: [] })));
    });
    const result = await f.run(args);
    const json = result.json();
    assert.equal(result.exit, rejected ? 6 : 0);
    assert.deepEqual(
      json.data.sources.map(({ provider }: { provider: string }) => provider),
      rejected ? ['model'] : ['model', 'anysearch'],
    );
    if (rejected) {
      assert.deepEqual(
        json.error.details.failures.map(({ provider, code }: JsonObject) => ({ provider, code })),
        [{ provider: 'anysearch', code: 'AUTHENTICATION_ERROR' }],
      );
    } else {
      assert.deepEqual(json.data.sources[1].data.results, []);
    }
  }
  const before = f.calls.length;
  for (const override of [
    { UNISEARCH_ANYSEARCH_API_KEY: '' },
    { UNISEARCH_ANYSEARCH_BASE_URL: 'bad' },
  ]) {
    const result = await f.run(args, override);
    assert.equal(result.exit, 3);
    assert.equal(result.json().error.code, 'INVALID_CONFIG');
  }
  assert.equal(f.calls.length, before);
});
