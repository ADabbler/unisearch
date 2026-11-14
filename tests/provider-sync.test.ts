import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCli } from '../src/cli/program.js';
import * as ctx7 from '../src/providers/context7.js';
import * as exa from '../src/providers/exa.js';
import * as firecrawl from '../src/providers/firecrawl.js';
import { searchData as firecrawlData } from '../src/providers/firecrawl-response.js';
import { prepareTavilySearch } from '../src/providers/tavily.js';
import * as tinyfish from '../src/providers/tinyfish.js';
import { renderContext7 } from '../src/output/context7.js';
import { renderCombinedSearch } from '../src/output/search.js';
import { renderSearch as renderFirecrawl } from '../src/output/firecrawl.js';
import { prepareCombinedSearch, combinedSearch } from '../src/search.js';
import { capture, context, temporary } from './helpers.js';

const env = {
  UNISEARCH_EXA_API_KEY: 'fixture-exa',
  UNISEARCH_FIRECRAWL_API_KEY: 'fixture-firecrawl',
  UNISEARCH_TAVILY_API_KEY: 'fixture-tavily',
  UNISEARCH_TINYFISH_API_KEY: 'fixture-tinyfish',
  UNISEARCH_RETRIES: '0',
};
const attempt = () => ({ signal: new AbortController().signal });
const response =
  (body: unknown, headers: Record<string, string> = {}): typeof fetch =>
  async () =>
    Response.json(body, { headers });
const code = {
  rank: 2,
  codeId: 'https://example.org/code',
  codeTitle: 'Code',
  codeDescription: 'Example',
  codeList: [{ language: 'ts', code: 'example();' }],
};
const docs = { codeSnippets: [code], infoSnippets: [{ rank: 1, content: 'First explanation' }] };
const version = {
  libraryId: '/example/lib/v2.3.1',
  requested: '2.0.0',
  served: 'v2.3.1',
  status: 'unverified',
};

test('Context7 preserves served versions and cross-type ranks; unverified versions fail with data', async () => {
  const data = ctx7.docsData({ ...docs, version }, '/example/lib/v2.0.0');
  assert.equal(data.library_id, version.libraryId);
  assert.equal(data.version?.status, 'unverified');
  const markdown = renderContext7(data, 'en');
  assert.ok(markdown.indexOf('First explanation') < markdown.indexOf('example();'));
  assert.match(markdown, /2\.0\.0 → v2\.3\.1 · unverified/);
  const request = ctx7.prepare('docs', '/example/lib/v2.0.0', 'query', undefined, {}, {}, 'en', {
    language: 'Ruby',
  });
  assert.equal(new URL(request.url).searchParams.get('language'), 'Ruby');
  const result = await ctx7.request(request, attempt(), 'en', response({ ...docs, version }));
  assert.equal(result.retry, false);
  assert.equal(result.outcome.exitCode, 4);
  assert.deepEqual(result.outcome.result.data, data);
  assert.equal(result.outcome.result.error?.code, 'UPSTREAM_ERROR');
});

test('Context7 v3 preserves actual libraries, rules, per-library versions and partial headers', async () => {
  const request = ctx7.prepareSearch(
    'query',
    { library: ['example', '/example/lib@2'], libraryVersion: '2', language: 'TypeScript' },
    {},
    {},
    'en',
  );
  const url = new URL(request.url);
  assert.equal(url.pathname, '/api/v3/search');
  assert.deepEqual(url.searchParams.getAll('library'), ['example', '/example/lib@2']);
  assert.equal(url.searchParams.get('version'), '2');
  assert.equal(request.apiKey, undefined);
  const body = {
    codeSnippets: [{ ...code, libraryId: '/actual/source' }],
    infoSnippets: [],
    version: { status: 'verified', libraries: [version] },
    rules: {
      libraries: [
        { libraryId: '/actual/source', libraryOwn: ['Own rule'], libraryTeam: ['Team rule'] },
      ],
    },
  };
  const result = await ctx7.request(
    request,
    attempt(),
    'en',
    response(body, { 'X-Context7-Search-Version': 'unverified' }),
  );
  assert.equal(result.outcome.exitCode, 4);
  const data = result.outcome.result.data as ctx7.DocsData;
  assert.equal(data.code_snippets[0].library_id, '/actual/source');
  assert.equal(data.library_id, undefined);
  assert.match(renderContext7(data, 'en'), /Own rule/);
  const partial = await ctx7.request(
    request,
    attempt(),
    'en',
    response(
      { codeSnippets: [], infoSnippets: [] },
      { 'X-Context7-Search-Status': 'partial', 'X-Context7-Search-Reason': 'partialSearchFailure' },
    ),
  );
  assert.equal(partial.outcome.exitCode, 4);
  assert.equal(partial.outcome.result.data?.search_reason, 'partialSearchFailure');
  for (const options of [
    { library: Array(5).fill('lib') },
    { libraryVersion: 'canary' },
    { language: '' },
  ])
    assert.throws(() => ctx7.prepareSearch('query', options, {}, {}, 'en'));
});

test('Context7 fetch distinguishes paging, truncation, relevance and unavailable content checks', async () => {
  const body = {
    url: 'https://example.org/page',
    title: 'Page',
    content: '# Start',
    offset: 10,
    totalLength: 100,
    nextOffset: 17,
    truncated: true,
    untrusted: true,
    contentCheck: 'unavailable',
  };
  const request = ctx7.prepareFetch(body.url, { tokens: '100', offset: '10' }, {}, {}, 'en');
  assert.equal(new URL(request.url).searchParams.get('offset'), '10');
  const result = await ctx7.request(
    request,
    attempt(),
    'en',
    response(body, { 'X-Context7-Content-Check': 'unavailable' }),
  );
  assert.equal(result.outcome.exitCode, 0);
  const data = result.outcome.result.data as ctx7.FetchData;
  assert.equal(data.next_offset, 17);
  assert.equal(data.truncated, true);
  assert.equal(data.content_check, 'unavailable');
  assert.match(renderContext7(data, 'en'), /Next character position: 17/);
  assert.doesNotMatch(renderContext7(data, 'en'), /passed/);
  const highlights = ctx7.fetchData(
    {
      url: body.url,
      title: '',
      highlights: [{ text: 'Relevant section', relevance: 0.9 }],
      untrusted: true,
      contentCheck: 'passed',
    },
    true,
  );
  assert.equal(highlights.highlights?.[0].relevance, 0.9);
  assert.equal(highlights.text, undefined);
  for (const [options, key] of [
    [{ tokens: '99' }, 'ctx7Tokens'],
    [{ tokens: '10001' }, 'ctx7Tokens'],
    [{ offset: '-1' }, 'ctx7Offset'],
    [{ query: 'q', offset: '0' }, 'ctx7OffsetConflict'],
  ] as const)
    assert.throws(() => ctx7.prepareFetch(body.url, options, {}, {}, 'en'), {
      code: 'INVALID_ARGUMENT',
      key,
    });
  assert.throws(() => ctx7.fetchData({ ...body, contentCheck: 'unknown' }, false));
});

test('Context7 unavailable responses distinguish page reading from documentation lookup', async () => {
  const page = ctx7.prepareFetch('https://example.org/page', {}, {}, {}, 'en');
  for (const status of [404, 422, 502]) {
    const result = await ctx7.request(page, attempt(), 'en', async () =>
      Response.json({ error: 'page_unavailable', message: 'Page unavailable' }, { status }),
    );
    assert.equal(result.outcome.result.error?.code, 'CONTENT_UNAVAILABLE');
    assert.equal(result.outcome.result.error?.message, 'Context7 could not read the target page');
    assert.equal(result.retry, false);
  }
  const searched = await ctx7.request(
    ctx7.prepareSearch('q', {}, {}, {}, 'en'),
    attempt(),
    'en',
    async () =>
      Response.json(
        { error: 'no_documentation_found', message: 'No matching documentation' },
        { status: 404 },
      ),
  );
  assert.equal(searched.outcome.result.error?.code, 'CONTENT_UNAVAILABLE');
  assert.equal(searched.outcome.result.error?.message, 'Context7 found no matching documentation');
});

test('Exa notices survive aggregation; relaxed restrictions fail once and unknown codes are retained', async () => {
  const notice = {
    code: 'RESTRICTIONS_RELAXED',
    path: '/query',
    message: 'Quoted restriction was relaxed.',
    details: { restriction: 'quote' },
  };
  const body = {
    results: [{ title: 'Page', url: 'https://example.org', highlights: ['Relevant paragraph'] }],
    notices: [notice],
    warnings: [{ code: 'FUTURE_WARNING', path: '/field', message: 'fixture-exa ignored field' }],
    output: { content: 'Synthesized answer', grounding: [] },
  };
  const plan = prepareCombinedSearch('query', { sources: 'exa' }, {}, env, 'en');
  let calls = 0;
  const result = await combinedSearch(
    plan,
    attempt().signal,
    'en',
    {},
    {
      transport: async () => {
        calls++;
        return Response.json(body);
      },
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(calls, 1);
  assert.ok(result.result.data);
  const source = result.result.data.sources[0];
  assert.equal(source.provider, 'exa');
  if (source.provider === 'exa') assert.deepEqual(source.data.notices, [notice]);
  assert.doesNotMatch(JSON.stringify(result.result.data), /fixture-exa/);
  assert.match(renderCombinedSearch(result.result.data, 'en'), /RESTRICTIONS\\_RELAXED/);
  assert.match(renderCombinedSearch(result.result.data, 'en'), /FUTURE\\_WARNING/);
  const unknown = await exa.requestSearch(
    exa.prepareSearch('q', {}, {}, env, 'en'),
    attempt(),
    'en',
    response({ ...body, notices: [{ ...notice, code: 'FUTURE_NOTICE' }] }),
  );
  assert.equal(unknown.outcome.exitCode, 0);
  for (const searchType of ['fast', 'instant'])
    assert.throws(() => exa.prepareSearch('q', { searchType }, {}, env, 'en'));
});

test('Firecrawl accepts research/pdf and host filters while preserving category and description', () => {
  const prepare = (options: firecrawl.SearchOptions) =>
    firecrawl.prepareSearch('q', options, {}, env, 'en');
  assert.deepEqual(
    prepare({ categories: 'research,pdf', includeDomains: 'example.org,docs.example.org' }).body
      .categories,
    ['research', 'pdf'],
  );
  assert.deepEqual(prepare({ excludeDomains: 'example.org' }).body.excludeDomains, ['example.org']);
  for (const options of [
    { categories: 'gov,research' },
    { categories: 'gov', country: 'US' },
    { categories: 'gov', includeDomains: 'example.org' },
    { includeDomains: 'https://example.org' },
    { includeDomains: 'example.org/path' },
    { includeDomains: 'example.org', excludeDomains: 'other.org' },
  ])
    assert.throws(() => prepare(options));
  const data = firecrawlData(
    {
      success: true,
      data: {
        web: [
          {
            url: 'https://example.org',
            category: 'research',
            description: '## Heading\n\nRelevant **paragraph**',
          },
        ],
      },
    },
    { includeText: false, limit: 5 },
    (v) => v,
  );
  assert.equal(data.results[0].category, 'research');
  assert.match(renderFirecrawl(data, 'en'), /Category: research/);
  assert.match(renderFirecrawl(data, 'en'), /## Heading\n\nRelevant \*\*paragraph\*\*/);
});

test('Tavily passes cache hours unchanged and leaves language optional without strict filtering', () => {
  const prepare = (options: Parameters<typeof prepareTavilySearch>[1]) =>
    prepareTavilySearch('q', options, {}, env, 'en').body;
  assert.equal(prepare({}).max_age_hours, undefined);
  assert.equal(prepare({}).language, undefined);
  for (const value of ['-1', '0', '720'])
    assert.equal(prepare({ maxAgeHours: value }).max_age_hours, Number(value));
  for (const value of ['-2', '721', '1.5', 'NaN', '-0'])
    assert.throws(() => prepare({ maxAgeHours: value }));
  for (const language of ['en', 'zh-cn', 'english'])
    assert.equal(prepare({ language }).language, language);
  assert.equal(prepare({ language: 'en' }).filter_by_language, undefined);
  assert.throws(() => prepare({ language: ' ' }));
});

test('TinyFish returns optional iframe links without following them', async () => {
  const request = tinyfish.prepareFetch(
    ['https://example.org'],
    { includeIframeLinks: true },
    {},
    env,
    'en',
  );
  assert.equal(request.body.iframe_links, true);
  let calls = 0;
  const result = await tinyfish.request(request, attempt(), 'en', async () => {
    calls++;
    return Response.json({
      results: [
        {
          url: 'https://example.org',
          format: 'markdown',
          text: 'Page',
          iframe_links: ['https://example.org/frame'],
        },
      ],
      errors: [],
    });
  });
  assert.equal(result.outcome.exitCode, 0);
  assert.equal(calls, 1);
  assert.deepEqual(result.outcome.result.data?.results[0].iframe_links, [
    'https://example.org/frame',
  ]);
});

test('CLI search enables highlights by default and allows explicit disabling; v3 hints reach HTTP', async (t) => {
  const root = temporary(t);
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url!, ...(raw ? { body: JSON.parse(raw) } : {}) });
    res.setHeader('content-type', 'application/json');
    let body;
    if (req.url!.startsWith('/v3/fetch')) {
      body = {
        url: 'https://example.org',
        title: 'Page',
        highlights: [{ text: 'Section' }],
        untrusted: true,
        contentCheck: 'passed',
      };
    } else if (req.url!.startsWith('/v3/search') || req.url!.startsWith('/v2/context')) {
      body = { codeSnippets: [], infoSnippets: [] };
    } else if (req.headers['x-api-key']) {
      body = { results: [] };
    } else {
      body = { success: true, data: { web: [] } };
    }
    res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(root, 'config.json'), '{}');
  const config = context(root, {
    ...env,
    UNISEARCH_CONFIG_PATH: join(root, 'config.json'),
    UNISEARCH_LANG: 'en',
    UNISEARCH_EXA_BASE_URL: base,
    UNISEARCH_FIRECRAWL_BASE_URL: base,
    UNISEARCH_TAVILY_BASE_URL: base,
    UNISEARCH_CTX7_BASE_URL: base,
  });
  const run = async (args: string[]) => {
    const channels = capture();
    const exit = await createCli('test', { config, channels }).run([...args, '--format=json']);
    assert.equal(exit, 0, channels.out + channels.err);
  };
  for (const prefix of [
    ['exa', 'search'],
    ['firecrawl', 'search'],
    ['search', '--sources', 'exa,firecrawl'],
  ]) {
    await run([...prefix, 'q']);
    await run([...prefix, 'q', '--no-highlights']);
  }
  const highlights = (call: (typeof calls)[number]) =>
    call.body?.highlights ?? (call.body?.contents as { highlights: boolean }).highlights;
  assert.deepEqual(calls.map(highlights), [true, false, true, false, true, true, false, false]);
  const beforeInvalid = calls.length;
  for (const sources of ['tavily', 'model']) {
    const channels = capture();
    const exit = await createCli('test', { config, channels }).run([
      'search',
      'q',
      '--sources',
      sources,
      '--no-highlights',
      '--format=json',
    ]);
    assert.equal(exit, 2);
    const result = JSON.parse(channels.out);
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
    assert.equal(result.error.details.option, '--no-highlights');
    assert.match(result.error.message, /Exa or Firecrawl/);
  }
  writeFileSync(join(root, 'config.json'), JSON.stringify({ search: { providers: ['tavily'] } }));
  const defaultSources = capture();
  assert.equal(
    await createCli('test', { config, channels: defaultSources }).run([
      'search',
      'q',
      '--no-highlights',
      '--format=json',
    ]),
    2,
  );
  assert.equal(JSON.parse(defaultSources.out).error.details.option, '--no-highlights');
  assert.equal(calls.length, beforeInvalid);
  await run([
    'ctx7',
    'search',
    'q',
    '--library',
    'one',
    '--library',
    'two',
    '--language',
    'Ruby',
    '--library-version',
    '2',
  ]);
  const url = new URL(calls.at(-1)!.path, base);
  assert.deepEqual(url.searchParams.getAll('library'), ['one', 'two']);
  assert.equal(url.searchParams.get('language'), 'Ruby');
  assert.equal(url.searchParams.get('version'), '2');
  await run(['ctx7', 'fetch', 'https://example.org', '--query', 'question', '--tokens', '100']);
  const fetched = new URL(calls.at(-1)!.path, base);
  assert.equal(fetched.pathname, '/v3/fetch');
  assert.equal(fetched.searchParams.get('query'), 'question');
  assert.equal(fetched.searchParams.get('tokens'), '100');
  await run(['ctx7', 'docs', '/example/lib', 'q', '--language', 'Python']);
  assert.equal(new URL(calls.at(-1)!.path, base).searchParams.get('language'), 'Python');
  for (const prefix of [['search'], ['exa', 'search'], ['firecrawl', 'search']]) {
    const channels = capture();
    assert.equal(await createCli('test', { config, channels }).run([...prefix, '--help']), 0);
    assert.match(channels.out, /--no-highlights/);
    assert.doesNotMatch(channels.out, /--include-highlights|--highlights\b/);
    if (prefix.length === 1) {
      assert.match(channels.out, /Disable search highlights for Exa and Firecrawl/);
      assert.ok(channels.out.indexOf('--no-fallback') < channels.out.indexOf('--no-highlights'));
      assert.ok(channels.out.indexOf('--no-highlights') < channels.out.indexOf('--format'));
    }
  }
  const groupHelp = capture();
  assert.equal(await createCli('test', { config, channels: groupHelp }).run(['ctx7', '--help']), 0);
  assert.deepEqual(
    [...groupHelp.out.matchAll(/^  (search|fetch|library|docs)\b/gm)].map((match) => match[1]),
    ['search', 'fetch', 'library', 'docs'],
  );
});
