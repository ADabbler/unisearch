import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { JsonObject } from '../src/result.js';
import { prepareRetrieval, retrieve } from '../src/retrieval.js';
import { fixture as mcpFixture, pageUrl, pageText, rpc } from './zhipu-mcp-fixture.js';
import type { Call } from './zhipu-mcp-fixture.js';
import { hit, reader, search, timer } from './zhipu-fixture.js';
import { fetched, search as tinyfishSearch } from './tinyfish-fixture.js';
import { envelope, payloads } from './anysearch-fixture.js';

async function fixture(t: TestContext) {
  const f = await mcpFixture(t);
  Object.assign(f.env, {
    UNISEARCH_ZHIPU_API_KEY: 'fixture-rest-key',
    UNISEARCH_ZHIPU_BASE_URL: `${f.base}/rest`,
    UNISEARCH_TINYFISH_API_KEY: 'fixture-tinyfish-key',
    UNISEARCH_TINYFISH_SEARCH_URL: `${f.base}/tf-search`,
    UNISEARCH_TINYFISH_FETCH_URL: `${f.base}/tf-fetch`,
    UNISEARCH_MODEL_API_KEY: 'fixture-model-key',
    UNISEARCH_MODEL_BASE_URL: `${f.base}/model`,
    UNISEARCH_MODEL_ID: 'fixture-model',
  });
  return f;
}

test('Zhipu REST and MCP platform defaults, overrides and credentials remain independent', async (t) => {
  const f = await fixture(t);
  const withoutUrls = {
    UNISEARCH_ZHIPU_BASE_URL: undefined,
    UNISEARCH_ZHIPU_MCP_BASE_URL: undefined,
  };
  for (const [rest, mcp] of [
    ['bigmodel', 'zai'],
    ['zai', 'bigmodel'],
  ]) {
    f.save({ providers: { zhipu: { platform: rest }, 'zhipu-mcp': { platform: mcp } } });
    for (const [provider, platform, suffix] of [
      ['zhipu', rest, '/api/paas/v4'],
      ['zhipu-mcp', mcp, '/api/mcp'],
    ]) {
      const result = await f.run(['config', 'get', `providers.${provider}.base_url`], withoutUrls);
      assert.equal(result.exit, 0, result.channels.out);
      assert.equal(
        result.json().data.value,
        (platform === 'zai' ? 'https://api.z.ai' : 'https://open.bigmodel.cn') + suffix,
      );
    }
  }
  f.save({});
  const status = await f.run(['status', '--json'], { UNISEARCH_ZHIPU_API_KEY: undefined });
  assert.equal(
    status.json().data.services.find((s: JsonObject) => s.provider === 'zhipu').state,
    'missing',
  );
  assert.equal(
    status.json().data.services.find((s: JsonObject) => s.provider === 'zhipu-mcp').state,
    'ready',
  );
  for (const overrides of [
    { UNISEARCH_ZHIPU_PLATFORM: 'bad' },
    { UNISEARCH_ZHIPU_MCP_PLATFORM: 'bad' },
    { UNISEARCH_ZHIPU_MCP_API_KEY: undefined },
  ]) {
    const result = await f.run(
      ['search', 'q', '--extra-sources', 'zhipu,zhipu-mcp,tinyfish'],
      overrides,
    );
    assert.equal(result.exit, 3, result.channels.out);
  }
  assert.equal(f.calls.length, 0);
});

test(
  'model, Zhipu, Zhipu MCP and TinyFish run concurrently with stable output, retained failed evidence and isolated credentials',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const order = ['tinyfish', 'zhipu-mcp', 'zhipu'];
    const paths = [
      '/tf-search/',
      '/gateway/web_search_prime/mcp',
      '/rest/web_search',
      '/model/responses',
    ];
    for (const failed of [false, true]) {
      for (const format of ['json', 'markdown']) {
        const pending = new Map<string, { call: Call; res: ServerResponse }>();
        f.handle((call, res) => {
          pending.set(call.path, { call, res });
          if (!paths.every((path) => pending.has(path))) return;
          for (const path of [...paths].reverse()) {
            const task = pending.get(path)!;
            if (path.includes('/mcp'))
              rpc(task.res, task.call.body.id, {
                content: [
                  { type: 'text', text: pageText },
                  ...(failed ? [{ type: 'text', text: false }] : []),
                ],
                structuredContent: { score: 0, truncated: false },
              });
            else {
              let body = payloads[path];
              if (path === '/rest/web_search')
                body = failed ? { search_result: [hit, { link: 'bad' }] } : search;
              if (path === '/tf-search/') body = tinyfishSearch;
              task.res.end(JSON.stringify(body));
            }
          }
        });
        f.calls.length = 0;
        const file = join(f.root, `${failed}-${format}`);
        const result = await f.run([
          'search',
          'q',
          '--extra-sources',
          order.join(','),
          '--format',
          format,
          '--output',
          file,
          '--verbose',
          '--timeout',
          '2',
        ]);
        assert.equal(result.exit, failed ? 6 : 0, result.channels.out);
        const saved = readFileSync(file, 'utf8');
        if (format === 'json') {
          const value = JSON.parse(saved);
          assert.deepEqual(
            value.data.extra_sources.map((s: JsonObject) => s.provider),
            order,
          );
          assert.deepEqual(value.data.extra_sources[1].data.structured_content, {
            score: 0,
            truncated: false,
          });
          assert.equal(value.data.extra_sources[2].data.results[0].refer, hit.refer);
          assert.ok(
            value.data.extra_sources.every(
              (s: { data: JsonObject }) => s.data.provider === undefined,
            ),
          );
          if (failed)
            assert.deepEqual(
              value.error.details.failures.map((s: JsonObject) => s.provider),
              ['zhipu-mcp', 'zhipu'],
            );
        } else {
          assert.deepEqual(
            [...saved.matchAll(/^### (TinyFish|Zhipu MCP|Zhipu)$/gm)].map((m) => m[1]),
            ['TinyFish', 'Zhipu MCP', 'Zhipu'],
          );
          assert.ok(saved.includes(pageText));
          assert.match(saved, /"score": 0/);
          assert.match(saved, /"truncated": false/);
          assert.ok(saved.includes(hit.content));
        }
        for (const path of paths)
          assert.equal(
            f.calls.filter(
              (c) =>
                c.path === path &&
                c.body.method !== 'initialize' &&
                c.body.method !== 'notifications/initialized',
            ).length,
            1,
          );
        assert.equal(
          f.calls.find((c) => c.path === '/rest/web_search')?.headers.authorization,
          'Bearer fixture-rest-key',
        );
        assert.ok(
          f.calls
            .filter((c) => c.path.endsWith('/mcp'))
            .every((c) => c.headers.authorization === 'Bearer fixture-mcp-key'),
        );
        assert.equal(
          f.calls.find((c) => c.path === '/tf-search/')?.headers['x-api-key'],
          'fixture-tinyfish-key',
        );
        const tool = f.calls.find((c) => c.body.method === 'tools/call');
        assert.deepEqual(tool?.body.params, {
          name: 'webSearchPrime',
          arguments: { search_query: 'q' },
        });
      }
    }
  },
);

test('default fetch tries configured services in order including REST before MCP and preserves explicit replacement', async (t) => {
  const f = await fixture(t);
  Object.assign(f.env, {
    UNISEARCH_FIRECRAWL_API_KEY: 'fixture-firecrawl',
    UNISEARCH_FIRECRAWL_BASE_URL: `${f.base}/fc`,
    UNISEARCH_EXA_API_KEY: 'fixture-exa',
    UNISEARCH_EXA_BASE_URL: `${f.base}/exa`,
    UNISEARCH_TAVILY_API_KEY: 'fixture-tavily',
    UNISEARCH_TAVILY_BASE_URL: `${f.base}/tavily`,
    UNISEARCH_JINA_READER_URL: `${f.base}/jina`,
    UNISEARCH_ANYSEARCH_BASE_URL: `${f.base}/any`,
  });
  f.save({});
  const reject = (_call: Call, res: ServerResponse) => {
    res.writeHead(401);
    res.end('{}');
  };
  f.initialize(reject);
  f.handle((call, res) => {
    if (call.path === '/any/v1/extract')
      res.end(JSON.stringify(envelope({ url: pageUrl, content: pageText })));
    else reject(call, res);
  });
  const result = await f.run(['fetch', pageUrl, '--format=json', '--verbose']);
  assert.equal(result.exit, 0, result.channels.out);
  assert.equal(result.json().data.provider, 'anysearch');
  const order = [
    'firecrawl',
    'exa',
    'tavily',
    'jina',
    'zhipu',
    'zhipu-mcp',
    'tinyfish',
    'anysearch',
  ];
  assert.deepEqual(
    result.json().meta.attempts.map((a: JsonObject) => a.provider),
    order,
  );
  assert.equal(
    f.calls.find((c) => c.path === '/rest/reader')?.headers.authorization,
    'Bearer fixture-rest-key',
  );
  assert.equal(
    f.calls.find((c) => c.path === '/gateway/web_reader/mcp')?.headers.authorization,
    'Bearer fixture-mcp-key',
  );
  f.calls.length = 0;
  assert.equal((await f.run(['fetch', pageUrl, '--no-fallback'])).exit, 3);
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ['/fc/scrape'],
  );
  f.save({ fetch: { providers: ['tinyfish'] } });
  f.handle((call, res) => res.end(JSON.stringify(fetched(call.body.urls as string[]))));
  f.calls.length = 0;
  assert.equal((await f.run(['fetch', pageUrl])).exit, 0);
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ['/tf-fetch/'],
  );
});

test('REST and MCP switch both ways, retain the last usable body and render structured failure details', async (t) => {
  const f = await fixture(t);
  for (const order of [
    ['zhipu', 'zhipu-mcp'],
    ['zhipu-mcp', 'zhipu'],
  ]) {
    f.save({ fetch: { providers: order } });
    f.handle((call, res) => {
      const first =
        order[0] === 'zhipu' ? call.path === '/rest/reader' : call.path.endsWith('/mcp');
      if (call.path.endsWith('/mcp'))
        rpc(res, call.body.id, { content: [{ type: 'text', text: first ? '' : pageText }] });
      else
        res.end(
          JSON.stringify(
            first ? { reader_result: { ...reader.reader_result, content: '' } } : reader,
          ),
        );
    });
    const result = await f.run(['fetch', pageUrl, '--format=json', '--verbose']);
    assert.equal(result.exit, 0, result.channels.out);
    assert.equal(result.json().data.provider, order[1]);
    assert.deepEqual(
      result.json().meta.attempts.map((a: JsonObject) => a.provider),
      order,
    );
    assert.equal((await f.run(['fetch', pageUrl, '--no-fallback'])).exit, 4);
  }
  f.save({ fetch: { providers: ['zhipu', 'zhipu-mcp'] } });
  f.handle((call, res) => {
    if (call.path === '/rest/reader')
      res.end(
        JSON.stringify({ ...reader, reader_result: { ...reader.reader_result, title: false } }),
      );
    else
      rpc(res, call.body.id, {
        isError: true,
        content: [{ type: 'text', text: 'Cannot read page' }],
        structuredContent: { indexed: false, suggestion: 'Try the source URL' },
      });
  });
  const result = await f.run(['fetch', pageUrl, '--format=json', '--verbose']);
  assert.equal(result.exit, 4);
  assert.equal(result.json().data.provider, 'zhipu');
  assert.equal(result.json().data.results[0].text, reader.reader_result.content);
  assert.deepEqual(
    result.json().error.details.failures.map((f: JsonObject) => f.provider),
    ['zhipu', 'zhipu-mcp'],
  );
  const markdown = await f.run(['fetch', pageUrl]);
  assert.equal(markdown.exit, 4);
  assert.ok(markdown.channels.out.includes(reader.reader_result.content));
  assert.match(markdown.channels.out, /"indexed": false/);
  assert.match(markdown.channels.out, /Try the source URL/);
});

test('REST failure and MCP handshake share the remaining fetch deadline and stop before TinyFish after cancellation', async (t) => {
  const f = await fixture(t);
  for (const cancel of [false, true]) {
    const time = timer();
    const controller = new AbortController();
    f.calls.length = 0;
    f.handle((call, res) => {
      if (call.path === '/rest/reader') {
        time.advance(1000);
        res.end(JSON.stringify({ reader_result: { ...reader.reader_result, content: '' } }));
      } else rpc(res, call.body.id, { content: [{ type: 'text', text: pageText }] });
    });
    const result = await retrieve(
      prepareRetrieval(
        'fetch',
        pageUrl,
        { timeout: 4 },
        { fetch: { providers: ['zhipu', 'zhipu-mcp', 'tinyfish'] } },
        f.env,
        'en',
      ),
      controller.signal,
      'en',
      {},
      {
        clock: time.clock,
        transport: async (url, init) => {
          const response = await fetch(url, init);
          if (cancel && JSON.parse(String(init?.body)).method === 'initialize') controller.abort();
          return response;
        },
      },
    );
    assert.equal(result.exitCode, cancel ? 130 : 0);
    assert.deepEqual(time.caps, [4000, 3000]);
    assert.ok(f.calls.every((call) => call.path !== '/tf-fetch/'));
    if (cancel)
      assert.deepEqual(
        f.calls.map((call) => call.path),
        ['/rest/reader', '/gateway/web_reader/mcp'],
      );
  }
});
