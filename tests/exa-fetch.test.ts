import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createCli } from '../src/cli/program.js';
import {
  prepareFetch,
  requestFetch,
  exaOperations,
  exaRequestLimit,
} from '../src/providers/exa.js';
import type { FetchOptions } from '../src/providers/exa.js';
import { contentsData } from '../src/providers/exa-contents.js';
import { localStatus } from '../src/config/status.js';
import { executeRequest } from '../src/execution.js';
import type { ExecutionClock } from '../src/execution.js';
import { prepareRetrieval, retrieve } from '../src/retrieval.js';
import { capture, context, temporary } from './helpers.js';
import type { JsonObject } from '../src/result.js';

const a = 'https://example.org/a';
const b = 'https://example.org/b';
const page = { url: a, title: 'A', text: '# A\n\nBody.' };
const env = {
  UNISEARCH_EXA_API_KEY: 'fixture-exa-key',
  UNISEARCH_LANG: 'en',
  UNISEARCH_RETRIES: '0',
};
const prepare = (urls = [a], options: FetchOptions = {}, values = {}) =>
  prepareFetch(urls, options, values, env, 'en');
const parse = (body: unknown, urls = [a], highlights = false) =>
  contentsData(body, { urls, highlights }, 'en');

async function fixture(t: TestContext) {
  const root = temporary(t);
  const config = join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({ providers: { jina: { enabled: false }, anysearch: { enabled: false } } }),
  );
  const calls: { path: string; body: JsonObject }[] = [];
  const replies: Record<
    string,
    { status?: number; body?: unknown; headers?: Record<string, string> }
  > = {};
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (req.url === '/exa/contents')
      assert.equal(req.headers['x-api-key'], env.UNISEARCH_EXA_API_KEY);
    const reply = replies[req.url!] ?? {};
    res.writeHead(reply.status ?? 200, reply.headers);
    res.end(
      JSON.stringify(
        reply.body ??
          {
            '/exa/contents': { results: [page] },
            '/tavily/extract': {
              results: [{ url: a, raw_content: 'Tavily body' }],
              failed_results: [],
            },
            '/firecrawl/scrape': { success: true, data: { markdown: 'Firecrawl body' } },
            '/exa/search': { results: [] },
          }[req.url!],
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const environment = {
    ...env,
    UNISEARCH_CONFIG_PATH: config,
    UNISEARCH_EXA_BASE_URL: `${base}/exa`,
    UNISEARCH_TAVILY_API_KEY: 'fixture-tavily-key',
    UNISEARCH_TAVILY_BASE_URL: `${base}/tavily`,
    UNISEARCH_FIRECRAWL_API_KEY: 'fixture-firecrawl-key',
    UNISEARCH_FIRECRAWL_BASE_URL: `${base}/firecrawl`,
  };
  return {
    root,
    config,
    calls,
    replies,
    env: environment,
    save: (value: unknown) => writeFileSync(config, JSON.stringify(value)),
    async run(args: string[], extra = {}) {
      const channels = capture();
      const exit = await createCli('test', {
        config: context(root, { ...environment, ...extra }),
        channels,
      }).run(args);
      return { exit, ...channels, json: () => JSON.parse(channels.out) };
    },
  };
}

test('Exa contents preparation sends one native batch with per-URL options and preserves inputs', () => {
  assert.deepEqual(prepare([a, b, a]).body, {
    urls: [a, b, a],
    text: true,
    highlights: false,
    livecrawlTimeout: 10000,
  });
  assert.deepEqual(
    prepare([a], {
      maxLength: '1000000',
      includeHighlights: true,
      highlightsQuery: ' install + & ',
    }).body,
    {
      urls: [a],
      text: { maxCharacters: 1000000 },
      highlights: { query: ' install + & ' },
      livecrawlTimeout: 10000,
    },
  );
  assert.equal(prepare([a], { includeHighlights: true }).body.highlights, true);
  assert.equal(prepare([a], { highlightsQuery: 'q' }).highlights, true);
  const prefix = 'https://example.org/';
  const boundary = prefix + '😀'.repeat(2048 - prefix.length);
  assert.ok(prepare([boundary]));
  assert.ok(prepare(Array(100).fill(a)));
  assert.deepEqual(prepare([`${a},${b}`]).urls, [`${a},${b}`]);
  for (const urls of [
    [],
    Array(101).fill(a),
    [boundary + 'x'],
    ['relative'],
    ['https://u:p@example.org'],
    ['https://example.org/a b'],
  ])
    assert.throws(() => prepare(urls));
  for (const maxLength of ['0', '1000001', '1.5', '', 'Infinity'])
    assert.throws(() => prepare([a], { maxLength }));
  assert.throws(() => prepare([a], { highlightsQuery: ' ' }));
  const values = {
    providers: { exa: { fetch: { max_length: 'bad' }, search: { limit: 'also bad' } } },
  };
  assert.throws(() => prepare([a], { maxLength: '1' }, values));
  assert.throws(() => prepare([a], {}, values));
});

test('Exa contents independently retains text, highlights, dates, authors and acquisition sources', () => {
  const body = {
    results: [
      { ...page, url: b, author: 'Team', publishedDate: '2026-09-01', highlights: [' quote ', ''] },
    ],
    statuses: [{ id: a, status: 'success', source: 'cached' }],
  };
  const outcome = parse(body, [a], true);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(Object.keys(outcome.result.data!.results[0]!), [
    'url',
    'title',
    'published_date',
    'author',
    'highlights',
    'text',
  ]);
  assert.deepEqual(outcome.result.data, {
    provider: 'exa',
    results: [
      {
        url: b,
        title: 'A',
        text: page.text,
        author: 'Team',
        published_date: '2026-09-01',
        highlights: [' quote '],
      },
    ],
    content_sources: [{ url: a, source: 'cached' }],
  });
  assert.deepEqual(parse({ results: [page] }, [a], true).result.data?.results[0].missing_content, [
    'highlights',
  ]);
  for (const text of [undefined, null, '', ' ']) {
    const result = parse({ results: [{ ...page, text, highlights: ['quote'] }] }, [a], true);
    assert.equal(result.exitCode, 4);
    assert.equal(result.result.error?.code, 'CONTENT_UNAVAILABLE');
    assert.deepEqual(result.result.data?.results, [{ url: a, title: 'A', highlights: ['quote'] }]);
    assert.equal(result.result.error?.details?.http_status, undefined);
  }
  for (const bad of [
    { title: 1 },
    { author: {} },
    { publishedDate: false },
    { highlights: 2 },
    { highlights: ['good', false] },
  ]) {
    const result = parse({ results: [{ ...page, ...bad }] }, [a], true);
    assert.equal(result.result.error?.code, 'INVALID_RESPONSE');
    assert.equal(result.result.data?.results[0].text, page.text);
  }
  const textInvalid = parse({ results: [{ ...page, text: {}, highlights: ['quote'] }] }, [a], true);
  assert.equal(textInvalid.result.data?.results[0].highlights?.[0], 'quote');
  assert.equal(parse({ results: [{ ...page, text: '' }] }).result.data, undefined);
  assert.equal(parse({ results: [{ ...page, url: 'bad' }] }).result.data, undefined);
});

test('Exa contents enforces batch accounting while retaining complete usable results', () => {
  const failure = {
    id: b,
    status: 'error',
    error: { tag: 'CRAWL_TIMEOUT', httpStatusCode: 504 },
    source: 'crawled',
  };
  const mixed = parse({ results: [page], statuses: [{ id: a, status: 'success' }, failure] }, [
    a,
    b,
  ]);
  assert.equal(mixed.exitCode, 6);
  assert.equal(mixed.result.error?.code, 'PARTIAL_FAILURE');
  assert.deepEqual(mixed.result.error?.details?.failures?.[0].details, {
    content_source: 'crawled',
    upstream_code: 'CRAWL_TIMEOUT',
    page_status: 504,
  });
  const all = parse({ results: [], statuses: [{ id: a, status: 'error' }, failure] }, [a, b]);
  assert.equal(all.exitCode, 4);
  assert.equal(all.result.error?.code, 'CONTENT_UNAVAILABLE');
  assert.equal(all.result.error?.details?.failures?.length, 2);
  const single = parse({ results: [], statuses: [{ id: a, status: 'error', error: null }] });
  assert.equal(single.result.error?.details?.failures, undefined);
  assert.equal(single.result.error?.details?.url, a);
  assert.equal(parse({ results: [] }).result.error?.code, 'CONTENT_UNAVAILABLE');
  const duplicate = parse(
    {
      results: [page, page],
      statuses: [
        { id: a, status: 'success' },
        { id: a, status: 'success' },
      ],
    },
    [a, a],
  );
  assert.equal(duplicate.exitCode, 0);
  for (const [body, reason] of [
    [{ results: [page] }, 'result_count_mismatch'],
    [
      { results: [page, { ...page, url: b }], statuses: [{ id: a, status: 'success' }] },
      'status_result_mismatch',
    ],
    [
      {
        results: [page, page],
        statuses: [
          { id: a, status: 'success' },
          { id: a, status: 'success' },
        ],
      },
      'status_result_mismatch',
    ],
    [
      {
        results: [page, page],
        statuses: [
          { id: a, status: 'success' },
          { id: b, status: 'success', error: {} },
        ],
      },
      'status_result_mismatch',
    ],
    [
      {
        results: [page, page],
        statuses: [
          { id: a, status: 'success', source: 'invented' },
          { id: b, status: 'success' },
        ],
      },
      'status_result_mismatch',
    ],
    [
      { results: [page, page], statuses: [{ id: a, status: 'success' }, failure] },
      'result_count_mismatch',
    ],
  ] as const) {
    const result = parse(body, [a, b]);
    assert.equal(result.exitCode, 4);
    assert.equal(result.result.error?.code, 'INVALID_RESPONSE');
    assert.equal(result.result.error?.details?.reason, reason);
    assert.ok(result.result.data?.results.length);
  }
  const contradictory = parse({
    results: [page],
    statuses: [{ id: a, status: 'error', error: { tag: 'UNKNOWN' } }],
  });
  assert.equal(contradictory.result.error?.code, 'INVALID_RESPONSE');
  assert.equal(contradictory.result.error?.details?.causes?.[0].details?.upstream_code, 'UNKNOWN');
  const metadata = parse({
    results: [{ ...page, text: '' }],
    statuses: [{ id: a, status: 'success', source: 'cached' }],
  });
  assert.equal(metadata.result.data, undefined);
  assert.deepEqual(metadata.result.error?.details?.content_sources, [{ url: a, source: 'cached' }]);
});

test('Exa retains missing-highlight information independently of invalid metadata', () => {
  for (const highlights of [undefined, null, [], [' ', '']]) {
    const result = parse({ results: [{ ...page, author: {}, highlights }] }, [a], true);
    assert.equal(result.result.error?.code, 'INVALID_RESPONSE');
    assert.equal(result.result.data?.results[0].text, page.text);
    assert.deepEqual(result.result.data?.results[0].missing_content, ['highlights']);
  }
  const invalidHighlights = parse({ results: [{ ...page, highlights: {} }] }, [a], true);
  assert.equal(invalidHighlights.result.error?.code, 'INVALID_RESPONSE');
  assert.equal(invalidHighlights.result.data?.results[0].missing_content, undefined);
});

test('Exa contents CLI config, status, batch request and file outputs use public mechanisms', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['exa', 'fetch', '--help'],
    ['status', '--json'],
    ['config', 'get', 'providers.exa'],
  ])
    assert.equal((await f.run(args)).exit, 0);
  assert.equal(f.calls.length, 0);
  for (const args of [
    [],
    [a, '--max-length', '0'],
    [a, '--include-highlights', '--include-highlights'],
    [a, '--max-length', '1', '--max-length', '2'],
    [a, '--no-max-length'],
    [a, '--highlights-query', ' '],
    Array(101).fill(a),
  ])
    assert.equal((await f.run(['exa', 'fetch', ...args])).exit, 2);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.run(['config', 'set', 'providers.exa.fetch.max_length', '55'])).exit, 2);
  const saved = readFileSync(f.config, 'utf8');
  f.replies['/exa/contents'] = { body: { results: [page, { ...page, url: b }, page] } };
  const output = join(f.root, 'pages.json');
  const batch = await f.run([
    'exa',
    'fetch',
    a,
    b,
    a,
    '--max-length',
    '99',
    '--highlights-query',
    'q',
    '--output',
    output,
    '--format',
    'json',
    '--verbose',
  ]);
  assert.equal(batch.exit, 0);
  assert.equal(batch.out, '');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, {
    urls: [a, b, a],
    text: { maxCharacters: 99 },
    highlights: { query: 'q' },
    livecrawlTimeout: 10000,
  });
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).meta.attempts.length, 1);
  assert.equal(readFileSync(f.config, 'utf8'), saved);
  f.replies['/exa/contents'] = {
    body: {
      results: [page],
      statuses: [
        { id: a, status: 'success' },
        { id: b, status: 'error' },
      ],
    },
  };
  const partial = await f.run(['exa', 'fetch', a, b, '--output', output, '--format', 'json']);
  assert.equal(partial.exit, 6);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).status, 'partial');
  f.replies['/exa/contents'] = { body: { results: [] } };
  const retained = readFileSync(output, 'utf8');
  assert.equal((await f.run(['exa', 'fetch', a, '--output', output])).exit, 4);
  assert.equal(readFileSync(output, 'utf8'), retained);
  const before = f.calls.length;
  assert.equal(
    (await f.run(['exa', 'fetch', a, '--output', join(f.root, 'absent', 'out')])).exit,
    5,
  );
  assert.equal(f.calls.length, before);
  assert.equal(prepare().body.text, true);
  const statuses = localStatus(
    { providers: { exa: { fetch: { max_length: 'bad' } } } },
    env,
    'en',
    exaOperations,
  );
  assert.equal(statuses.services[0].state, 'invalid');
});

test('Exa complete URL failures never retry; HTTP failures use the common retry policy', async (t) => {
  const f = await fixture(t);
  for (const tag of [undefined, '', 'CRAWL_TIMEOUT', 'CRAWL_HTTP_401', 'UNKNOWN']) {
    f.replies['/exa/contents'] = {
      body: { results: [], statuses: [{ id: a, status: 'error', error: { tag } }] },
    };
    const before = f.calls.length;
    const result = await f.run(['exa', 'fetch', a, '--format=json', '--verbose'], {
      UNISEARCH_RETRIES: '2',
    });
    assert.equal(result.json().error.code, 'CONTENT_UNAVAILABLE');
    assert.equal(result.json().meta.attempts.length, 1);
    assert.equal(result.json().error.details.timeout_scope, undefined);
    assert.equal(f.calls.length, before + 1);
  }
  const request = prepareFetch([a], {}, {}, { ...f.env, UNISEARCH_RETRIES: '1' }, 'en');
  let now = 0;
  const caps: number[] = [];
  const waits: number[] = [];
  const time: ExecutionClock = {
    now: () => now,
    wallNow: () => 0,
    sleep: async (ms) => {
      now += ms;
      waits.push(ms);
    },
    schedule: (ms) => {
      caps.push(ms);
      return () => {};
    },
  };
  f.replies['/exa/contents'] = {
    status: 503,
    body: { error: 'busy' },
    headers: { 'retry-after': '1' },
  };
  let first = true;
  const outcome = await executeRequest(
    (ctx) =>
      requestFetch(request, ctx, 'en', async (...args) => {
        const response = await fetch(...args);
        if (first) {
          first = false;
          delete f.replies['/exa/contents'];
        }
        return response;
      }),
    {
      ...request,
      provider: 'exa',
      requestLimit: exaRequestLimit,
      signal: new AbortController().signal,
      language: 'en',
      clock: time,
      record: {},
    },
  );
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(caps, [30000, 30000]);
  for (const [status, code] of [
    [401, 'AUTHENTICATION_ERROR'],
    [403, 'ACCESS_DENIED'],
    [400, 'INVALID_ARGUMENT'],
    [404, 'UPSTREAM_ERROR'],
  ] as const) {
    f.replies['/exa/contents'] = { status, body: { error: 'failure' } };
    const before: number = f.calls.length;
    const result = await f.run(['exa', 'fetch', a, '--format=json'], { UNISEARCH_RETRIES: '2' });
    assert.equal(result.json().error.code, code);
    assert.equal(f.calls.length, before + 1);
  }
});

test('Unified fetch omits Exa length limits, respects default order and only checks actual candidates', async (t) => {
  const f = await fixture(t);
  const defaults = (await f.run(['config', 'get', 'fetch.providers'])).json().data
    .value as string[];
  assert.ok(defaults.indexOf('firecrawl') < defaults.indexOf('exa'));
  assert.ok(defaults.indexOf('exa') < defaults.indexOf('tavily'));
  assert.equal((await f.run(['fetch', a, '--format=json'])).json().data.provider, 'firecrawl');
  f.replies['/firecrawl/scrape'] = { status: 401, body: {} };
  const exa = await f.run(['fetch', a, '--format=json']);
  assert.equal(exa.json().data.provider, 'exa');
  assert.equal(f.calls.at(-1)?.body.text, true);
  assert.equal(f.calls.at(-1)?.body.highlights, false);
  f.save({
    providers: { exa: { enabled: false } },
    fetch: { providers: ['firecrawl', 'exa', 'tavily'] },
  });
  assert.equal((await f.run(['fetch', a, '--format=json'])).json().data.provider, 'tavily');
  f.save({ providers: { exa: { fetch: { max_length: 'bad' } } } });
  const before = f.calls.length;
  assert.equal((await f.run(['fetch', a])).exit, 3);
  assert.equal(f.calls.length, before);
  delete f.replies['/firecrawl/scrape'];
  assert.equal((await f.run(['fetch', a, '--no-fallback'])).exit, 0);
  f.save({ fetch: { providers: ['firecrawl', 'exa', 'tavily'] } });
  const long = a + 'x'.repeat(2048);
  assert.equal((await f.run(['fetch', long])).exit, 2);
  assert.equal((await f.run(['fetch', long, '--no-fallback'])).exit, 0);
  assert.equal((await f.run(['fetch', long], { UNISEARCH_EXA_API_KEY: undefined })).exit, 0);
  f.save({ fetch: { providers: [] } });
  assert.equal((await f.run(['fetch', a])).exit, 3);
});

test('Exa switches both ways with real operations and retains earlier data on terminal failures', async (t) => {
  const f = await fixture(t);
  const paths = { exa: '/exa/contents', tavily: '/tavily/extract', firecrawl: '/firecrawl/scrape' };
  for (const peer of ['tavily', 'firecrawl'] as const)
    for (const order of [
      ['exa', peer],
      [peer, 'exa'],
    ] as const) {
      f.save({ fetch: { providers: order } });
      const path = paths[order[0]];
      f.replies[path] = { status: 401, body: {} };
      const result = await f.run(['fetch', a, '--format=json']);
      assert.equal(result.exit, 0);
      assert.equal(result.json().data.provider, order[1]);
      assert.equal(result.json().meta.service_fallbacks[0].from, order[0]);
      delete f.replies[path];
    }
  f.save({ fetch: { providers: ['exa', 'tavily'] } });
  f.replies['/exa/contents'] = { body: { results: [page, page] } };
  f.replies['/tavily/extract'] = { status: 401, body: {} };
  const failed = await f.run(['fetch', a, '--format=json']);
  assert.equal(failed.json().data.results.length, 2);
  assert.equal(failed.json().data.provider, 'exa');
  assert.equal(failed.json().error.code, 'ALL_PROVIDERS_FAILED');
  const plan = prepareRetrieval(
    'fetch',
    a,
    {},
    { fetch: { providers: ['exa', 'tavily'] } },
    f.env,
    'en',
  );
  for (const terminal of ['internal', 'cancel', 'timeout'] as const) {
    const controller = new AbortController();
    let now = 0;
    const time: ExecutionClock = {
      now: () => now,
      wallNow: () => 0,
      sleep: async () => {},
      schedule: () => () => {},
    };
    const result = await retrieve(
      plan,
      controller.signal,
      'en',
      {},
      {
        clock: time,
        transport: async (...args) => {
          if (String(args[0]).includes('/tavily')) {
            if (terminal === 'internal') throw new Error('implementation bug');
            if (terminal === 'cancel') controller.abort();
            if (terminal === 'timeout') now = 300000;
          }
          return fetch(...args);
        },
      },
    );
    assert.equal(result.exitCode, { internal: 5, cancel: 130, timeout: 4 }[terminal]);
    assert.equal(result.result.data?.provider, 'exa');
  }
});

test('Exa diagnostics redact all configured secrets without rewriting retained page content', async (t) => {
  const f = await fixture(t);
  f.save({ providers: { exa: { api_key: 'old-key' } } });
  f.replies['/exa/contents'] = {
    body: {
      requestId: 'old-key fixture-tavily-key',
      results: [{ ...page, text: 'old-key is literal page text' }],
      statuses: [
        { id: a, status: 'success' },
        {
          id: b,
          status: 'error',
          error: { tag: 'old-key fixture-exa-key fixture-tavily-key Authorization: Bearer hidden' },
        },
      ],
    },
  };
  const result = await f.run(['exa', 'fetch', a, b, '--format=json', '--verbose']);
  assert.equal(result.exit, 6);
  assert.doesNotMatch(JSON.stringify(result.json().error), /old-key|fixture-.*key|hidden/);
  assert.equal(result.json().data.results[0].text, 'old-key is literal page text');
});
