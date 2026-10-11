import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createCli } from '../src/cli/program.js';
import * as firecrawl from '../src/providers/firecrawl.js';
import { mapData, scrapeData, searchData } from '../src/providers/firecrawl-response.js';
import { renderMap, renderScrape, renderSearch } from '../src/output/firecrawl.js';
import { localStatus } from '../src/config/status.js';
import { AppError } from '../src/errors.js';
import { executeRequest } from '../src/execution.js';
import type { AttemptContext, ExecutionClock } from '../src/execution.js';
import { redactError } from '../src/providers/transport.js';
import { prepareRetrieval, retrieve } from '../src/retrieval.js';
import { combinedSearch, prepareCombinedSearch } from '../src/search.js';
import type { JsonObject } from '../src/result.js';
import { capture, context, temporary } from './helpers.js';

const env = {
  UNISEARCH_FIRECRAWL_API_KEY: 'firecrawl-fixture-key',
  UNISEARCH_LANG: 'en',
  UNISEARCH_RETRIES: '0',
};
const safe = (value: string) => redactError(value, env.UNISEARCH_FIRECRAWL_API_KEY);
const search = (options: firecrawl.SearchOptions = {}, values = {}) =>
  firecrawl.prepareSearch(' query ', options, values, env, 'en');
const scrape = (options: firecrawl.ScrapeOptions = {}, values = {}) =>
  firecrawl.prepareScrape('https://example.org/page?q=1#part', options, values, env, 'en');
const map = (options: firecrawl.MapOptions = {}, values = {}) =>
  firecrawl.prepareMap('https://example.org/docs/', options, values, env, 'en');
const blankSearch = { success: true, data: { web: [] } };
const page = { success: true, data: { markdown: '# Page\n\nBody', metadata: { statusCode: 200 } } };
const blankMap = { success: true, links: [] };
const answer = {
  model: 'actual-model',
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Complete answer.' }],
    },
  ],
};

async function server(
  t: TestContext,
  listener: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const instance = createServer(listener);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise<void>((done, reject) =>
      instance.close((error) => (error ? reject(error) : done())),
    );
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
function errorCode(code: string) {
  return (error: unknown) => error instanceof AppError && error.code === code;
}
function attempt(): AttemptContext {
  return { signal: new AbortController().signal };
}
function transport(
  response: unknown,
  status = 200,
  headers: Record<string, string> = {},
): typeof fetch {
  return async () =>
    new Response(typeof response === 'string' ? response : JSON.stringify(response), {
      status,
      headers,
    });
}

test('Firecrawl operation defaults, exact v2 bodies and saved overrides stay independent', () => {
  assert.equal(search().url, 'https://api.firecrawl.dev/v2/search');
  assert.deepEqual(search().body, {
    query: ' query ',
    limit: 5,
    sources: ['web'],
    timeout: 60000,
    ignoreInvalidURLs: false,
    highlights: false,
  });
  assert.deepEqual(scrape().body, {
    url: 'https://example.org/page?q=1#part',
    formats: ['markdown'],
    onlyMainContent: true,
    maxAge: 172800000,
    waitFor: 0,
    timeout: 60000,
  });
  assert.deepEqual(map().body, {
    url: 'https://example.org/docs/',
    limit: 50,
    sitemap: 'include',
    includeSubdomains: false,
    ignoreQueryParameters: true,
    ignoreCache: false,
    timeout: 60000,
  });
  const values = {
    providers: {
      firecrawl: {
        base_url: 'http://localhost:8123/prefix/v2/',
        search: { limit: 8 },
        map: {
          limit: 100,
          sitemap: 'only',
        },
      },
    },
  };
  assert.equal(search({}, values).url, 'http://localhost:8123/prefix/v2/search');
  assert.equal(search({}, values).limit, 8);
  assert.deepEqual(search({ includeText: true }, values).body.scrapeOptions, {
    formats: ['markdown'],
    onlyMainContent: true,
    waitFor: 0,
    maxAge: 172800000,
    timeout: 60000,
  });
  assert.equal(search({ includeText: false, limit: '1' }, values).body.scrapeOptions, undefined);
  assert.equal(scrape({ maxAge: '0', onlyMainContent: false }, values).body.maxAge, 0);
  assert.equal(scrape({ onlyMainContent: false }, values).body.onlyMainContent, false);
  assert.deepEqual(map({}, values).body, {
    url: 'https://example.org/docs/',
    limit: 100,
    sitemap: 'only',
    includeSubdomains: false,
    ignoreQueryParameters: true,
    ignoreCache: false,
    timeout: 60000,
  });
  assert.equal(
    map(
      {
        limit: '1',
        sitemap: 'skip',
        includeSubdomains: false,
        ignoreQueryParameters: true,
        ignoreCache: true,
      },
      values,
    ).body.sitemap,
    'skip',
  );
  assert.equal(search({ timeout: 0.05 }).timeout, 0.05);
  assert.equal(search({ timeout: 0.05 }).body.timeout, 60000);
});

test('Firecrawl input boundaries and unsupported parameter combinations fail before a request', () => {
  for (const options of [
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { categories: 'research' },
    { categories: 'developer,pdf' },
    { categories: 'github' },
    { categories: '' },
    { categories: 'developer', includeText: true },
    { categories: 'developer', tbs: 'qdr:w' },
    { categories: 'developer', country: 'US' },
    { categories: 'developer', location: 'Paris' },
    { tbs: ' ' },
    { location: '' },
    { country: 'us' },
  ])
    assert.throws(() => search(options), errorCode('INVALID_ARGUMENT'));
  assert.throws(
    () => firecrawl.prepareSearch('x'.repeat(501), {}, {}, env, 'en'),
    errorCode('INVALID_ARGUMENT'),
  );
  assert.equal(
    firecrawl.prepareSearch('文'.repeat(500), {}, {}, env, 'en').body.query,
    '文'.repeat(500),
  );
  assert.deepEqual(search({ categories: 'developer' }).body.categories, ['developer']);
  assert.deepEqual(
    search({
      categories: 'pdf',
      country: 'US',
      tbs: 'qdr:m',
      location: 'San Francisco',
      includeText: true,
    }).body.categories,
    ['pdf'],
  );
  for (const waitFor of ['-1', '31', '0.5', 'Infinity'])
    assert.throws(() => scrape({ waitFor }), errorCode('INVALID_ARGUMENT'));
  assert.equal(scrape({ waitFor: '30' }).body.waitFor, 30000);
  assert.throws(
    () => scrape({ maxAge: String(Number.MAX_SAFE_INTEGER) }),
    errorCode('INVALID_ARGUMENT'),
  );
  assert.throws(() => scrape({ includeTag: [''] }), errorCode('INVALID_ARGUMENT'));
  for (const limit of ['0', '100001'])
    assert.throws(() => map({ limit }), errorCode('INVALID_ARGUMENT'));
  assert.equal(map({ limit: '100000' }).limit, 100000);
  assert.throws(() => map({ sitemap: 'only', search: 'auth' }), errorCode('INVALID_ARGUMENT'));
  for (const url of [
    'example.org',
    'file:///tmp/page',
    'https://user:pass@example.org',
    'https://example.org/a b',
  ])
    assert.throws(
      () => firecrawl.prepareScrape(url, {}, {}, env, 'en'),
      errorCode('INVALID_ARGUMENT'),
    );
});

test('Firecrawl URLs keep query and fragment at signs separate from credentials', () => {
  for (const url of [
    'https://example.org?email=dev@example.org',
    'https://example.org#@installation',
    'https://example.org/@team?email=dev@example.org#part',
    'https://example.org\\@team',
    'https:////example.org?email=dev@example.org',
  ]) {
    assert.equal(firecrawl.prepareScrape(url, {}, {}, env, 'en').target, url);
    assert.deepEqual(mapData({ success: true, links: [{ url }] }, 1, safe).links, [{ url }]);
  }
  for (const url of [
    'https://user:pass@example.org',
    'https://@example.org',
    'https://:@example.org',
    'https://\\@example.org',
    'https:////@example.org',
  ]) {
    assert.throws(
      () => firecrawl.prepareScrape(url, {}, {}, env, 'en'),
      errorCode('INVALID_ARGUMENT'),
    );
    assert.throws(
      () => mapData({ success: true, links: [{ url }] }, 1, safe),
      errorCode('INVALID_RESPONSE'),
    );
  }
});

test('Firecrawl config management saves only explicit values and status shares real operation requirements', async (t) => {
  const root = temporary(t);
  const file = join(root, 'settings.json');
  const config = context(root, { UNISEARCH_CONFIG_PATH: file, UNISEARCH_LANG: 'en' });
  for (const [name, value] of [
    ['base_url', 'http://127.0.0.1:8123/prefix/v2'],
    ['search.limit', '8'],
    ['map.limit', '100000'],
    ['map.sitemap', 'only'],
  ]) {
    const key = `providers.firecrawl.${name}`;
    assert.equal(
      await createCli('test', { config, channels: capture() }).run(['config', 'set', key, value]),
      0,
    );
    const channels = capture();
    assert.equal(await createCli('test', { config, channels }).run(['config', 'get', key]), 0);
    assert.equal(JSON.parse(channels.out).data.source, 'config');
  }
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.providers.firecrawl.api_key, undefined);
  assert.equal(saved.execution, undefined);
  const original = readFileSync(file, 'utf8');
  for (const [name, value] of [
    ['search.limit', '101'],
    ['map.limit', '100001'],
    ['map.sitemap', 'invalid'],
    ['scrape.max_age', '-1'],
  ])
    assert.equal(
      await createCli('test', { config, channels: capture() }).run([
        'config',
        'set',
        `providers.firecrawl.${name}`,
        value,
      ]),
      2,
    );
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(
    await createCli('test', { config, channels: capture() }).run([
      'config',
      'unset',
      'providers.firecrawl.map',
    ]),
    0,
  );
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).providers.firecrawl.map, undefined);
  const values = {
    providers: {
      firecrawl: { api_key: 'saved-key', search: { limit: -1 }, map: { limit: 'bad' } },
    },
  };
  assert.equal(search({ limit: '3' }, values).limit, 3);
  assert.equal(scrape({}, values).body.onlyMainContent, true);
  const status = localStatus(values, env, 'en', firecrawl.operations);
  assert.deepEqual(
    status.services[0].operations?.map((item) => [item.operation, item.state]),
    [
      ['search', 'invalid'],
      ['scrape', 'ready'],
      ['map', 'invalid'],
    ],
  );
  for (const [values, state] of [
    [{}, 'missing'],
    [{ providers: { firecrawl: { enabled: false } } }, 'disabled'],
    [{ providers: { firecrawl: { base_url: '?' } } }, 'invalid'],
  ] as const)
    assert.equal(localStatus(values, {}, 'en', firecrawl.operations).services[0].state, state);
  assert.throws(
    () => firecrawl.prepareSearch('q', {}, {}, { FIRECRAWL_API_KEY: 'legacy-key' }, 'en'),
    errorCode('MISSING_CONFIG'),
  );
  const channels = capture();
  const keyed = context(root, { ...env, UNISEARCH_CONFIG_PATH: file });
  assert.equal(
    await createCli('test', { config: keyed, channels }).run([
      'config',
      'get',
      'providers.firecrawl.api_key',
    ]),
    0,
  );
  assert.deepEqual(JSON.parse(channels.out).data, {
    key: 'providers.firecrawl.api_key',
    value: '[REDACTED]',
    source: 'UNISEARCH_FIRECRAWL_API_KEY',
  });
});

test('Firecrawl CLI help, invalid inputs and duplicate options never call HTTP', async (t) => {
  let calls = 0;
  const base = await server(t, (_req, res) => {
    calls++;
    res.end(JSON.stringify(blankSearch));
  });
  const root = temporary(t);
  const config = context(root, { ...env, UNISEARCH_FIRECRAWL_BASE_URL: base });
  const outputs: string[] = [];
  for (const args of [['firecrawl'], ['firecrawl', '--help']]) {
    const channels = capture();
    assert.equal(await createCli('test', { config, channels }).run(args), 0);
    for (const command of ['search', 'scrape', 'map'])
      assert.match(channels.out, new RegExp(`\\n  ${command} `));
    assert.doesNotMatch(channels.out, /\n  (crawl|batch|browser|doctor) /);
    outputs.push(channels.out);
  }
  assert.equal(outputs[0], outputs[1]);
  const bad = [
    ['search'],
    ['scrape'],
    ['map'],
    ['crawl', 'https://example.org'],
    ['search', 'q', '--limit', '0'],
    ['search', 'q', '--limit', '1', '--limit', '2'],
    ['search', 'q', '--no-include-text'],
    ['search', 'q', '--include-text', '--include-text'],
    ['search', 'q', '--sources', 'news'],
    ['search', 'q', '--categories', 'research'],
    ['scrape', 'https://example.org', '--only-main-content'],
    ['scrape', 'https://example.org', '--no-only-main-content', '--no-only-main-content'],
    ['scrape', 'https://example.org', '--wait-for', '31'],
    ['scrape', 'https://example.org', '--include-tag', ' '],
    ['map', 'https://example.org', '--include-subdomains', '--include-subdomains'],
    ['map', 'https://example.org', '--ignore-query-parameters'],
    ['map', 'https://example.org', '--no-ignore-query-parameters', '--no-ignore-query-parameters'],
    ['map', 'https://example.org', '--sitemap', 'only', '--search', 'blog'],
    ['map', 'https://example.org', '--ignore-cache', '--ignore-cache'],
  ];
  for (const args of bad) {
    const channels = capture();
    assert.equal(
      await createCli('test', { config, channels }).run([
        'firecrawl',
        args[0],
        '--format=json',
        ...args.slice(1),
      ]),
      2,
      args.join(' '),
    );
    if (args[0] === 'crawl') {
      assert.equal(channels.out, '');
      assert.match(channels.err, /^Error:/);
    } else {
      assert.equal(JSON.parse(channels.out).error.code, 'INVALID_ARGUMENT');
      assert.equal(channels.err, '');
    }
  }
  assert.equal(
    await createCli('test', { config, channels: capture() }).run(['status', '--json']),
    0,
  );
  assert.equal(calls, 0);
});

test('local HTTP Firecrawl CLI sends exact paths, Bearer auth, saved limits, explicit flags and repeated selectors', async (t) => {
  const requests: {
    url: string;
    method: string;
    headers: IncomingMessage['headers'];
    body: JsonObject;
  }[] = [];
  const base = await server(t, async (req, res) => {
    requests.push({
      url: req.url!,
      method: req.method!,
      headers: req.headers,
      body: await body(req),
    });
    let response: JsonObject;
    if (req.url!.endsWith('/search')) response = blankSearch;
    else if (req.url!.endsWith('/map')) response = blankMap;
    else response = page;
    res.end(JSON.stringify(response));
  });
  const root = temporary(t);
  const file = join(root, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      providers: {
        firecrawl: {
          search: { limit: 8 },
        },
      },
    }),
  );
  const config = context(root, {
    ...env,
    UNISEARCH_CONFIG_PATH: file,
    UNISEARCH_FIRECRAWL_BASE_URL: `${base}/proxy/v2/`,
  });
  const commands = [
    ['firecrawl', 'search', '--format=json', ' q ', '--include-text', '--timeout', '2'],
    [
      'firecrawl',
      'search',
      '--format=json',
      '--limit',
      '2',
      '--categories',
      'pdf',
      '--country',
      'US',
      '--tbs',
      'qdr:w',
      '--',
      '--help',
    ],
    [
      'firecrawl',
      'scrape',
      'https://example.org/文档?q=a#part',
      '--format=json',
      '--no-only-main-content',
      '--max-age',
      '0',
      '--wait-for',
      '2',
      '--include-tag',
      'main,article',
      '--include-tag',
      '.article',
      '--exclude-tag',
      'nav',
    ],
    ['firecrawl', 'scrape', 'https://example.org', '--format=json'],
    [
      'firecrawl',
      'map',
      'https://example.org/docs/',
      '--format=json',
      '--include-subdomains',
      '--no-ignore-query-parameters',
    ],
    [
      'firecrawl',
      'map',
      'https://example.org/docs/',
      '--format=json',
      '--limit',
      '1',
      '--sitemap',
      'skip',
      '--search',
      'auth',
      '--ignore-cache',
    ],
  ];
  for (const args of commands) {
    const channels = capture();
    assert.equal(await createCli('test', { config, channels }).run(args), 0, channels.out);
    assert.equal(JSON.parse(channels.out).status, 'success');
  }
  assert.equal(requests.length, commands.length);
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, `Bearer ${env.UNISEARCH_FIRECRAWL_API_KEY}`);
    assert.equal(request.headers.accept, 'application/json');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.body.timeout, 60000);
    assert.equal(request.body.format, undefined);
  }
  assert.equal(requests[0].url, '/proxy/v2/search');
  assert.equal(requests[0].body.limit, 8);
  assert.equal(requests[0].body.query, ' q ');
  assert.ok(requests[0].body.scrapeOptions);
  assert.deepEqual(requests[1].body, {
    query: '--help',
    limit: 2,
    sources: ['web'],
    timeout: 60000,
    ignoreInvalidURLs: false,
    highlights: false,
    categories: ['pdf'],
    country: 'US',
    tbs: 'qdr:w',
  });
  assert.deepEqual(requests[2].body, {
    url: 'https://example.org/文档?q=a#part',
    formats: ['markdown'],
    onlyMainContent: false,
    maxAge: 0,
    waitFor: 2000,
    includeTags: ['main,article', '.article'],
    excludeTags: ['nav'],
    timeout: 60000,
  });
  assert.equal(requests[3].body.onlyMainContent, true);
  assert.equal(requests[4].body.includeSubdomains, true);
  assert.equal(requests[4].body.ignoreQueryParameters, false);
  assert.deepEqual(requests[5].body, {
    url: 'https://example.org/docs/',
    limit: 1,
    search: 'auth',
    sitemap: 'skip',
    includeSubdomains: false,
    ignoreQueryParameters: true,
    ignoreCache: true,
    timeout: 60000,
  });
});

test('Firecrawl search retains useful metadata, missing text and warnings without duplicate payloads', () => {
  const data = searchData(
    {
      success: true,
      warning: 'Notice',
      warnings: ['Notice', 'Second'],
      data: {
        web: [
          {
            url: 'https://example.org/report',
            title: 'Report',
            description: 'Summary',
            markdown: '# Full\n\nContent',
            metadata: {
              url: 'https://example.org/report.pdf',
              statusCode: 200,
              title: 'Duplicate',
              sourceURL: 'https://example.org/report',
              numPages: 3,
              totalPages: 12,
              creditsUsed: 100,
            },
            warning: `Key ${env.UNISEARCH_FIRECRAWL_API_KEY}`,
          },
          { url: 'https://example.org/empty', markdown: ' \n' },
          {
            url: 'https://example.org/failure',
            markdown: 'Error page',
            metadata: { statusCode: 404, error: 'Not Found' },
          },
        ],
      },
    },
    { limit: 5, includeText: true },
    safe,
  );
  assert.deepEqual(data, {
    provider: 'firecrawl',
    warnings: ['Notice', 'Second'],
    results: [
      {
        url: 'https://example.org/report',
        title: 'Report',
        description: 'Summary',
        text: '# Full\n\nContent',
        final_url: 'https://example.org/report.pdf',
        content_truncation: { parsed_pages: 3, total_pages: 12 },
        warnings: ['Key [REDACTED]'],
      },
      { url: 'https://example.org/empty', missing_content: ['text'] },
      {
        url: 'https://example.org/failure',
        missing_content: ['text'],
        content_error: { page_status: 404, message: 'Not Found' },
      },
    ],
  });
  assert.equal(renderSearch(data, 'zh').includes('Error page'), false);
  assert.match(renderSearch(data, 'zh'), /正文已解析 3 页，文档共 12 页/);
  assert.match(renderSearch(data, 'en'), /Page status: 404/);
  assert.deepEqual(
    searchData(
      {
        success: true,
        data: { web: [{ url: 'https://example.org', metadata: 5, markdown: false }] },
      },
      { limit: 1, includeText: false },
      safe,
    ),
    { provider: 'firecrawl', results: [{ url: 'https://example.org' }] },
  );
  for (const response of [
    { data: { web: [] } },
    { success: true, data: [] },
    { success: true, data: {} },
    { success: true, data: { web: [{ url: '' }] } },
    { success: true, data: { web: [{ url: 'https://example.org', title: 1 }] } },
    { success: true, data: { web: [{ url: 'https://example.org', markdown: 1 }] } },
    {
      success: true,
      data: {
        web: [
          {
            url: 'https://example.org',
            markdown: 'text',
            metadata: { totalPages: 1, numPages: 2 },
          },
        ],
      },
    },
    { success: true, data: { web: [] }, warnings: [5] },
  ])
    assert.throws(
      () => searchData(response, { limit: 1, includeText: true }, safe),
      errorCode('INVALID_RESPONSE'),
    );
  assert.deepEqual(searchData(blankSearch, { limit: 1, includeText: true }, safe), {
    provider: 'firecrawl',
    results: [],
  });
});

test('Firecrawl scrape separates page failures, unavailable text and malformed responses', () => {
  const url = 'https://example.org/docs';
  const data = scrapeData(
    {
      success: true,
      data: {
        markdown: '# Guide\n\n```sh\nnode --version\n```',
        metadata: {
          title: ['Guide', 'API'],
          sourceURL: url,
          url: `${url}/`,
          statusCode: 304,
          contentType: 'text/html',
          numPages: 2,
          totalPages: 2,
        },
        warning: 'Source notice',
      },
    },
    url,
    safe,
  );
  assert.deepEqual(data, {
    provider: 'firecrawl',
    url,
    final_url: `${url}/`,
    title: 'Guide · API',
    text: '# Guide\n\n```sh\nnode --version\n```',
    content_type: 'text/html',
    warnings: ['Source notice'],
  });
  assert.equal(data.page_status, undefined);
  assert.equal(data.content_truncation, undefined);
  assert.ok(renderScrape(data, 'zh').endsWith(data.text));
  for (const statusCode of [301, 403, 404, 500])
    assert.throws(
      () =>
        scrapeData(
          { success: true, data: { markdown: 'Error page', metadata: { statusCode } } },
          url,
          safe,
        ),
      errorCode('CONTENT_UNAVAILABLE'),
    );
  assert.throws(
    () =>
      scrapeData(
        {
          success: true,
          data: { markdown: 'Body', metadata: { statusCode: 200, error: 'Failed' } },
        },
        url,
        safe,
      ),
    errorCode('CONTENT_UNAVAILABLE'),
  );
  assert.throws(
    () => scrapeData({ success: true, data: { markdown: ' \n' } }, url, safe),
    errorCode('CONTENT_UNAVAILABLE'),
  );
  for (const doc of [
    {},
    { markdown: null },
    { markdown: false },
    { markdown: 'Body', metadata: { title: [3] } },
    { markdown: 'Body', metadata: { statusCode: '200' } },
  ])
    assert.throws(
      () => scrapeData({ success: true, data: doc }, url, safe),
      errorCode('INVALID_RESPONSE'),
    );
  assert.deepEqual(scrapeData({ success: true, data: { markdown: 'Body' } }, url, safe), {
    provider: 'firecrawl',
    url,
    text: 'Body',
  });
});

test('Firecrawl map keeps links and coverage warnings without inferring fields or locally filtering', () => {
  const data = mapData(
    {
      success: true,
      links: [
        { url: 'https://example.org/docs', title: 'Docs', description: 'Reference' },
        { url: 'https://example.org/path?q=1' },
        { url: 'https://example.org/path?q=1' },
      ],
      warning: 'Coverage is limited',
    },
    3,
    safe,
  );
  assert.equal(data.links.length, 3);
  assert.equal(data.links[1].title, undefined);
  assert.equal(
    renderMap(data, 'zh'),
    '来源：Firecrawl\n\n上游提示：Coverage is limited\n\n1. [Docs](https://example.org/docs)\n   Reference\n2. [https://example.org/path?q=1](https://example.org/path?q=1)\n3. [https://example.org/path?q=1](https://example.org/path?q=1)',
  );
  assert.deepEqual(mapData(blankMap, 1, safe), { provider: 'firecrawl', links: [] });
  for (const response of [
    { success: true, data: { links: [] } },
    { success: true, links: ['https://example.org'] },
    { success: true, links: [{ url: 'ftp://example.org' }] },
    { success: true, links: [{ url: 'https://example.org', description: {} }] },
    { success: true, links: [{ url: 'https://example.org' }, { url: 'https://example.org/2' }] },
  ])
    assert.throws(() => mapData(response, 1, safe), errorCode('INVALID_RESPONSE'));
});

test('Firecrawl HTTP and structured errors preserve classifications and retry eligibility', async () => {
  const cases: [number, unknown, string, boolean][] = [
    [400, { error: 'Bad Request' }, 'INVALID_ARGUMENT', false],
    [401, '<html>Denied</html>', 'AUTHENTICATION_ERROR', false],
    [402, { error: 'Insufficient credits' }, 'QUOTA_EXCEEDED', false],
    [403, { error: 'Forbidden' }, 'ACCESS_DENIED', false],
    [408, { code: 'SCRAPE_TIMEOUT' }, 'TIMEOUT', true],
    [429, { error: 'Rate limit exceeded' }, 'RATE_LIMITED', true],
    [429, { error: 'Payment Required: Insufficient credits' }, 'QUOTA_EXCEEDED', false],
    [500, { code: 'SCRAPE_SITE_ERROR', error: 'Bad page' }, 'CONTENT_UNAVAILABLE', false],
    [500, { code: 'SCRAPE_JOB_CANCELLED' }, 'UPSTREAM_ERROR', false],
    [502, { error: 'Bad gateway' }, 'UPSTREAM_ERROR', true],
    [503, 'unavailable', 'UPSTREAM_ERROR', true],
    [504, {}, 'TIMEOUT', true],
    [422, { code: 'INVALID_REQUEST' }, 'INVALID_ARGUMENT', false],
    [422, { error: 'unknown extraction error' }, 'UPSTREAM_ERROR', false],
    [302, {}, 'UPSTREAM_ERROR', false],
    [404, {}, 'UPSTREAM_ERROR', false],
    [200, { success: false, error: 'unknown' }, 'UPSTREAM_ERROR', false],
    [200, '{broken', 'INVALID_RESPONSE', false],
    [200, {}, 'INVALID_RESPONSE', false],
  ];
  for (const [status, payload, code, retry] of cases) {
    const context = attempt();
    const result = await firecrawl.requestScrape(
      scrape(),
      context,
      'en',
      transport(payload, status, { 'x-request-id': 'request-1' }),
    );
    assert.equal(result.outcome.result.error?.code, code, `${status}: ${JSON.stringify(payload)}`);
    assert.equal(result.retry, retry);
    assert.equal(result.outcome.result.error?.details?.http_status, status);
    assert.equal(result.outcome.result.error?.details?.request_id, 'request-1');
    assert.equal(result.outcome.result.error?.details?.operation, 'scrape');
  }
  const result = await firecrawl.requestMap(
    map(),
    attempt(),
    'en',
    transport({ success: false, code: 'MAP_TIMEOUT' }),
  );
  assert.equal(result.outcome.result.error?.code, 'TIMEOUT');
  const failure = await firecrawl.requestSearch(
    search(),
    attempt(),
    'en',
    transport(
      { error: `key ${env.UNISEARCH_FIRECRAWL_API_KEY}\nAuthorization: Bearer other-secret` },
      401,
    ),
  );
  assert.doesNotMatch(JSON.stringify(failure), /firecrawl-fixture-key|other-secret/);
});

test('Firecrawl standalone diagnostics redact all configured credentials without rewriting content', async () => {
  const values = {
    providers: {
      firecrawl: { api_key: 'saved-firecrawl-key' },
      exa: { api_key: 'peer-exa-key' },
    },
  };
  const secrets = [env.UNISEARCH_FIRECRAWL_API_KEY, 'saved-firecrawl-key', 'peer-exa-key'];
  const message = secrets.join(' ');
  const request = scrape({}, values);
  const failed = await firecrawl.requestScrape(
    request,
    attempt(),
    'en',
    transport({ error: message }, 401, { 'x-request-id': message }),
  );
  for (const secret of secrets) assert.ok(!JSON.stringify(failed).includes(secret));
  assert.equal(failed.outcome.result.error?.code, 'AUTHENTICATION_ERROR');

  const result = await firecrawl.requestScrape(
    request,
    attempt(),
    'en',
    transport({ success: true, data: { markdown: message, warning: message } }),
  );
  assert.equal(result.outcome.exitCode, 0);
  assert.equal(result.outcome.result.data?.text, message);
  assert.deepEqual(result.outcome.result.data?.warnings, ['[REDACTED] [REDACTED] [REDACTED]']);
});

test('Firecrawl service switching retains cancellation policy when its upstream code is redacted', async () => {
  const url = 'https://example.org/page';
  const values = {
    fetch: { providers: ['firecrawl', 'exa'] },
    providers: { exa: { api_key: 'SCRAPE_JOB_CANCELLED' } },
  };
  for (const code of ['SCRAPE_JOB_CANCELLED', 'TEMPORARY_ERROR']) {
    const plan = prepareRetrieval('fetch', url, {}, values, env, 'en');
    const calls: string[] = [];
    const result = await retrieve(
      plan,
      attempt().signal,
      'en',
      {},
      {
        transport: async (input) => {
          const path = new URL(String(input)).pathname;
          calls.push(path);
          if (path.endsWith('/scrape'))
            return Response.json({ success: false, code }, { status: 500 });
          return Response.json({ results: [{ url, title: 'Page', text: 'Page body' }] });
        },
      },
    );
    if (code === 'SCRAPE_JOB_CANCELLED') {
      assert.equal(result.exitCode, 4);
      assert.equal(result.result.error?.code, 'UPSTREAM_ERROR');
      assert.equal(result.result.error?.details?.upstream_code, '[REDACTED]');
      assert.deepEqual(calls, ['/v2/scrape']);
    } else {
      assert.equal(result.exitCode, 0);
      assert.equal(result.result.data?.provider, 'exa');
      assert.deepEqual(calls, ['/v2/scrape', '/contents']);
    }
  }
});

test('late timeout handling preserves retry decisions learned from Firecrawl responses and transport errors', async () => {
  const permanentFailure: typeof fetch = async () => {
    const cause = Object.assign(new Error('fixture DNS failure'), { code: 'ENOTFOUND' });
    throw new TypeError('fetch failed', { cause });
  };
  const cases: [typeof fetch, number][] = [
    [transport({ error: 'Insufficient credits' }, 429), 1],
    [transport('{broken', 200), 1],
    [permanentFailure, 1],
    [transport({ error: 'Temporarily unavailable' }, 503), 2],
  ];
  for (const [fetcher, expectedCalls] of cases) {
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
    const result = await executeRequest(
      async (context) => {
        calls++;
        const response = await firecrawl.requestScrape(scrape(), context, 'en', fetcher);
        // The executor observes its deadline after the response has been classified.
        now += 90001;
        return response;
      },
      {
        provider: 'firecrawl',
        timeout: 300,
        retries: 1,
        requestLimit: 90,
        signal: attempt().signal,
        language: 'en',
        record: {},
        clock,
      },
    );
    assert.equal(result.result.error?.code, 'TIMEOUT');
    assert.equal(result.result.error?.details?.timeout_scope, 'request');
    assert.equal(calls, expectedCalls);
  }
});

test('Firecrawl local HTTP retries keep the body, honor Retry-After and save one full result', async (t) => {
  const bodies: JsonObject[] = [];
  const base = await server(t, async (req, res) => {
    bodies.push(await body(req));
    if (bodies.length === 1) {
      res.writeHead(429, { 'Retry-After': '0' });
      res.end(JSON.stringify({ success: false, error: 'Rate limited' }));
    } else
      res.end(
        JSON.stringify({
          success: true,
          links: [{ url: 'https://example.org/docs', title: 'Docs' }],
        }),
      );
  });
  const root = temporary(t);
  const output = join(root, '结果.json');
  const channels = capture();
  const config = context(root, {
    ...env,
    UNISEARCH_RETRIES: '2',
    UNISEARCH_FIRECRAWL_BASE_URL: base,
  });
  assert.equal(
    await createCli('test', { config, channels }).run([
      'firecrawl',
      'map',
      'https://example.org',
      '--format=json',
      '--verbose',
      '--output',
      output,
    ]),
    0,
  );
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  const result = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(result.meta.attempts.length, 2);
  assert.equal(result.meta.attempts[0].wait_source, 'retry_after');
  assert.equal(result.data.links[0].title, 'Docs');
  assert.equal(channels.out, '');
  assert.doesNotMatch(readFileSync(output, 'utf8'), /firecrawl-fixture-key/);
});

test('Firecrawl has no retries for empty content, no requests on output preparation failure and no redirect following', async (t) => {
  let calls = 0;
  let redirect = false;
  const base = await server(t, (_req, res) => {
    calls++;
    if (redirect) {
      res.writeHead(302, { Location: '/elsewhere' });
      res.end();
    } else res.end(JSON.stringify({ success: true, data: { markdown: '' } }));
  });
  const root = temporary(t);
  const output = join(root, 'existing.md');
  writeFileSync(output, 'original');
  const config = context(root, {
    ...env,
    UNISEARCH_RETRIES: '2',
    UNISEARCH_FIRECRAWL_BASE_URL: base,
  });
  const args = ['firecrawl', 'scrape', 'https://example.org', '--output', output];
  assert.equal(await createCli('test', { config, channels: capture() }).run(args), 4);
  assert.equal(readFileSync(output, 'utf8'), 'original');
  assert.equal(calls, 1);
  assert.equal(
    await createCli('test', { config, channels: capture() }).run([
      ...args.slice(0, 3),
      '--output',
      join(root, 'missing', 'file'),
    ]),
    5,
  );
  assert.equal(calls, 1);
  redirect = true;
  assert.equal(await createCli('test', { config, channels: capture() }).run(args), 4);
  assert.equal(calls, 2);
  assert.deepEqual(readdirSync(root), ['existing.md']);
});

test('Firecrawl total deadlines abort complete body reads on all three real CLI operations', async (t) => {
  const base = await server(t, (_req, res) => {
    res.writeHead(200, { 'x-request-id': 'slow-body' });
    res.write('{"success":true,');
  });
  const root = temporary(t);
  const config = context(root, { ...env, UNISEARCH_FIRECRAWL_BASE_URL: base });
  for (const operation of ['search', 'scrape', 'map']) {
    const channels = capture();
    assert.equal(
      await createCli('test', { config, channels }).run([
        'firecrawl',
        operation,
        operation === 'search' ? 'q' : 'https://example.org',
        '--timeout',
        '0.05',
        '--format=json',
      ]),
      4,
    );
    const error = JSON.parse(channels.out).error;
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.details.timeout_scope, 'total');
    assert.equal(error.details.http_status, 200);
    assert.equal(error.details.request_id, 'slow-body');
  }
});

test('Firecrawl per-operation caps and Retry-After waits use the existing deadline machinery', async () => {
  let now = 0;
  const caps: number[] = [];
  const waits: number[] = [];
  const clock: ExecutionClock = {
    now: () => now,
    wallNow: () => Date.UTC(2026, 8, 30),
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    schedule: (ms) => {
      caps.push(ms);
      return () => {};
    },
  };
  for (const operation of ['search', 'scrape', 'map'] as const) {
    now = 0;
    const record = {};
    const cap = firecrawl.requestLimits[operation];
    let calls = 0;
    const responses = { search: blankSearch, scrape: page, map: blankMap };
    const fetcher: typeof fetch = async (_url, init) => {
      assert.equal(JSON.parse(init!.body as string).timeout, 60000);
      return new Response(JSON.stringify(responses[operation]));
    };
    const result = await executeRequest<JsonObject>(
      async (context) => {
        calls++;
        now += (cap + 1) * 1000;
        if (operation === 'search')
          return firecrawl.requestSearch(search(), context, 'en', fetcher);
        if (operation === 'scrape')
          return firecrawl.requestScrape(scrape(), context, 'en', fetcher);
        return firecrawl.requestMap(map(), context, 'en', fetcher);
      },
      {
        provider: 'firecrawl',
        timeout: 300,
        retries: 0,
        requestLimit: cap,
        signal: attempt().signal,
        language: 'en',
        record,
        clock,
      },
    );
    assert.equal(result.result.error?.details?.timeout_scope, 'request');
    assert.equal(calls, 1);
    assert.equal(caps.at(-1), operation === 'scrape' ? 90000 : 60000);
  }
  now = 0;
  const result = await executeRequest(
    (context) =>
      firecrawl.requestSearch(
        search(),
        context,
        'en',
        transport({ error: 'Rate limited' }, 429, { 'Retry-After': '60' }),
      ),
    {
      provider: 'firecrawl',
      timeout: 5,
      retries: 2,
      requestLimit: 60,
      signal: attempt().signal,
      language: 'en',
      record: {},
      clock,
    },
  );
  assert.equal(result.result.error?.code, 'RATE_LIMITED');
  assert.equal(result.result.error?.details?.reason, 'retry_wait_exceeds_budget');
  assert.deepEqual(waits, []);
});

test(
  'SIGINT cancels Firecrawl HTTP and retains the original output file',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const root = temporary(t);
    const configFile = join(root, 'settings.json');
    writeFileSync(configFile, '{}');
    const output = join(root, 'existing.md');
    writeFileSync(output, 'original');
    let requested!: () => void;
    const received = new Promise<void>((done) => {
      requested = done;
    });
    const base = await server(t, (_req, res) => {
      res.writeHead(200);
      res.write('{"success":true,');
      requested();
    });
    const child = spawn(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'firecrawl',
        'scrape',
        'https://example.org',
        '--format=json',
        '--output',
        output,
      ],
      {
        cwd: root,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('UNISEARCH_')),
          ),
          ...env,
          UNISEARCH_FIRECRAWL_BASE_URL: base,
          UNISEARCH_CONFIG_PATH: configFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (value) => {
      stdout += value;
    });
    child.stderr.on('data', (value) => {
      stderr += value;
    });
    const closed = once(child, 'close');
    await received;
    child.kill('SIGINT');
    const [code] = await closed;
    assert.equal(code, 130, stderr);
    assert.equal(JSON.parse(stdout).error.code, 'CANCELLED');
    assert.equal(readFileSync(output, 'utf8'), 'original');
    assert.deepEqual(readdirSync(root), ['existing.md', 'settings.json']);
  },
);

test('root search concurrently executes real model, Exa and Firecrawl with saved settings and stable ordering', async (t) => {
  const held: ServerResponse[] = [];
  const requests: { url: string; body: JsonObject }[] = [];
  const base = await server(t, async (req, res) => {
    requests.push({ url: req.url!, body: await body(req) });
    held.push(res);
    if (held.length === 3) {
      for (let i = 2; i >= 0; i--) {
        let response: JsonObject;
        if (requests[i].url === '/model/responses') response = answer;
        else if (requests[i].url === '/exa/search') response = { results: [] };
        else response = blankSearch;
        held[i].end(JSON.stringify(response));
      }
    }
  });
  const root = temporary(t);
  const file = join(root, 'settings.json');
  writeFileSync(file, JSON.stringify({ providers: { firecrawl: { search: { limit: 9 } } } }));
  const config = context(root, {
    ...env,
    UNISEARCH_CONFIG_PATH: file,
    UNISEARCH_MODEL_API_KEY: 'model-key',
    UNISEARCH_MODEL_BASE_URL: `${base}/model`,
    UNISEARCH_MODEL_ID: 'requested-model',
    UNISEARCH_EXA_API_KEY: 'exa-key',
    UNISEARCH_EXA_BASE_URL: `${base}/exa`,
    UNISEARCH_FIRECRAWL_BASE_URL: `${base}/firecrawl`,
  });
  for (const order of ['firecrawl,exa', 'exa,firecrawl']) {
    held.length = 0;
    requests.length = 0;
    const channels = capture();
    assert.equal(
      await createCli('test', { config, channels }).run([
        'search',
        ' q ',
        '--extra-sources',
        order,
        '--timeout',
        '1',
        '--format=json',
        '--verbose',
      ]),
      0,
      channels.out,
    );
    const result = JSON.parse(channels.out);
    assert.deepEqual(
      result.data.extra_sources.map((item: { provider: string }) => item.provider),
      order.split(','),
    );
    assert.equal(result.data.answer.model, 'actual-model');
    assert.deepEqual(
      result.meta.attempts.map((item: { provider: string }) => item.provider),
      ['model', ...order.split(',')],
    );
    const request = requests.find((request) => request.url === '/firecrawl/search')!.body;
    assert.equal(request.limit, 9);
    assert.equal(request.query, ' q ');
    assert.equal(request.scrapeOptions, undefined);
  }
});

test('root Firecrawl supplemental failures preserve other data and validate all prerequisites first', async (t) => {
  let calls = 0;
  let modelOk = true;
  let firecrawlOk = true;
  const base = await server(t, (req, res) => {
    calls++;
    const model = req.url!.startsWith('/model');
    if (model && modelOk) res.end(JSON.stringify(answer));
    else if (!model && firecrawlOk) res.end(JSON.stringify(blankSearch));
    else {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
  });
  const root = temporary(t);
  const settings = {
    ...env,
    UNISEARCH_MODEL_API_KEY: 'model-key',
    UNISEARCH_MODEL_BASE_URL: `${base}/model`,
    UNISEARCH_MODEL_ID: 'model',
    UNISEARCH_FIRECRAWL_BASE_URL: `${base}/firecrawl`,
  };
  for (const [model, extra, expected, status] of [
    [true, true, 0, 'success'],
    [true, false, 6, 'partial'],
    [false, true, 3, 'error'],
    [false, false, 3, 'error'],
  ] as const) {
    modelOk = model;
    firecrawlOk = extra;
    const channels = capture();
    assert.equal(
      await createCli('test', { config: context(root, settings), channels }).run([
        'search',
        'q',
        '--extra-sources',
        'firecrawl',
        '--format=json',
      ]),
      expected,
    );
    const result = JSON.parse(channels.out);
    assert.equal(result.status, status);
    assert.equal(!!result.data?.answer, model);
    assert.equal(!!result.data?.extra_sources, extra);
  }
  calls = 0;
  for (const sources of ['firecrawl,firecrawl', 'firecrawl,', ' firecrawl'])
    assert.equal(
      await createCli('test', { config: context(root, settings), channels: capture() }).run([
        'search',
        'q',
        '--extra-sources',
        sources,
      ]),
      2,
    );
  const noKey = { ...settings, UNISEARCH_FIRECRAWL_API_KEY: undefined };
  assert.equal(
    await createCli('test', { config: context(root, noKey), channels: capture() }).run([
      'search',
      'q',
      '--extra-sources',
      'firecrawl',
    ]),
    3,
  );
  assert.equal(calls, 0);
});

test('root search redacts all known credentials in Firecrawl diagnostics while preserving source content', async () => {
  const settings = {
    ...env,
    UNISEARCH_MODEL_API_KEY: 'fixture-model-secret',
    UNISEARCH_MODEL_BASE_URL: 'https://model.test',
    UNISEARCH_MODEL_ID: 'model',
    UNISEARCH_FIRECRAWL_BASE_URL: 'https://firecrawl.test',
    UNISEARCH_EXA_API_KEY: 'fixture-exa-secret',
  };
  const savedKey = 'fixture-saved-firecrawl-secret';
  const values = {
    providers: { firecrawl: { api_key: savedKey } },
  };
  const plan = prepareCombinedSearch('q', { extraSources: 'firecrawl' }, values, settings, 'en');
  const sourceText = `Source text mentioning ${settings.UNISEARCH_MODEL_API_KEY}`;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).includes('model.test')) return new Response(JSON.stringify(answer));
    return new Response(
      JSON.stringify({
        success: true,
        warnings: [
          `key=${settings.UNISEARCH_MODEL_API_KEY}`,
          `key=${settings.UNISEARCH_FIRECRAWL_API_KEY}`,
          `key=${settings.UNISEARCH_EXA_API_KEY}`,
          `key=${savedKey}`,
        ],
        data: {
          web: [
            {
              url: 'https://page.test/content',
              title: 'Source title',
              description: sourceText,
              markdown: sourceText,
            },
          ],
        },
      }),
    );
  };
  const outcome = await combinedSearch(plan, attempt().signal, 'en', {}, { transport: fetcher });
  assert.equal(outcome.exitCode, 0);
  const source = outcome.result.data?.extra_sources?.[0];
  assert.ok(source?.provider === 'firecrawl');
  assert.deepEqual(source.data.warnings, ['key=[REDACTED]']);
  assert.equal(source.data.results[0].title, 'Source title');
  assert.equal(source.data.results[0].description, sourceText);
  assert.equal(source.data.results[0].text, undefined);
});

test('unexpected Firecrawl programming errors stop the combined invocation and retain completed Exa data', async () => {
  const values = { providers: { model: { model: { id: 'model' } } } };
  const settings = {
    ...env,
    UNISEARCH_MODEL_API_KEY: 'model-key',
    UNISEARCH_MODEL_BASE_URL: 'http://fixture/model',
    UNISEARCH_EXA_API_KEY: 'exa-key',
    UNISEARCH_EXA_BASE_URL: 'http://fixture/exa',
    UNISEARCH_FIRECRAWL_BASE_URL: 'http://fixture/firecrawl',
  };
  const plan = prepareCombinedSearch(
    'q',
    { extraSources: 'exa,firecrawl' },
    values,
    settings,
    'en',
  );
  let exaDone!: () => void;
  const finished = new Promise<void>((resolve) => {
    exaDone = resolve;
  });
  let aborted = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes('/exa/')) {
      const response = new Response('{"results":[]}');
      const read = response.arrayBuffer.bind(response);
      response.arrayBuffer = async () => {
        const bytes = await read();
        setImmediate(exaDone);
        return bytes;
      };
      return response;
    }
    if (String(url).includes('/firecrawl/')) {
      await finished;
      throw new Error('programming defect');
    }
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  };
  const result = await combinedSearch(plan, attempt().signal, 'en', {}, { transport: fetcher });
  assert.equal(result.exitCode, 5);
  assert.equal(result.result.error?.code, 'INTERNAL_ERROR');
  assert.equal(aborted, true);
  assert.deepEqual(result.result.data?.extra_sources, [{ provider: 'exa', data: { results: [] } }]);
});
