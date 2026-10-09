import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ExecutionClock } from '../src/execution.js';
import { prepareRetrieval, retrieve } from '../src/retrieval.js';
import type { JsonObject } from '../src/result.js';
import { fixture as anysearchFixture, envelope, pageUrl, payloads } from './anysearch-fixture.js';
import { envelope as jinaEnvelope } from './jina-helpers.js';

const page = {
  url: pageUrl,
  title: 'Jina guide',
  content: '# Full guide\n\n```ts\nrun();\n```',
  description: 'Independent summary',
  metadata: { keywords: ['installation', 'API'] },
};
const replies: Record<string, unknown> = {
  ...payloads,
  '/reader/': jinaEnvelope(page, 0),
  '/searcher/search': jinaEnvelope([page], 17),
};

async function fixture(t: TestContext) {
  const f = await anysearchFixture(t);
  Object.assign(f.env, {
    UNISEARCH_JINA_READER_URL: `${f.base}/reader`,
    UNISEARCH_JINA_SEARCH_URL: `${f.base}/searcher`,
  });
  f.save({});
  f.handle((call, res) => res.end(JSON.stringify(replies[call.path])));
  return f;
}

test('anonymous Jina and AnySearch respect default order, explicit replacement, preflight and disabled fallback', async (t) => {
  const f = await fixture(t);
  const first = await f.run(['fetch', pageUrl, '--format=json']);
  assert.equal(first.exit, 0, first.channels.out);
  assert.equal(first.json().data.provider, 'jina');
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ['/reader/'],
  );
  assert.equal(f.calls[0].headers.authorization, undefined);

  for (const order of [undefined, ['anysearch', 'jina']] as const) {
    f.save(order ? { fetch: { providers: order } } : {});
    const firstPath = order ? '/gateway/v1/extract' : '/reader/';
    const expected = order ? ['anysearch', 'jina'] : ['jina', 'anysearch'];
    f.handle((call, res) => {
      if (call.path === firstPath) {
        res.writeHead(401);
        res.end(JSON.stringify({ code: 401, status: 40100, message: 'Invalid credentials' }));
      } else res.end(JSON.stringify(replies[call.path]));
    });
    f.calls.length = 0;
    const switched = await f.run(['fetch', pageUrl, '--format=json', '--verbose']);
    assert.equal(switched.exit, 0, switched.channels.out);
    assert.equal(switched.json().data.provider, expected[1]);
    assert.deepEqual(
      switched.json().meta.attempts.map((a: JsonObject) => a.provider),
      expected,
    );
    assert.deepEqual(
      switched.json().meta.service_fallbacks.map((s: JsonObject) => [s.from, s.to]),
      [expected],
    );
    assert.ok(f.calls.every((call) => call.headers.authorization === undefined));
    f.calls.length = 0;
    assert.equal((await f.run(['fetch', pageUrl, '--no-fallback'])).exit, 3);
    assert.deepEqual(
      f.calls.map((call) => call.path),
      [firstPath],
    );
  }

  f.save({ fetch: { providers: ['jina', 'anysearch'] } });
  f.handle((call, res) => res.end(JSON.stringify(replies[call.path])));
  f.calls.length = 0;
  assert.equal((await f.run(['fetch', pageUrl], { UNISEARCH_ANYSEARCH_BASE_URL: 'bad' })).exit, 3);
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.run(['fetch', pageUrl, '--no-fallback'], { UNISEARCH_ANYSEARCH_BASE_URL: 'bad' }))
      .exit,
    0,
  );
  f.calls.length = 0;
  f.save({ fetch: { providers: ['jina', 'anysearch'] }, providers: { jina: { enabled: false } } });
  assert.equal((await f.run(['fetch', pageUrl])).exit, 0);
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ['/gateway/v1/extract'],
  );
});

test('Jina failed page data survives later AnySearch failures and successful extraction replaces it', async (t) => {
  const f = await fixture(t);
  f.save({ fetch: { providers: ['jina', 'anysearch'] } });
  for (const hasText of [true, false]) {
    f.handle((call, res) => {
      if (call.path === '/reader/') {
        const data = hasText ? { ...page, title: false } : { url: pageUrl, title: page.title };
        res.end(JSON.stringify(jinaEnvelope(data, 0)));
      } else res.end(JSON.stringify(envelope({ url: pageUrl, content: ' ' })));
    });
    const path = join(f.root, hasText ? 'retained.json' : 'metadata.json');
    const result = await f.run(['fetch', pageUrl, '--format=json', '--verbose', '--output', path]);
    assert.equal(result.exit, 4, result.channels.out);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved.data.provider, 'jina');
    assert.equal(saved.data.results[0].text, hasText ? page.content : undefined);
    assert.deepEqual(
      saved.error.details.failures.map((x: JsonObject) => x.provider),
      ['jina', 'anysearch'],
    );
    assert.deepEqual(
      saved.meta.attempts.map((x: JsonObject) => x.billed_tokens),
      [0, undefined],
    );
    if (hasText) {
      assert.deepEqual(saved.data.results[0].metadata, page.metadata);
      const markdown = await f.run(['fetch', pageUrl]);
      assert.equal(markdown.exit, 4);
      assert.ok(markdown.channels.out.includes(page.content));
      assert.ok(markdown.channels.out.includes(page.description));
      assert.match(markdown.channels.out, /installation/);
    }
  }
  f.handle((call, res) =>
    res.end(
      JSON.stringify(
        call.path === '/reader/' ? jinaEnvelope({ ...page, title: false }) : payloads[call.path],
      ),
    ),
  );
  const success = await f.run(['fetch', pageUrl, '--format=json']);
  assert.equal(success.exit, 0, success.channels.out);
  assert.equal(success.json().data.provider, 'anysearch');
  assert.equal(success.json().data.results[0].description, undefined);
  assert.equal(success.json().data.results[0].metadata, undefined);
});

test(
  'model, Jina and AnySearch run concurrently with stable source order and complete JSON/Markdown files',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    Object.assign(f.env, {
      UNISEARCH_MODEL_API_KEY: 'fixture-model',
      UNISEARCH_JINA_API_KEY: 'fixture-jina',
    });
    f.save({ providers: { jina: { search: { limit: 2 } }, anysearch: { search: { limit: 3 } } } });
    for (const format of ['json', 'markdown']) {
      const pending = new Map<string, ServerResponse>();
      f.handle((call, res) => {
        pending.set(call.path, res);
        const completion = ['/gateway/v1/search', '/searcher/search', '/model/responses'];
        if (!completion.every((path) => pending.has(path))) return;
        for (const path of completion) pending.get(path)!.end(JSON.stringify(replies[path]));
      });
      f.calls.length = 0;
      const path = join(f.root, `combined.${format}`);
      const result = await f.run([
        'search',
        'integration query',
        '--extra-sources',
        'jina,anysearch',
        '--format',
        format,
        '--output',
        path,
        '--verbose',
        '--timeout',
        '2',
      ]);
      assert.equal(result.exit, 0, result.channels.out);
      assert.equal(f.calls.length, 3);
      assert.deepEqual(f.calls.find((call) => call.path === '/searcher/search')?.body, {
        q: 'integration query',
        num: 2,
        type: 'web',
        respondWith: 'content',
        fallback: false,
      });
      assert.deepEqual(f.calls.find((call) => call.path === '/gateway/v1/search')?.body, {
        query: 'integration query',
        max_results: 3,
        format: 'markdown',
      });
      const saved = readFileSync(path, 'utf8');
      if (format === 'json') {
        const json = JSON.parse(saved);
        assert.deepEqual(
          json.data.extra_sources.map((s: JsonObject) => s.provider),
          ['jina', 'anysearch'],
        );
        assert.equal(json.data.extra_sources[0].data.results[0].text, page.content);
        assert.deepEqual(json.data.extra_sources[0].data.results[0].metadata, page.metadata);
        assert.ok(
          json.data.extra_sources.every((s: { data: JsonObject }) => s.data.provider === undefined),
        );
        assert.equal(
          json.meta.attempts.find((a: JsonObject) => a.provider === 'jina').billed_tokens,
          17,
        );
      } else {
        assert.deepEqual(
          [...saved.matchAll(/^### (Jina|AnySearch)$/gm)].map((match) => match[1]),
          ['Jina', 'AnySearch'],
        );
        assert.ok(saved.includes(page.content));
        assert.ok(saved.includes(page.description));
        assert.match(saved, /Model answer/);
        assert.doesNotMatch(saved, /Billed usage/);
        assert.match(result.channels.err, /Billed usage/);
      }
    }
    const before = f.calls.length;
    for (const overrides of [
      { UNISEARCH_JINA_API_KEY: '' },
      { UNISEARCH_ANYSEARCH_BASE_URL: 'bad' },
    ]) {
      assert.equal(
        (await f.run(['search', 'q', '--extra-sources', 'jina,anysearch'], overrides)).exit,
        3,
      );
    }
    assert.equal(f.calls.length, before);
  },
);

test('combined Jina and AnySearch failures retain independent evidence and redact each other’s credentials', async (t) => {
  const f = await fixture(t);
  const credentials = [
    'fixture-jina-current',
    'fixture-any-current',
    'fixture-jina-saved',
    'fixture-any-saved',
  ];
  Object.assign(f.env, {
    UNISEARCH_MODEL_API_KEY: 'fixture-model',
    UNISEARCH_JINA_API_KEY: credentials[0],
    UNISEARCH_ANYSEARCH_API_KEY: credentials[1],
  });
  f.save({
    providers: { jina: { api_key: credentials[2] }, anysearch: { api_key: credentials[3] } },
  });
  for (const mode of ['anysearch-failure', 'jina-partial', 'model-failure'] as const) {
    f.handle((call, res) => {
      if (
        (mode === 'anysearch-failure' && call.path === '/gateway/v1/search') ||
        (mode === 'model-failure' && call.path === '/model/responses')
      ) {
        res.writeHead(401, { 'x-request-id': credentials.join('-') });
        res.end(JSON.stringify({ code: -1, message: credentials.join(' ') }));
      } else if (call.path === '/searcher/search') {
        const data =
          mode === 'jina-partial' ? { url: pageUrl, description: 'Available evidence' } : page;
        res.end(JSON.stringify(jinaEnvelope([{ ...data, warning: credentials.join(' ') }])));
      } else res.end(JSON.stringify(replies[call.path]));
    });
    for (const format of ['json', 'markdown']) {
      const path = join(f.root, `${mode}.${format}`);
      const result = await f.run([
        'search',
        'q',
        '--extra-sources',
        'anysearch,jina',
        '--format',
        format,
        '--output',
        path,
        '--verbose',
      ]);
      assert.equal(result.exit, mode === 'model-failure' ? 3 : 6, result.channels.out);
      const saved = readFileSync(path, 'utf8');
      for (const secret of credentials)
        assert.ok(!`${saved}${result.channels.out}${result.channels.err}`.includes(secret));
      if (format === 'json') {
        const json = JSON.parse(saved);
        assert.deepEqual(
          json.data.extra_sources.map((s: JsonObject) => s.provider),
          mode === 'anysearch-failure' ? ['jina'] : ['anysearch', 'jina'],
        );
        assert.equal(json.data.answer === undefined, mode === 'model-failure');
        if (mode === 'jina-partial')
          assert.equal(
            json.data.extra_sources[1].data.results[0].description,
            'Available evidence',
          );
      } else assert.match(saved, mode === 'jina-partial' ? /Available evidence/ : /Full guide/);
    }
  }
});

test('Jina to AnySearch switching uses the remaining deadline and stops on cancellation', async (t) => {
  const f = await fixture(t);
  for (const mode of ['success', 'timeout', 'cancel'] as const) {
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
      if (call.path === '/reader/') {
        now += 1000;
        res.writeHead(503, { 'retry-after': '5' });
        res.end(JSON.stringify({ code: 503, status: 50300 }));
      } else {
        if (mode === 'timeout') now += 3001;
        res.end(JSON.stringify(payloads[call.path]));
      }
    });
    const result = await retrieve(
      prepareRetrieval(
        'fetch',
        pageUrl,
        { timeout: 4 },
        { fetch: { providers: ['jina', 'anysearch'] } },
        { ...f.env, UNISEARCH_RETRIES: '1' },
        'en',
      ),
      controller.signal,
      'en',
      {},
      {
        clock: time,
        transport: async (url, init) => {
          const response = await fetch(url, init);
          if (mode === 'cancel') controller.abort();
          return response;
        },
      },
    );
    assert.equal(result.exitCode, { success: 0, timeout: 4, cancel: 130 }[mode]);
    assert.deepEqual(caps, mode === 'cancel' ? [4000] : [4000, 3000]);
    assert.equal(f.calls.length, mode === 'cancel' ? 1 : 2);
    if (mode === 'timeout') {
      assert.equal(result.result.error?.code, 'TIMEOUT');
      const failures = result.result.error?.details?.failures as JsonObject[];
      assert.equal((failures.at(-1)?.details as JsonObject).timeout_scope, 'total');
    }
  }
});
