import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCli } from '../src/cli/program.js';
import { AppError } from '../src/errors.js';
import { exaSearch, prepareSearch, requestSearch, searchData } from '../src/providers/exa.js';
import type { SearchOptions } from '../src/providers/exa.js';
import { localStatus } from '../src/config/status.js';
import { renderSearch } from '../src/output/exa.js';
import { render } from '../src/output/render.js';
import { success } from '../src/result.js';
import { capture, context, temporary } from './helpers.js';

const env = { UNISEARCH_EXA_API_KEY: 'test-exa-key', UNISEARCH_LANG: 'en' };
const prepare = (options: SearchOptions = {}, values = {}) =>
  prepareSearch(' query ', options, values, env, 'en');

export async function server(t: TestContext, listener: RequestListener): Promise<string> {
  const instance = createServer(listener);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      instance.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('Exa help exposes search and fetch, and parameter errors are local', async (t) => {
  const root = temporary(t);
  const outputs: string[] = [];
  for (const args of [['exa'], ['exa', '--help']]) {
    const channels = capture();
    assert.equal(await createCli('test', { config: context(root), channels }).run(args), 0);
    assert.match(channels.out, /search/);
    assert.match(channels.out, /fetch/);
    assert.doesNotMatch(channels.out, /similar/);
    outputs.push(channels.out);
  }
  assert.equal(outputs[0], outputs[1]);
  const invalid = [
    [],
    ['q', '--limit', '0'],
    ['q', '--limit', '101'],
    ['q', '--limit', '1.1'],
    ['q', '--limit', '2', '--limit', '3'],
    ['q', '--search-type', 'neural'],
    ['q', '--include-text', '--include-text'],
    ['q', '--timeout', '0'],
    ['q', '--timeout', 'Infinity'],
    ['q', '--timeout', '-1'],
    ['q', '--timeout', '2', '--timeout', '3'],
    ['q', '--api-key', 'secret'],
    ['   '],
  ];
  for (const args of invalid) {
    const channels = capture();
    assert.equal(
      await createCli('test', { config: context(root, env), channels }).run([
        'exa',
        'search',
        '--format=json',
        ...args,
      ]),
      2,
      args.join(' '),
    );
    assert.equal(JSON.parse(channels.out).error.code, 'INVALID_ARGUMENT');
  }
  for (const args of [
    ['config', 'path'],
    ['status', '--json'],
    ['config', 'set', 'language', 'en'],
  ]) {
    const channels = capture();
    assert.equal(
      await createCli('test', { config: context(root, env), channels }).run([
        ...args,
        '--timeout',
        '1',
      ]),
      2,
    );
  }
});

test('Search mapping preserves defaults, explicit modes, dates, domains and requested contents', () => {
  assert.equal(
    prepare({}, { providers: { exa: { base_url: 'https://example.com/@team/' } } }).url,
    'https://example.com/@team/search',
  );
  for (const base_url of ['https://@example.com', 'https://user@example.com']) {
    assert.throws(() => prepare({}, { providers: { exa: { base_url } } }), AppError);
  }
  assert.deepEqual(prepare().body, {
    query: ' query ',
    numResults: 5,
    type: 'auto',
    contents: { text: false, highlights: false },
  });
  assert.equal(prepare().timeout, 300);
  assert.equal(prepare().retries, 2);
  assert.equal(prepare().url, 'https://api.exa.ai/search');
  for (const mode of ['auto', 'fast', 'instant'])
    for (const limit of ['1', '100']) {
      assert.equal(prepare({ searchType: mode, limit }).body.numResults, Number(limit));
    }
  assert.deepEqual(
    prepare({
      includeText: true,
      includeHighlights: true,
      publishedAfter: '2024-02-29T10:20:30.12+08:00',
      category: 'research paper',
      includeDomains: '*.example.com/path,example.com/path',
      excludeDomains: 'example.com/path',
    }).body,
    {
      query: ' query ',
      numResults: 5,
      type: 'auto',
      contents: { text: true, highlights: true },
      startPublishedDate: '2024-02-29T02:20:30.120Z',
      category: 'research paper',
      includeDomains: ['*.example.com/path', 'example.com/path'],
      excludeDomains: ['example.com/path'],
    },
  );
  assert.equal(
    prepare({ publishedAfter: '2026-01-01' }).body.startPublishedDate,
    '2026-01-01T00:00:00.000Z',
  );
  assert.deepEqual(prepare({ includeDomains: 'example.com,example.com' }).body.includeDomains, [
    'example.com',
    'example.com',
  ]);
  assert.equal(
    (
      prepare({ includeDomains: Array(1200).fill('example.com').join(',') }).body
        .includeDomains as string[]
    ).length,
    1200,
  );
});

test('Invalid dates, domain forms and category combinations fail before configuration or requests', () => {
  for (const date of [
    '2025-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-01-01T00:00:00',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00.1234Z',
    '2026-01-01T00:00:00+24:00',
    'tomorrow',
  ]) {
    assert.throws(() => prepare({ publishedAfter: date }), AppError, date);
  }
  for (const domains of [
    '',
    ',example.com',
    'example.com,',
    ' example.com',
    'https://example.com',
    'example.com:80',
    'user@example.com',
    'example.com?q=x',
    'example.com#x',
    '*example.com',
    'example.com/*',
    '/example.com',
    'example.com\\evil',
    Array(1201).fill('a.test').join(','),
  ]) {
    assert.throws(() => prepare({ includeDomains: domains }), AppError, domains.slice(0, 100));
  }
  for (const category of ['company', 'people']) {
    assert.throws(() => prepare({ category, publishedAfter: '2026-01-01' }), AppError);
    assert.throws(() => prepare({ category, excludeDomains: 'example.com' }), AppError);
  }
  assert.throws(() => prepare({ category: 'people', includeDomains: 'example.com' }), AppError);
  assert.ok(prepare({ category: 'company', includeDomains: 'example.com' }));
  assert.throws(() => prepare({ category: ' ' }), AppError);
});

test('Configuration resolution is shared with status and uses only effective operation settings', () => {
  const values = {
    providers: {
      exa: { api_key: 42, base_url: 'invalid', search: { limit: -1, search_type: 'old' } },
      model: false,
    },
    execution: { timeout_seconds: -1, fallback: 'invalid', retries: 0 },
  };
  const environment = { ...env, UNISEARCH_EXA_BASE_URL: 'http://localhost:1234/prefix/' };
  const request = prepareSearch(
    'q',
    { limit: '3', searchType: 'fast', timeout: 0.5 },
    values,
    environment,
    'en',
  );
  assert.equal(request.apiKey, env.UNISEARCH_EXA_API_KEY);
  assert.equal(request.url, 'http://localhost:1234/prefix/search');
  assert.equal(request.timeout, 0.5);
  assert.equal(request.retries, 0);
  assert.equal(localStatus(values, environment, 'en', [exaSearch]).services[0].state, 'invalid');
  for (const [config, expected] of [
    [{}, 'missing'],
    [{ providers: { exa: { enabled: false } } }, 'disabled'],
    [{ providers: { exa: { enabled: false, base_url: '?' } } }, 'invalid'],
    [{ providers: { exa: { api_key: 'fixture' } } }, 'ready'],
  ] as const)
    assert.equal(localStatus(config, {}, 'en', [exaSearch]).services[0].state, expected);
  for (const [values, code] of [
    [{}, 'MISSING_CONFIG'],
    [{ providers: { exa: { enabled: false } } }, 'SERVICE_DISABLED'],
    [{ providers: { exa: { enabled: false, api_key: '' } } }, 'INVALID_CONFIG'],
    [{ providers: { exa: { api_key: 'valid', unknown: true } } }, 'INVALID_CONFIG'],
  ] as const)
    assert.throws(
      () => prepareSearch('q', {}, values, {}, 'en'),
      (error: unknown) => error instanceof AppError && error.code === code,
    );
  assert.throws(
    () => prepare({ limit: '1' }, { providers: { exa: { search: { unknown: 1 } } } }),
    AppError,
  );
});

test('Exa configuration fields support set/get/list/unset with validation and environment sources', async (t) => {
  const root = temporary(t);
  const path = join(root, 'config.json');
  const config = context(root, { UNISEARCH_CONFIG_PATH: path, UNISEARCH_LANG: 'en' });
  for (const [field, value] of [
    ['base_url', 'http://localhost:1234/prefix/'],
    ['search.limit', '100'],
    ['search.search_type', 'instant'],
  ]) {
    const key = `providers.exa.${field}`;
    const channels = capture();
    assert.equal(
      await createCli('test', { config, channels }).run(['config', 'set', key, value]),
      0,
    );
    const get = capture();
    assert.equal(await createCli('test', { config, channels: get }).run(['config', 'get', key]), 0);
    assert.equal(JSON.parse(get.out).data.source, 'config');
  }
  for (const value of [
    'ftp://example.com',
    'https://u:p@example.com',
    'https://example.com?',
    'https://example.com#',
    'https://example.com/ ',
  ]) {
    const channels = capture();
    assert.equal(
      await createCli('test', { config, channels }).run([
        'config',
        'set',
        'providers.exa.base_url',
        value,
      ]),
      2,
    );
  }
  const get = capture();
  assert.equal(
    await createCli('test', {
      config: {
        ...config,
        env: { ...config.env, UNISEARCH_EXA_BASE_URL: 'https://gateway.example.com' },
      },
      channels: get,
    }).run(['config', 'get', 'providers.exa.base_url']),
    0,
  );
  assert.equal(JSON.parse(get.out).data.source, 'UNISEARCH_EXA_BASE_URL');
  const list = capture();
  assert.equal(await createCli('test', { config, channels: list }).run(['config', 'list']), 0);
  assert.match(list.out, /instant/);
  assert.equal(
    await createCli('test', { config, channels: capture() }).run([
      'config',
      'unset',
      'providers.exa.search',
    ]),
    0,
  );
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).providers.exa.search, undefined);
});

test('Local HTTP CLI sends one exact POST and supports operation option positions and --', async (t) => {
  const root = temporary(t);
  const requests: { url?: string; method?: string; key?: string; body: unknown }[] = [];
  const base = await server(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers.accept, 'application/json');
    assert.equal(req.headers['content-type'], 'application/json');
    requests.push({
      url: req.url,
      method: req.method,
      key: req.headers['x-api-key'] as string,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.end('{"results":[]}');
  });
  const config = context(root, { ...env, UNISEARCH_EXA_BASE_URL: `${base}/prefix/` });
  for (const args of [
    ['exa', 'search', '--timeout', '2', '--format=json', ' q '],
    ['exa', 'search', ' q ', '--timeout', '2', '--format=json'],
    ['exa', 'search', '--timeout', '2', '--format=json', '--', '--help'],
  ]) {
    const channels = capture();
    assert.equal(await createCli('test', { config, channels }).run(args), 0, channels.out);
    assert.deepEqual(JSON.parse(channels.out), {
      status: 'success',
      data: { provider: 'exa', results: [] },
    });
    assert.equal(channels.err, '');
  }
  assert.deepEqual(requests[0], {
    url: '/prefix/search',
    method: 'POST',
    key: env.UNISEARCH_EXA_API_KEY,
    body: {
      query: ' q ',
      numResults: 5,
      type: 'auto',
      contents: { text: false, highlights: false },
    },
  });
  assert.equal((requests[2].body as { query: string }).query, '--help');
  const combo = capture();
  assert.equal(
    await createCli('test', { config, channels: combo }).run([
      'exa',
      'search',
      'JavaScript runtime releases',
      '--limit',
      '3',
      '--search-type',
      'fast',
      '--include-text',
      '--include-highlights',
      '--published-after',
      '2026-01-01',
      '--category',
      'news',
      '--include-domains',
      'nodejs.org,deno.com',
      '--exclude-domains',
      'nodejs.org/blog/community',
      '--timeout',
      '15',
    ]),
    0,
  );
  assert.deepEqual(requests[3].body, {
    query: 'JavaScript runtime releases',
    numResults: 3,
    type: 'fast',
    contents: { text: true, highlights: true },
    startPublishedDate: '2026-01-01T00:00:00.000Z',
    category: 'news',
    includeDomains: ['nodejs.org', 'deno.com'],
    excludeDomains: ['nodejs.org/blog/community'],
  });
  const file = join(root, '结果.json');
  const channels = capture();
  assert.equal(
    await createCli('test', { config, channels }).run([
      'exa',
      'search',
      'q',
      '--format=json',
      '--output',
      file,
    ]),
    0,
  );
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    status: 'success',
    data: { provider: 'exa', results: [] },
  });
  assert.equal(channels.out + channels.err, '');
  const calls = requests.length;
  assert.equal(
    await createCli('test', { config, channels: capture() }).run([
      'exa',
      'search',
      'q',
      '--output',
      join(root, 'missing', 'file'),
    ]),
    5,
  );
  assert.equal(requests.length, calls);
  assert.deepEqual(readdirSync(root), ['结果.json']);
});

test('Local retry success renders and saves the same complete data with verbose details only when requested', async (t) => {
  const root = temporary(t);
  let calls = 0;
  const base = await server(t, (_req, res) => {
    calls++;
    if (calls % 2 === 1) {
      res.writeHead(503, { 'Retry-After': '0', 'x-request-id': 'retry-id' });
      res.end('{"error":"busy"}');
    } else {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          results: [{ title: 'A page', url: 'https://example.com', text: '# Original\n\nContent' }],
          requestId: 'success-id',
        }),
      );
    }
  });
  const config = context(root, { ...env, UNISEARCH_EXA_BASE_URL: base });
  for (const format of ['json', 'markdown']) {
    const output = join(root, `result.${format}`);
    const channels = capture();
    assert.equal(
      await createCli('test', { config, channels }).run([
        'exa',
        'search',
        'q',
        '--include-text',
        '--format',
        format,
        '--verbose',
        '--output',
        output,
      ]),
      0,
    );
    assert.equal(channels.out, '');
    const saved = readFileSync(output, 'utf8');
    if (format === 'json') {
      const result = JSON.parse(saved);
      assert.equal(result.data.results[0].text, '# Original\n\nContent');
      assert.equal(result.meta.attempts.length, 2);
      assert.deepEqual(
        result.meta.attempts.map((entry: { http_status: number }) => entry.http_status),
        [503, 200],
      );
      assert.equal(result.meta.attempts[0].request_id, 'retry-id');
      assert.equal(result.meta.attempts[1].request_id, 'success-id');
      assert.equal(channels.err, '');
    } else {
      assert.match(saved, /# Original\n\nContent/);
      assert.doesNotMatch(saved, /Attempt|retry-id|success-id/);
      assert.match(channels.err, /Attempt 1: HTTP 503/);
      assert.match(channels.err, /Attempt 2: HTTP 200/);
    }
  }
  assert.equal(calls, 4);
  const status = capture();
  assert.equal(await createCli('test', { config, channels: status }).run(['status', '--json']), 0);
  assert.equal(
    JSON.parse(status.out).data.services.find(
      (service: { provider: string }) => service.provider === 'exa',
    ).state,
    'ready',
  );
  assert.equal(calls, 4);
});

test('Local preconditions make no requests; failures preserve old output and save errors retain acquired data', async (t) => {
  const root = temporary(t);
  const output = join(root, 'result.json');
  await fs.writeFile(output, 'old');
  let calls = 0;
  let status = 401;
  const base = await server(t, (_req, res) => {
    calls++;
    res.writeHead(status);
    res.end(
      status === 200
        ? '{"results":[{"title":"Page","url":"https://example.com"}]}'
        : '{"error":"Invalid key"}',
    );
  });
  for (const [overrides, code] of [
    [{ UNISEARCH_EXA_API_KEY: undefined }, 3],
    [{ UNISEARCH_EXA_BASE_URL: 'invalid' }, 3],
    [{ UNISEARCH_RETRIES: '-1' }, 3],
  ] as const) {
    const channels = capture();
    assert.equal(
      await createCli('test', {
        config: context(root, { ...env, UNISEARCH_EXA_BASE_URL: base, ...overrides }),
        channels,
      }).run(['exa', 'search', 'q', '--output', output, '--format=json']),
      code,
    );
    assert.equal(calls, 0);
    assert.equal(readFileSync(output, 'utf8'), 'old');
  }
  const config = context(root, { ...env, UNISEARCH_EXA_BASE_URL: base });
  const failed = capture();
  assert.equal(
    await createCli('test', { config, channels: failed }).run([
      'exa',
      'search',
      'q',
      '--output',
      output,
      '--format=json',
    ]),
    3,
  );
  assert.equal(calls, 1);
  assert.equal(readFileSync(output, 'utf8'), 'old');
  status = 200;
  t.mock.method(fs, 'rename', async () => {
    throw Object.assign(new Error(), { code: 'EACCES' });
  });
  const channels = capture();
  assert.equal(
    await createCli('test', { config, channels }).run([
      'exa',
      'search',
      'q',
      '--output',
      output,
      '--format=json',
    ]),
    5,
  );
  const result = JSON.parse(channels.out);
  assert.equal(result.error.code, 'FILE_IO_ERROR');
  assert.equal(result.data.results[0].title, 'Page');
  assert.equal(readFileSync(output, 'utf8'), 'old');
  assert.deepEqual(readdirSync(root), ['result.json']);
});

test('Results preserve order, duplicates, original Markdown and optional-content availability without redundant JSON', () => {
  const item = {
    title: 'Runtime release schedule',
    url: 'https://example.com/releases',
    publishedDate: '2026-09-01',
    author: 'Runtime team',
    text: '## Release schedule\n\nSee the [release policy](https://example.com/policy).\n\n```sh\nnode --version\n```',
    highlights: ['The release schedule lists supported versions.'],
    id: 'discard',
    score: 1,
  };
  const data = searchData({ results: [item, item] }, { text: true, highlights: true });
  assert.equal(data.results.length, 2);
  assert.deepEqual(data.results[0], {
    title: item.title,
    url: item.url,
    published_date: item.publishedDate,
    author: item.author,
    text: item.text,
    highlights: item.highlights,
  });
  const expected = `来源：Exa\n\n## 1. [Runtime release schedule](https://example.com/releases)\n\n发布日期：2026-09-01 · 作者：Runtime team\n\n### 摘录\n\nThe release schedule lists supported versions.\n\n### 正文\n\n${item.text}`;
  assert.equal(renderSearch({ ...data, results: [data.results[0]] }, 'zh'), expected);
  assert.match(renderSearch(data, 'en'), /\n---\n/);
  const missing = searchData(
    { results: [{ title: '', url: item.url, text: '  ', highlights: ['', '  '] }] },
    { text: true, highlights: true },
  );
  assert.deepEqual(missing.results, [{ url: item.url, missing_content: ['text', 'highlights'] }]);
  assert.match(renderSearch(missing, 'en'), /Requested content unavailable: text, highlights/);
  const compact = searchData(
    { results: [{ ...item, text: 42, highlights: {} }] },
    { text: false, highlights: false },
  );
  assert.equal(compact.results[0].text, undefined);
  assert.equal(
    renderSearch({ provider: 'exa', results: [] }, 'en'),
    'Source: Exa\n\nNo results found',
  );
  assert.deepEqual(
    JSON.parse(
      render(success({ provider: 'exa', results: [] }), { language: 'en', format: 'json' }).content,
    ),
    { status: 'success', data: { provider: 'exa', results: [] } },
  );
});

test('Invalid retained response fields fail as a whole and never use id as URL', () => {
  const valid = { title: 'title', url: 'https://example.com' };
  for (const body of [
    {},
    { results: null },
    { results: [null] },
    { results: [{ id: valid.url, title: 'title' }] },
    { results: [{ url: valid.url }] },
    ...[
      { title: null },
      { url: '' },
      { url: 'ftp://example.com' },
      { author: 2 },
      { publishedDate: [] },
      { text: 42 },
      { highlights: ['valid', 2] },
    ].map((bad) => ({ results: [valid, { ...valid, ...bad }] })),
  ]) {
    assert.throws(
      () => searchData(body, { text: true, highlights: true }),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_RESPONSE',
    );
  }
  const data = searchData(
    { results: [{ ...valid, author: null, publishedDate: '', text: null, highlights: null }] },
    { text: true, highlights: true },
  );
  assert.deepEqual(data.results[0], { ...valid, missing_content: ['text', 'highlights'] });
});

test('HTTP errors, malformed bodies and redirects retain their exact classifications without following', async (t) => {
  const root = temporary(t);
  let status = 401;
  let body: string | Buffer = '<html>bad</html>';
  let calls = 0;
  const base = await server(t, (_req, res) => {
    calls++;
    res.writeHead(status, { location: '/other', 'x-request-id': 'header-id' });
    res.end(body);
  });
  const config = context(root, { ...env, UNISEARCH_EXA_BASE_URL: base, UNISEARCH_RETRIES: '0' });
  for (const [http, tag, code, exit] of [
    [400, '', 'INVALID_ARGUMENT', 2],
    [401, 'INVALID_API_KEY', 'AUTHENTICATION_ERROR', 3],
    [402, 'NO_MORE_CREDITS', 'QUOTA_EXCEEDED', 4],
    [403, 'FEATURE_DISABLED', 'ACCESS_DENIED', 3],
    [403, 'PROHIBITED_CONTENT', 'UPSTREAM_ERROR', 4],
    [403, 'CONTENT_FILTER_ERROR', 'UPSTREAM_ERROR', 4],
    [403, 'unknown', 'ACCESS_DENIED', 3],
    [422, 'INVALID_REQUEST_BODY', 'INVALID_ARGUMENT', 2],
    [422, 'other', 'UPSTREAM_ERROR', 4],
    [408, '', 'TIMEOUT', 4],
    [429, 'RATE_LIMIT_EXCEEDED', 'RATE_LIMITED', 4],
    [500, '', 'UPSTREAM_ERROR', 4],
    [502, '', 'UPSTREAM_ERROR', 4],
    [503, 'SERVICE_OVERLOADED', 'UPSTREAM_ERROR', 4],
    [504, '', 'TIMEOUT', 4],
    [302, '', 'UPSTREAM_ERROR', 4],
    [404, '', 'UPSTREAM_ERROR', 4],
    [501, '', 'UPSTREAM_ERROR', 4],
  ] as const) {
    status = http;
    body = JSON.stringify({ error: 'upstream detail', tag, requestId: 'body-id' });
    const channels = capture();
    const previous = calls;
    assert.equal(
      await createCli('test', { config, channels }).run([
        'exa',
        'search',
        'q',
        '--format=json',
        '--verbose',
      ]),
      exit,
    );
    const result = JSON.parse(channels.out);
    assert.equal(result.error.code, code);
    assert.equal(result.error.details.http_status, http);
    assert.equal(result.error.details.request_id, 'body-id');
    assert.equal(result.meta.attempts[0].request_id, undefined);
    assert.equal(result.data, undefined);
    assert.equal(calls, previous + 1);
  }
  for (const invalid of [
    '<html>bad</html>',
    '{',
    Buffer.from([0xff]),
    '{}',
    '{"results":[{"title":"a","id":"https://example.com"}]}',
  ]) {
    status = 200;
    body = invalid;
    const channels = capture();
    assert.equal(
      await createCli('test', { config, channels }).run(['exa', 'search', 'q', '--format=json']),
      4,
    );
    assert.equal(JSON.parse(channels.out).error.code, 'INVALID_RESPONSE');
  }
  status = 401;
  for (const invalid of ['<html>bad</html>', '{"error":2,"tag":null,"requestId":3}']) {
    body = invalid;
    const channels = capture();
    assert.equal(
      await createCli('test', { config, channels }).run(['exa', 'search', 'q', '--format=json']),
      3,
    );
    const result = JSON.parse(channels.out);
    assert.equal(result.error.code, 'AUTHENTICATION_ERROR');
    assert.equal(result.error.details.reason, 'error_body_invalid');
    assert.equal(result.error.details.request_id, 'header-id');
    assert.doesNotMatch(channels.out, /<html>/);
  }
});

test('Public errors redact credentials, authorization values and URL userinfo and quote all Markdown lines', async () => {
  const response = new Response(
    JSON.stringify({
      error: `key=${env.UNISEARCH_EXA_API_KEY}\nAuthorization: Bearer hidden\nx-api-key: alternate\n{"Authorization": "Bearer quoted-secret", "x-api-key": "comma,secret"}\n'proxy-authorization': 'proxy-secret'\nhttps://user:password@example.com\n# fake success`,
      tag: env.UNISEARCH_EXA_API_KEY,
      requestId: env.UNISEARCH_EXA_API_KEY,
    }),
    { status: 401 },
  );
  const result = await requestSearch(
    prepare(),
    { signal: new AbortController().signal },
    'en',
    async () => response,
  );
  const serialized = JSON.stringify(result.outcome);
  assert.doesNotMatch(
    serialized,
    /test-exa-key|hidden|alternate|quoted-secret|comma,secret|proxy-secret|user:password/,
  );
  assert.match(serialized, /REDACTED/);
  const rendered = render(result.outcome, { format: 'markdown', language: 'en' });
  assert.equal(rendered.content, '');
  assert.match(rendered.details, /\n  # fake success/);
  assert.doesNotMatch(rendered.details, /\n# fake success/);
});

test('Markdown highlights normalize CR, LF and CRLF without adding quote prefixes', () => {
  const data = searchData(
    {
      results: [
        {
          title: 'Page',
          url: 'https://example.com',
          highlights: ['first\r# second\r\nthird\nfourth', '> Original quote'],
        },
      ],
    },
    { text: false, highlights: true },
  );
  assert.match(renderSearch(data, 'en'), /first\n# second\nthird\nfourth\n\n> Original quote/);
  assert.equal(data.results[0].highlights?.[0], 'first\r# second\r\nthird\nfourth');
});

test('Known network failures and programming exceptions are distinct and never expose native errors', async () => {
  for (const [code, expected, retry] of [
    ['EAI_AGAIN', 'NETWORK_ERROR', true],
    ['ECONNREFUSED', 'NETWORK_ERROR', true],
    ['ECONNRESET', 'NETWORK_ERROR', true],
    ['ENOTFOUND', 'NETWORK_ERROR', false],
    ['CERT_HAS_EXPIRED', 'NETWORK_ERROR', false],
    ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT', true],
  ] as const) {
    const result = await requestSearch(
      prepare(),
      { signal: new AbortController().signal },
      'en',
      async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('private-native-error'), { code }),
        });
      },
    );
    assert.equal(result.outcome.result.error?.code, expected);
    assert.equal(result.retry, retry);
    assert.doesNotMatch(JSON.stringify(result), /private-native-error|stack/);
  }
  const result = await requestSearch(
    prepare(),
    { signal: new AbortController().signal },
    'en',
    async () => {
      throw new TypeError('programming secret');
    },
  );
  assert.equal(result.outcome.result.error?.code, 'INTERNAL_ERROR');
  assert.equal(result.retry, false);
});
