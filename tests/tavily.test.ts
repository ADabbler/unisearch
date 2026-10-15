import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createCli } from '../src/cli/program.js';
import { AppError } from '../src/errors.js';
import { localStatus } from '../src/config/status.js';
import {
  prepareTavilySearch,
  prepareExtract,
  prepareMap,
  requestTavilySearch,
  requestExtract,
  requestMap,
  tavilySearchData,
  extractResult,
  mapData,
  tavilyOperations,
  tavilyRequestLimits,
} from '../src/providers/tavily.js';
import type { TavilySearchOptions } from '../src/providers/tavily.js';
import { executeRequest } from '../src/execution.js';
import type { ExecutionClock } from '../src/execution.js';
import { render } from '../src/output/render.js';
import type { JsonObject, Outcome } from '../src/result.js';
import { capture, context, temporary } from './helpers.js';

const env = {
  UNISEARCH_TAVILY_API_KEY: 'fixture-tavily-key',
  UNISEARCH_LANG: 'en',
  UNISEARCH_RETRIES: '0',
};
const a = 'https://example.com/a';
const b = 'https://example.com/b';
const search = (options: TavilySearchOptions = {}, values = {}) =>
  prepareTavilySearch(' query ', options, values, env, 'en');
async function server(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const instance = createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise<void>((done) => instance.close(() => done()));
  });
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function body(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function cli(root: string, args: string[], environment: NodeJS.ProcessEnv = env) {
  const channels = capture();
  const exit = await createCli('test', { config: context(root, environment), channels }).run(args);
  return { ...channels, exit };
}

test('Tavily help, all scalar errors and prerequisites are local and never issue HTTP requests', async (t) => {
  const root = temporary(t);
  let calls = 0;
  const base = await server(t, (_req, res) => {
    calls++;
    res.end('{}');
  });
  const environment = { ...env, UNISEARCH_TAVILY_BASE_URL: base };
  for (const language of ['zh', 'en'])
    for (const args of [[], ['search'], ['extract'], ['map']]) {
      const result = await cli(root, ['tavily', ...args, '--help'], { UNISEARCH_LANG: language });
      assert.equal(result.exit, 0);
      assert.match(result.out, language === 'zh' ? /用法/ : /Usage/);
    }
  assert.equal((await cli(root, ['tavily'], environment)).exit, 0);
  for (const args of [
    ['search'],
    ['extract'],
    ['map'],
    ['crawl', a],
    ['search', ' '],
    ...['0', '21', '1.5', '01', 'Infinity', '-1'].map((n) => ['search', 'q', '--limit', n]),
    ['search', 'q', '--limit', '2', '--limit', '3'],
    ['search', 'q', '--include-text', '--include-text'],
    ['search', 'q', '--topic', 'bad'],
    ['search', 'q', '--search-depth', 'bad'],
    ['search', 'q', '--time-range', 'd'],
    ['search', 'q', '--start-date', '2026-02-30'],
    ['search', 'q', '--start-date', '2026-01-01T00:00:00Z'],
    ['search', 'q', '--time-range', 'day', '--end-date', '2026-01-01'],
    ['search', 'q', '--start-date', '2026-02-01', '--end-date', '2026-01-01'],
    ['search', 'q', '--include-domains', 'example.com,'],
    ['search', 'q', '--include-domains', ' example.com'],
    ['search', 'q', '--api-key', 'secret'],
    ['search', 'q', '--format', 'text'],
    ['extract', a, '--chunks-per-source', '2'],
    ['extract', a, '--query', ' '],
    ['extract', a, '--query', 'q', '--chunks-per-source', '6'],
    ['extract', a, '--extract-depth', 'bad'],
    ['extract', ...Array<string>(21).fill(a)],
    ['extract', a, 'https://user:password@example.com'],
    ['extract', 'https://example.com/ a'],
    ['map', 'ftp://example.com'],
    ['map', a, '--no-allow-external'],
    ['map', a, '--allow-external', '--allow-external'],
    ['map', a, '--max-depth', '6'],
    ['map', a, '--max-breadth', '501'],
    ['map', a, '--limit', '9007199254740992'],
    ['map', a, '--instructions', ' '],
    ['map', a, '--select-path', ' '],
  ]) {
    const result = await cli(root, ['--format=json', 'tavily', ...args], environment);
    assert.equal(result.exit, 2, `${args.join(' ')}: ${result.out}`);
  }
  for (const change of [
    { UNISEARCH_TAVILY_API_KEY: undefined },
    { UNISEARCH_TAVILY_BASE_URL: 'bad' },
  ]) {
    assert.equal(
      (await cli(root, ['tavily', 'search', 'q', '--format=json'], { ...environment, ...change }))
        .exit,
      3,
    );
  }
  assert.equal(
    (await cli(root, ['tavily', 'map', a, '--output', join(root, 'missing', 'file')], environment))
      .exit,
    5,
  );
  assert.equal(calls, 0);
});

test('Tavily configuration management, operation scopes and status share validation and defaults', async (t) => {
  const root = temporary(t);
  const path = join(root, '设置 file.json');
  const environment = { ...env, UNISEARCH_CONFIG_PATH: path };
  for (const [key, value] of [
    ['base_url', 'https://gateway.example/prefix/'],
    ['search.limit', '20'],
    ['search.search_depth', 'ultra-fast'],
    ['extract.extract_depth', 'advanced'],
    ['map.limit', '9007199254740991'],
  ]) {
    assert.equal(
      (await cli(root, ['config', 'set', `providers.tavily.${key}`, value], environment)).exit,
      0,
    );
    const result = await cli(root, ['config', 'get', `providers.tavily.${key}`], environment);
    assert.equal(JSON.parse(result.out).data.source, 'config');
  }
  const saved = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(saved).execution, undefined);
  for (const [key, value] of [
    ['search.limit', '21'],
    ['map.max_depth', '6'],
    ['map.max_breadth', '501'],
    ['search.topic', 'bad'],
    ['base_url', 'https://example.com?'],
  ]) {
    assert.equal(
      (await cli(root, ['config', 'set', `providers.tavily.${key}`, value], environment)).exit,
      2,
    );
    assert.equal(readFileSync(path, 'utf8'), saved);
  }
  const list = await cli(root, ['config', 'list'], {
    ...environment,
    UNISEARCH_TAVILY_BASE_URL: 'https://override.example',
    TAVILY_API_KEY: 'ignored',
  });
  assert.match(list.out, /UNISEARCH_TAVILY_BASE_URL/);
  assert.doesNotMatch(list.out, /fixture-tavily-key|ignored/);
  assert.equal((await cli(root, ['config', 'unset', 'providers.tavily.map'], environment)).exit, 0);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).providers.tavily.map, undefined);
  const values = {
    providers: { tavily: { map: { limit: 0 } } },
    execution: { fallback: 'ignored' },
  };
  assert.equal(search({}, values).body.max_results, 5);
  assert.equal(prepareMap(a, { limit: '2', maxDepth: '2' }, values, env, 'en').body.max_depth, 2);
  const state = localStatus(values, env, 'en', tavilyOperations).services[0];
  assert.deepEqual(
    state.operations?.map((o) => [o.operation, o.state]),
    [
      ['search', 'ready'],
      ['extract', 'ready'],
      ['map', 'invalid'],
    ],
  );
  assert.deepEqual(localStatus({}, env, 'en', tavilyOperations).services, [
    { provider: 'tavily', state: 'ready' },
  ]);
  for (const [change, expected] of [
    [{ UNISEARCH_TAVILY_API_KEY: undefined }, 'missing'],
    [{ UNISEARCH_TAVILY_API_KEY: ' ' }, 'invalid'],
  ] as const)
    assert.equal(
      localStatus({}, { ...env, ...change }, 'en', tavilyOperations).services[0].state,
      expected,
    );
  assert.throws(() => prepareMap(a, {}, values, env, 'en'), AppError);
});

test('Native HTTP requests send exact default bodies, path prefixes and Bearer headers', async (t) => {
  const root = temporary(t);
  const requests: JsonObject[] = [];
  const base = await server(t, async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, `Bearer ${env.UNISEARCH_TAVILY_API_KEY}`);
    assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.headers.accept, 'application/json');
    assert.equal(req.headers['content-type'], 'application/json');
    const data = await body(req);
    requests.push({ path: req.url!, body: data });
    res.end(
      JSON.stringify(
        req.url?.endsWith('/extract')
          ? {
              results: (data.urls as string[]).map((url) => ({ url, raw_content: '# Page' })),
              failed_results: [],
            }
          : { results: [] },
      ),
    );
  });
  const environment = { ...env, UNISEARCH_TAVILY_BASE_URL: `${base}/prefix/` };
  for (const args of [
    ['search', ' query '],
    ['extract', a],
    ['map', a],
  ]) {
    const result = await cli(
      root,
      ['tavily', ...args, '--format=json', '--timeout', '0.5'],
      environment,
    );
    assert.equal(result.exit, 0, result.out);
  }
  assert.deepEqual(requests, [
    {
      path: '/prefix/search',
      body: {
        query: ' query ',
        max_results: 5,
        search_depth: 'basic',
        topic: 'general',
        include_raw_content: false,
        include_answer: false,
        auto_parameters: false,
        include_images: false,
        include_favicon: false,
        include_usage: false,
      },
    },
    {
      path: '/prefix/extract',
      body: {
        urls: [a],
        extract_depth: 'basic',
        format: 'markdown',
        timeout: 10,
        include_images: false,
        include_favicon: false,
        include_usage: false,
      },
    },
    {
      path: '/prefix/map',
      body: {
        url: a,
        max_depth: 1,
        max_breadth: 20,
        limit: 50,
        allow_external: false,
        timeout: 150,
        include_usage: false,
      },
    },
  ]);
  const twenty = Array<string>(20).fill('https://example.com/a,b?q=1#part');
  assert.equal(
    (
      await cli(
        root,
        [
          'tavily',
          'extract',
          ...twenty,
          '--extract-depth',
          'advanced',
          '--query',
          ' q ',
          '--chunks-per-source',
          '5',
        ],
        environment,
      )
    ).exit,
    0,
  );
  assert.deepEqual(requests[3].body, {
    urls: twenty,
    extract_depth: 'advanced',
    query: ' q ',
    chunks_per_source: 5,
    format: 'markdown',
    timeout: 30,
    include_images: false,
    include_favicon: false,
    include_usage: false,
  });
  assert.equal(requests.length, 4);
  assert.equal(
    (
      await cli(
        root,
        [
          'tavily',
          'map',
          a,
          '--select-path',
          '^/a{1,2}\\d',
          '--select-path',
          '[',
          '--exclude-path',
          '^/b',
          '--select-domain',
          '^docs\\.',
          '--exclude-domain',
          '^private\\.',
          '--allow-external',
          '--instructions',
          ' API docs ',
          '--limit',
          '80',
          '--max-depth',
          '2',
          '--max-breadth',
          '30',
        ],
        environment,
      )
    ).exit,
    0,
  );
  assert.deepEqual(requests[4].body, {
    url: a,
    max_depth: 2,
    max_breadth: 30,
    limit: 80,
    allow_external: true,
    timeout: 150,
    include_usage: false,
    instructions: ' API docs ',
    select_paths: ['^/a{1,2}\\d', '['],
    exclude_paths: ['^/b'],
    select_domains: ['^docs\\.'],
    exclude_domains: ['^private\\.'],
  });
  const config = join(root, 'config.json');
  writeFileSync(config, '{}');
  for (const [args, expected] of [
    [[], false],
    [['--allow-external'], true],
  ] as const) {
    assert.equal(
      (
        await cli(root, ['tavily', 'map', a, ...args], {
          ...environment,
          UNISEARCH_CONFIG_PATH: config,
        })
      ).exit,
      0,
    );
    assert.equal((requests.at(-1)!.body as JsonObject).allow_external, expected);
  }
});

test('Search filters and native bounds preserve dates, domains, four depths and three topics', () => {
  for (const searchDepth of ['basic', 'advanced', 'fast', 'ultra-fast'])
    for (const topic of ['general', 'news', 'finance'])
      for (const limit of ['1', '20']) {
        const request = search({
          searchDepth,
          topic,
          limit,
          includeText: true,
          startDate: '2024-02-29',
          endDate: '2026-09-30',
          includeDomains: '*.example.com/docs,example.org',
          excludeDomains: 'example.org/private',
        });
        assert.deepEqual(request.body, {
          query: ' query ',
          max_results: Number(limit),
          search_depth: searchDepth,
          topic,
          include_raw_content: 'markdown',
          start_date: '2024-02-29',
          end_date: '2026-09-30',
          include_domains: ['*.example.com/docs', 'example.org'],
          include_domains_mode: 'restrict',
          exclude_domains: ['example.org/private'],
          include_answer: false,
          auto_parameters: false,
          include_images: false,
          include_favicon: false,
          include_usage: false,
        });
      }
  for (const timeRange of ['day', 'week', 'month', 'year'])
    assert.equal(search({ timeRange }).body.time_range, timeRange);
  for (const [key, count] of [
    ['includeDomains', 300],
    ['excludeDomains', 150],
  ] as const) {
    const domains = Array<string>(count).fill('example.com').join(',');
    assert.ok(search({ [key]: domains }));
    assert.throws(() => search({ [key]: `${domains},example.com` }), AppError);
  }
  const values = {
    providers: { tavily: { search: { limit: 8, search_depth: 'advanced' } } },
  };
  assert.equal(search({}, values).body.max_results, 8);
  assert.equal(search({ limit: '1' }, values).body.max_results, 1);
});

test('Search and Map retain only useful fields, order, duplicates and optional text availability', () => {
  const item = {
    url: a,
    title: 'A',
    content: ' summary ',
    published_date: 'original date',
    raw_content: '# A',
    score: 0.875,
    answer: 2,
  };
  const data = tavilySearchData({ results: [item, item] }, true);
  assert.deepEqual(
    data.results,
    Array(2).fill({
      url: a,
      title: 'A',
      content: ' summary ',
      published_date: 'original date',
      score: 0.875,
      text: '# A',
    }),
  );
  assert.deepEqual(
    tavilySearchData(
      { results: [{ url: a, content: ' ', raw_content: null, title: '', published_date: null }] },
      true,
    ).results,
    [{ url: a, missing_content: ['text'] }],
  );
  assert.deepEqual(tavilySearchData({ results: [{ url: a, raw_content: 2 }] }, false).results, [
    { url: a },
  ]);
  for (const bad of [
    {},
    { results: [null] },
    { results: [{ id: a }] },
    ...[
      { url: 'example.com' },
      { title: 2 },
      { content: [] },
      { published_date: false },
      { raw_content: 1 },
    ].map((v) => ({ results: [{ ...item, ...v }] })),
  ])
    assert.throws(() => tavilySearchData(bad, true), AppError);
  assert.deepEqual(mapData({ results: [a, a, b], base_url: 'unused', usage: 12 }).results, [
    a,
    a,
    b,
  ]);
  assert.deepEqual(mapData({ results: [] }).results, []);
  for (const bad of [{}, { results: [a, null] }, { results: ['example.com'] }])
    assert.throws(() => mapData(bad), AppError);
});

test('Tavily URLs keep query and fragment at signs separate from credentials', () => {
  for (const url of [
    'https://example.org?email=dev@example.org',
    'https://example.org#@installation',
  ]) {
    const request = prepareExtract([url], {}, {}, env, 'en');
    assert.deepEqual(request.body.urls, [url]);
    assert.deepEqual(
      extractResult({ results: [{ url, raw_content: 'Page' }], failed_results: [] }, request, 'en')
        .result.data?.results,
      [{ url, text: 'Page' }],
    );
    assert.equal(prepareMap(url, {}, {}, env, 'en').body.url, url);
    assert.deepEqual(mapData({ results: [url] }).results, [url]);
  }
});

test('Extract completeness uses both arrays, preserves redirect URLs and distinguishes content and structural failures', () => {
  const request = prepareExtract([a, b], {}, {}, env, 'en');
  assert.deepEqual(
    extractResult(
      {
        results: [
          { url: b, raw_content: '# B' },
          { url: 'https://redirect.example/a', raw_content: '# A' },
        ],
        failed_results: [],
      },
      request,
      'en',
    ).result,
    {
      status: 'success',
      data: {
        provider: 'tavily',
        content_type: 'page',
        results: [
          { url: b, text: '# B' },
          { url: 'https://redirect.example/a', text: '# A' },
        ],
      },
    },
  );
  const partial = extractResult(
    {
      results: [{ url: a, raw_content: '# A' }],
      failed_results: [{ url: b, error: 'Failed to retrieve content' }],
    },
    request,
    'zh',
  );
  assert.equal(partial.exitCode, 6);
  assert.equal(partial.result.error?.details?.provider, undefined);
  assert.deepEqual(partial.result.error?.details?.failures, [
    {
      url: b,
      code: 'UPSTREAM_ERROR',
      message: '网页提取失败',
      details: { reason: 'extraction_failed', upstream_message: 'Failed to retrieve content' },
    },
  ]);
  const single = prepareExtract([a], {}, {}, env, 'en');
  const secretUrl = `https://example.com/${env.UNISEARCH_TAVILY_API_KEY}`;
  assert.doesNotMatch(
    JSON.stringify(
      extractResult(
        { results: [{ url: secretUrl, raw_content: '' }], failed_results: [] },
        single,
        'en',
      ),
    ),
    /fixture-tavily-key/,
  );
  for (const raw_content of ['', ' ', null, 2, undefined]) {
    const result = extractResult(
      { results: [{ url: a, raw_content }], failed_results: [] },
      single,
      'zh',
    );
    assert.equal(result.exitCode, 4);
    assert.equal(result.result.data, undefined);
    assert.equal(
      result.result.error?.code,
      typeof raw_content === 'string' ? 'UPSTREAM_ERROR' : 'INVALID_RESPONSE',
    );
    assert.equal(result.result.error?.details?.url, a);
    assert.equal(result.result.error?.details?.failures, undefined);
    assert.equal(result.result.error?.details?.http_status, undefined);
  }
  for (const error of ['', ' ', null, 2, undefined])
    assert.equal(
      extractResult({ results: [], failed_results: [{ url: a, error }] }, single, 'en').result.error
        ?.code,
      'INVALID_RESPONSE',
    );
  for (const broken of [
    {},
    { results: [] },
    { results: [], failed_results: null },
    { results: [null], failed_results: [] },
    { results: [{ raw_content: 'A' }], failed_results: [] },
    { results: [], failed_results: [{ url: 'bad', error: 'bad' }] },
  ])
    assert.throws(() => extractResult(broken, single, 'en'), AppError);
  const mismatch = extractResult(
    { results: [{ url: a, raw_content: '# A' }], failed_results: [] },
    request,
    'en',
  );
  assert.equal(mismatch.exitCode, 4);
  assert.equal(mismatch.result.error?.details?.reason, 'result_count_mismatch');
  assert.equal(mismatch.result.data?.results[0].text, '# A');
  assert.equal(
    extractResult({ results: [], failed_results: [] }, single, 'en').result.error?.details?.reason,
    'result_count_mismatch',
  );
  const malformed = extractResult(
    { results: [{ url: a }], failed_results: [{ url: b }] },
    request,
    'en',
  );
  assert.equal(malformed.result.error?.code, 'INVALID_RESPONSE');
  const mixed = extractResult(
    { results: [{ url: a, raw_content: '' }], failed_results: [{ url: b }] },
    request,
    'en',
  );
  assert.equal(mixed.result.error?.code, 'UPSTREAM_ERROR');
  const snippets = prepareExtract([a], { query: ' q ' }, {}, env, 'en');
  assert.equal(snippets.body.chunks_per_source, 3);
  assert.equal(
    extractResult(
      { results: [{ url: a, raw_content: 'A [...] B' }], failed_results: [] },
      snippets,
      'en',
    ).result.data?.content_type,
    'snippets',
  );
  assert.equal(
    extractResult({ results: [{ url: a, raw_content: '' }], failed_results: [] }, snippets, 'zh')
      .result.error?.message,
    '未取得相关片段',
  );
});

test('Tavily standalone diagnostics redact all configured credentials without rewriting content', async () => {
  const values = {
    providers: { tavily: { api_key: 'saved-tavily-key' }, exa: { api_key: 'peer-exa-key' } },
  };
  const secrets = [env.UNISEARCH_TAVILY_API_KEY, 'saved-tavily-key', 'peer-exa-key'];
  const message = secrets.join(' ');
  const request = prepareExtract([a, b], {}, values, env, 'en');
  const result = await requestExtract(
    request,
    { signal: new AbortController().signal },
    'en',
    async () =>
      Response.json({
        request_id: message,
        results: [{ url: a, raw_content: message }],
        failed_results: [{ url: 'https://example.org/peer-exa-key', error: message }],
      }),
  );
  assert.equal(result.outcome.exitCode, 6);
  assert.equal(result.outcome.result.data?.results[0].text, message);
  for (const secret of secrets)
    assert.ok(!JSON.stringify(result.outcome.result.error).includes(secret));

  const failed = await requestMap(
    prepareMap(a, {}, values, env, 'en'),
    { signal: new AbortController().signal },
    'en',
    async () =>
      Response.json(
        { detail: { error: message } },
        { status: 401, headers: { 'x-request-id': message } },
      ),
  );
  assert.equal(failed.outcome.result.error?.code, 'AUTHENTICATION_ERROR');
  for (const secret of secrets) assert.ok(!JSON.stringify(failed).includes(secret));
});

test('Native HTTP errors preserve status classification, diagnostic IDs, validation messages and no redirects', async (t) => {
  const root = temporary(t);
  let calls = 0;
  let status = 200;
  let payload: unknown = {};
  const base = await server(t, (_req, res) => {
    calls++;
    res.writeHead(status, { location: '/redirect', 'x-request-id': 'header-id' });
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
  const environment = { ...env, UNISEARCH_TAVILY_BASE_URL: base };
  for (const [http, code, exit] of [
    [400, 'INVALID_ARGUMENT', 2],
    [422, 'INVALID_ARGUMENT', 2],
    [401, 'AUTHENTICATION_ERROR', 3],
    [432, 'QUOTA_EXCEEDED', 4],
    [433, 'QUOTA_EXCEEDED', 4],
    [403, 'ACCESS_DENIED', 3],
    [408, 'TIMEOUT', 4],
    [429, 'RATE_LIMITED', 4],
    [500, 'UPSTREAM_ERROR', 4],
    [502, 'UPSTREAM_ERROR', 4],
    [503, 'UPSTREAM_ERROR', 4],
    [504, 'TIMEOUT', 4],
    [302, 'UPSTREAM_ERROR', 4],
    [404, 'UPSTREAM_ERROR', 4],
    [402, 'UPSTREAM_ERROR', 4],
    [501, 'UPSTREAM_ERROR', 4],
  ] as const) {
    status = http;
    payload = { detail: { error: 'upstream detail' }, request_id: 'body-id' };
    const before = calls;
    const result = await cli(root, ['tavily', 'map', a, '--format=json', '--verbose'], environment);
    const json = JSON.parse(result.out);
    assert.equal(result.exit, exit);
    assert.equal(json.error.code, code);
    assert.equal(json.error.details.http_status, http);
    assert.equal(json.error.details.request_id, 'body-id');
    assert.equal(json.meta.attempts[0].request_id, undefined);
    assert.equal(calls, before + 1);
  }
  status = 403;
  payload = { detail: { error: '[403] URL is not supported' } };
  const unsupported = JSON.parse(
    (await cli(root, ['tavily', 'map', a, '--format=json'], environment)).out,
  );
  assert.equal(unsupported.error.code, 'UPSTREAM_ERROR');
  assert.equal(unsupported.error.details.reason, 'url_unsupported');
  assert.equal(
    JSON.parse((await cli(root, ['tavily', 'search', 'q', '--format=json'], environment)).out).error
      .code,
    'ACCESS_DENIED',
  );
  for (const http of [401, 432])
    for (const bad of [
      '<html>error</html>',
      { detail: { error: 2 } },
      { detail: { error: 'error' }, request_id: 2 },
    ]) {
      status = http;
      payload = bad;
      const json = JSON.parse(
        (await cli(root, ['tavily', 'search', 'q', '--format=json'], environment)).out,
      );
      assert.equal(json.error.code, http === 401 ? 'AUTHENTICATION_ERROR' : 'QUOTA_EXCEEDED');
      assert.equal(json.error.details.reason, 'error_body_invalid');
      assert.equal(json.error.details.request_id, 'header-id');
    }
  status = 422;
  payload = {
    detail: [
      {
        loc: ['body', 'max_results'],
        msg: 'Too large',
        type: 'less_than_equal',
        input: 'private-input',
        ctx: { secret: 'private-context' },
      },
    ],
  };
  const validation = await cli(root, ['tavily', 'search', 'q', '--format=json'], environment);
  assert.match(validation.out, /body.max_results: Too large/);
  assert.doesNotMatch(validation.out, /private-input|private-context/);
  status = 400;
  payload = {
    detail: { error: 'Invalid URLs', failed_results: [{ url: a, error: 'Cannot extract' }] },
  };
  const rejected = JSON.parse(
    (await cli(root, ['tavily', 'extract', a, '--format=json'], environment)).out,
  );
  assert.equal(rejected.error.code, 'INVALID_ARGUMENT');
  assert.equal(rejected.error.details.failures[0].url, a);
  status = 200;
  for (const bad of ['{', '<html>', { results: [], request_id: 2 }]) {
    payload = bad;
    assert.equal(
      (await cli(root, ['tavily', 'search', 'q', '--format=json'], environment)).exit,
      4,
    );
  }
  for (const id of [undefined, null, '']) {
    payload = { results: [], request_id: id };
    const json = JSON.parse(
      (await cli(root, ['tavily', 'search', 'q', '--format=json', '--verbose'], environment)).out,
    );
    assert.equal(json.meta.attempts[0].request_id, 'header-id');
  }
});

test('Extract partial and successful data save with compact diagnostics; failures preserve old files and IO errors retain data', async (t) => {
  const root = temporary(t);
  const output = join(root, '结果 file');
  let empty = false;
  let calls = 0;
  const base = await server(t, (_req, res) => {
    calls++;
    res.end(
      JSON.stringify({
        results: empty ? [] : [{ url: a, raw_content: '# A\n\nArticle A.' }],
        failed_results: [
          {
            url: b,
            error: `Failed\nAuthorization: Bearer hidden\n${env.UNISEARCH_TAVILY_API_KEY}\n# diagnostic`,
          },
        ],
        request_id: 'extract-id',
      }),
    );
  });
  const environment = { ...env, UNISEARCH_TAVILY_BASE_URL: base };
  for (const format of ['json', 'markdown']) {
    const result = await cli(
      root,
      ['tavily', 'extract', a, b, '--format', format, '--output', output, '--verbose'],
      environment,
    );
    assert.equal(result.exit, 6);
    assert.equal(result.out, '');
    const saved = readFileSync(output, 'utf8');
    assert.doesNotMatch(saved + result.err, /fixture-tavily-key|hidden/);
    if (format === 'json') {
      const json = JSON.parse(saved);
      assert.equal(json.error.details.provider, undefined);
      assert.equal(json.error.details.http_status, undefined);
      assert.equal(json.error.details.request_id, 'extract-id');
      assert.equal(json.meta.attempts[0].http_status, 200);
      assert.equal(json.meta.attempts[0].request_id, undefined);
      assert.equal(json.error.details.failures[0].provider, undefined);
    } else {
      assert.match(saved, /\n> # diagnostic/);
      assert.match(result.err, /HTTP 200/);
      assert.doesNotMatch(saved, /Attempt|elapsed_ms/);
    }
  }
  empty = true;
  writeFileSync(output, 'old');
  const failed = await cli(
    root,
    ['tavily', 'extract', b, '--format=json', '--output', output],
    environment,
  );
  assert.equal(failed.exit, 4);
  assert.equal(readFileSync(output, 'utf8'), 'old');
  empty = false;
  t.mock.method(fs, 'rename', async () => {
    throw Object.assign(new Error(), { code: 'EACCES' });
  });
  const io = await cli(
    root,
    ['tavily', 'extract', a, b, '--format=json', '--output', output],
    environment,
  );
  assert.equal(io.exit, 5);
  const result = JSON.parse(io.out);
  assert.equal(result.error.code, 'FILE_IO_ERROR');
  assert.equal(result.data.results[0].text, '# A\n\nArticle A.');
  assert.equal(readFileSync(output, 'utf8'), 'old');
  assert.deepEqual(readdirSync(root), ['结果 file']);
  assert.equal(calls, 4);
  const renderFailure = render(
    { result: { status: 'success', data: { provider: 'tavily', results: [a] } }, exitCode: 0 },
    {
      language: 'en',
      format: 'markdown',
      renderData() {
        throw new Error();
      },
    },
  );
  assert.equal(renderFailure.outcome.exitCode, 5);
  assert.deepEqual(renderFailure.outcome.result.data?.results, [a]);
});

test('All three real operations reuse bounded retry budgets and never retry parsed content failures', async (t) => {
  const root = temporary(t);
  let calls = 0;
  let status = 503;
  const base = await server(t, (_req, res) => {
    calls++;
    res.writeHead(status, { 'Retry-After': '0' });
    res.end(
      JSON.stringify(
        status === 200
          ? { results: [{ url: a, raw_content: '' }], failed_results: [] }
          : { detail: { error: 'temporary' } },
      ),
    );
  });
  for (const operation of ['search', 'extract', 'map'])
    for (const retries of [undefined, '0']) {
      const before = calls;
      const result = await cli(
        root,
        ['tavily', operation, operation === 'search' ? 'q' : a, '--format=json', '--verbose'],
        { ...env, UNISEARCH_TAVILY_BASE_URL: base, UNISEARCH_RETRIES: retries },
      );
      assert.equal(result.exit, 4);
      assert.equal(calls - before, retries === '0' ? 1 : 3);
    }
  status = 200;
  const before = calls;
  assert.equal(
    (
      await cli(root, ['tavily', 'extract', a], {
        ...env,
        UNISEARCH_TAVILY_BASE_URL: base,
        UNISEARCH_RETRIES: '2',
      })
    ).exit,
    4,
  );
  assert.equal(calls - before, 1);
});

test('Late timeouts cannot re-enable retries after Tavily content, response or permanent transport failures', async () => {
  const request = prepareExtract([a], {}, {}, env, 'en');
  const cases: [string, typeof fetch, number][] = [
    ['invalid response', async () => Response.json({}), 1],
    [
      'empty content',
      async () => Response.json({ results: [{ url: a, raw_content: ' ' }], failed_results: [] }),
      1,
    ],
    [
      'permanent DNS failure',
      async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('fixture DNS failure'), { code: 'ENOTFOUND' }),
        });
      },
      1,
    ],
    ['temporary upstream failure', async () => Response.json({}, { status: 503 }), 2],
  ];
  for (const [name, transport, expectedCalls] of cases) {
    let now = 0;
    let calls = 0;
    const clock: ExecutionClock = {
      now: () => now,
      wallNow: () => 0,
      schedule: () => () => {},
      sleep: async (ms) => {
        now += ms;
      },
    };
    const outcome = await executeRequest(
      async (context) => {
        calls++;
        const result = await requestExtract(request, context, 'en', transport);
        // The executor checks the deadline after the provider classifies the result.
        now += 60001;
        return result;
      },
      {
        provider: 'tavily',
        timeout: 300,
        retries: 1,
        requestLimit: tavilyRequestLimits.extract,
        signal: new AbortController().signal,
        language: 'en',
        record: {},
        clock,
      },
    );
    assert.equal(outcome.result.error?.code, 'TIMEOUT', name);
    assert.equal(outcome.result.error?.details?.timeout_scope, 'request', name);
    assert.equal(calls, expectedCalls, name);
  }
});

test('Controlled clocks enforce 30/60/160-second request caps, fixed upstream timeouts and shared Retry-After budget', async () => {
  for (const operation of ['search', 'extract', 'map'] as const)
    for (const timeout of [0.5, 600]) {
      let now = 0;
      let timers = 0;
      const caps: number[] = [];
      const clock: ExecutionClock = {
        now: () => now,
        wallNow: () => Date.UTC(2026, 8, 30) + now,
        schedule(ms) {
          caps.push(ms);
          timers++;
          return () => {
            timers--;
          };
        },
        async sleep(ms) {
          now += ms;
        },
      };
      const common = {
        provider: 'tavily',
        timeout,
        retries: 1,
        requestLimit: tavilyRequestLimits[operation],
        language: 'en' as const,
        signal: new AbortController().signal,
        record: {},
        clock,
      };
      const transport: typeof fetch = async () => {
        now += Math.min(timeout * 1000, tavilyRequestLimits[operation] * 1000);
        return Response.json({
          results: operation === 'extract' ? [{ url: a, raw_content: 'Body.' }] : [],
          failed_results: [],
        });
      };
      let outcome: Outcome;
      switch (operation) {
        case 'search':
          outcome = await executeRequest(
            (ctx) => requestTavilySearch(search(), ctx, 'en', transport),
            common,
          );
          break;
        case 'extract':
          outcome = await executeRequest(
            (ctx) => requestExtract(prepareExtract([a], {}, {}, env, 'en'), ctx, 'en', transport),
            common,
          );
          break;
        case 'map':
          outcome = await executeRequest(
            (ctx) => requestMap(prepareMap(a, {}, {}, env, 'en'), ctx, 'en', transport),
            common,
          );
          break;
      }
      assert.equal(outcome.result.error?.code, 'TIMEOUT');
      assert.equal(
        outcome.result.error?.details?.timeout_scope,
        timeout === 0.5 ? 'total' : 'request',
      );
      assert.deepEqual(
        caps,
        Array(timeout === 0.5 ? 1 : 2).fill(
          Math.min(timeout * 1000, tavilyRequestLimits[operation] * 1000),
        ),
      );
      assert.equal(timers, 0);
    }
  for (const retryAfter of ['2', 'Wed, 30 Sep 2026 00:00:02 GMT', 'invalid', '999']) {
    let now = 0;
    const waits: number[] = [];
    let calls = 0;
    const clock: ExecutionClock = {
      now: () => now,
      wallNow: () => Date.UTC(2026, 8, 30) + now,
      schedule: () => () => {},
      async sleep(ms) {
        waits.push(ms);
        now += ms;
      },
    };
    const outcome = await executeRequest(
      (ctx) =>
        requestMap(prepareMap(a, {}, {}, env, 'en'), ctx, 'en', async () => {
          calls++;
          return new Response(
            JSON.stringify(calls === 1 ? { detail: { error: 'busy' } } : { results: [a] }),
            { status: calls === 1 ? 503 : 200, headers: { 'Retry-After': retryAfter } },
          );
        }),
      {
        provider: 'tavily',
        timeout: 10,
        retries: 2,
        requestLimit: 160,
        signal: new AbortController().signal,
        language: 'en',
        record: {},
        clock,
      },
    );
    const expectedWait = retryAfter === 'invalid' ? 1000 : 2000;
    assert.deepEqual(waits, retryAfter === '999' ? [] : [expectedWait]);
    assert.equal(calls, retryAfter === '999' ? 1 : 2);
    if (retryAfter === '999')
      assert.equal(outcome.result.error?.details?.reason, 'retry_wait_exceeds_budget');
  }
});

test('Known transport errors remain separate from programming errors and invalid UTF-8', async () => {
  for (const [code, expected, retry] of [
    ['EAI_AGAIN', 'NETWORK_ERROR', true],
    ['ECONNRESET', 'NETWORK_ERROR', true],
    ['ENOTFOUND', 'NETWORK_ERROR', false],
    ['CERT_HAS_EXPIRED', 'NETWORK_ERROR', false],
    ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT', true],
  ] as const) {
    const result = await requestMap(
      prepareMap(a, {}, {}, env, 'en'),
      { signal: new AbortController().signal },
      'en',
      async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('private native'), { code }),
        });
      },
    );
    assert.equal(result.outcome.result.error?.code, expected);
    assert.equal(result.retry, retry);
    assert.doesNotMatch(JSON.stringify(result), /private native/);
  }
  const internal = await requestTavilySearch(
    search(),
    { signal: new AbortController().signal },
    'en',
    async () => {
      throw new Error('private');
    },
  );
  assert.equal(internal.outcome.exitCode, 5);
  const invalid = await requestTavilySearch(
    search(),
    { signal: new AbortController().signal },
    'en',
    async () => new Response(new Uint8Array([255])),
  );
  assert.equal(invalid.outcome.result.error?.code, 'INVALID_RESPONSE');
});

test('Native slow bodies respect cancellation and non-retryable HTTP failures do not retry on body timeout', async (t) => {
  const root = temporary(t);
  let calls = 0;
  let status = 200;
  const base = await server(t, (_req, res) => {
    calls++;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.write('{');
  });
  for (const http of [200, 401, 432]) {
    status = http;
    const before = calls;
    const result = await cli(root, ['tavily', 'search', 'q', '--format=json', '--timeout', '0.1'], {
      ...env,
      UNISEARCH_TAVILY_BASE_URL: base,
      UNISEARCH_RETRIES: '2',
    });
    assert.equal(result.exit, 4);
    assert.equal(JSON.parse(result.out).error.code, 'TIMEOUT');
    assert.equal(calls - before, 1);
  }
  let now = 0;
  let expire: (() => void) | undefined;
  let fetches = 0;
  const clock: ExecutionClock = {
    now: () => now,
    wallNow: () => 0,
    schedule(_ms, callback) {
      expire = callback;
      return () => {};
    },
    async sleep() {
      throw new Error('must not retry');
    },
  };
  const result = await executeRequest(
    (ctx) =>
      requestTavilySearch(search(), ctx, 'en', async () => {
        fetches++;
        return new Response(
          new ReadableStream({
            start(controller) {
              ctx.signal.addEventListener('abort', () => controller.error(new Error('aborted')), {
                once: true,
              });
              setImmediate(() => {
                now = 30_000;
                expire!();
              });
            },
          }),
          { status: 401 },
        );
      }),
    {
      provider: 'tavily',
      requestLimit: 30,
      timeout: 300,
      retries: 2,
      signal: new AbortController().signal,
      language: 'en',
      record: {},
      clock,
    },
  );
  assert.equal(result.result.error?.details?.timeout_scope, 'request');
  assert.equal(fetches, 1);
});

test(
  'SIGINT terminates native requests and retry waits without replacing an existing output file',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const root = temporary(t);
    const output = join(root, 'old.json');
    writeFileSync(output, 'old');
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, '{}');
    for (const waiting of [false, true]) {
      let notify!: () => void;
      const arrived = new Promise<void>((done) => {
        notify = done;
      });
      let close!: () => void;
      const closed = new Promise<void>((done) => {
        close = done;
      });
      let calls = 0;
      const base = await server(t, (_req, res) => {
        calls++;
        res.on('close', close);
        if (waiting) {
          res.writeHead(503, { 'Retry-After': '30' });
          res.end('{"detail":{"error":"busy"}}');
        } else {
          res.writeHead(200);
          res.write('{');
        }
        notify();
      });
      const child = spawn(
        process.execPath,
        [resolve('dist/cli.js'), 'tavily', 'map', a, '--format=json', '--output', output],
        {
          cwd: root,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !key.startsWith('UNISEARCH_')),
            ),
            ...env,
            UNISEARCH_CONFIG_PATH: configPath,
            UNISEARCH_TAVILY_BASE_URL: base,
            UNISEARCH_RETRIES: '2',
          },
        },
      );
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      });
      const exited = once(child, 'exit');
      await Promise.race([
        arrived,
        exited.then(([code]) => {
          throw new Error(`CLI exited before requesting the fixture (${code}): ${out}${err}`);
        }),
      ]);
      if (waiting) await new Promise((done) => setTimeout(done, 100));
      child.kill('SIGINT');
      const [code] = await exited;
      await closed;
      assert.equal(code, 130, err);
      assert.equal(JSON.parse(out).error.code, 'CANCELLED');
      assert.equal(readFileSync(output, 'utf8'), 'old');
      assert.equal(calls, 1);
      assert.equal(err, '');
    }
  },
);
