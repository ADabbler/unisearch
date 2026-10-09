import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCli } from '../src/cli/program.js';
import * as ctx7 from '../src/providers/context7.js';
import { renderContext7 } from '../src/output/context7.js';
import { localStatus } from '../src/config/status.js';
import { redactDiagnostics, redactError } from '../src/providers/transport.js';
import { capture, context, temporary } from './helpers.js';

const code = {
  codeId: 'https://example.org/ui/button',
  codeTitle: 'Button',
  codeDescription: 'Use a button.',
  codeList: [{ language: 'ts', code: 'button();' }],
};
const docs = {
  codeSnippets: [code],
  infoSnippets: [
    { content: '**Guide**', breadcrumb: 'UI > Button', pageId: 'https://example.org/ui' },
  ],
};
const library = {
  results: [
    {
      id: '/example/ui',
      title: 'UI',
      description: 'UI',
      versions: ['v1', 'v2'],
      totalSnippets: 0,
      trustScore: 8.3,
      benchmarkScore: 88.5,
      state: 'processing',
    },
  ],
  searchFilterApplied: true,
};

test('Context7 preparation preserves REST parameters, Unicode and explicit library versions', () => {
  const target = ' Example + UI & # 界面 ';
  const req = ctx7.prepare('library', target, 'How + & # 中文?', undefined, {}, {}, 'en');
  const url = new URL(req.url);
  assert.equal(url.origin + url.pathname, 'https://context7.com/api/v2/libs/search');
  assert.equal(url.searchParams.get('libraryName'), target);
  assert.equal(url.searchParams.get('query'), 'How + & # 中文?');
  assert.equal(url.searchParams.get('fast'), 'false');
  assert.equal(req.apiKey, undefined);
  assert.equal(req.timeout, 300);
  assert.equal(ctx7.requestLimit, 30);
  for (const id of [
    '/example/ui',
    '/websites/uploadcare',
    '/llmstxt/example',
    '/example/ui/v1.2',
    '/example/ui@v1.2',
  ]) {
    const request = ctx7.prepare(
      'docs',
      id,
      'q',
      2,
      {},
      { UNISEARCH_CTX7_BASE_URL: 'http://localhost/gateway/api/' },
      'en',
    );
    assert.equal(new URL(request.url).pathname, '/gateway/api/v2/context');
    assert.equal(new URL(request.url).searchParams.get('libraryId'), id);
    assert.equal(new URL(request.url).searchParams.get('type'), 'json');
    assert.equal(request.timeout, 2);
  }
  ctx7.prepare('library', '😀'.repeat(500), 'q', undefined, {}, {}, 'en');
  for (const name of ['', ' ', '😀'.repeat(501)])
    assert.throws(() => ctx7.prepare('library', name, 'q', undefined, {}, {}, 'en'));
  for (const id of ['example/ui', '/a', '/a/b/c/d', '/a/ b'])
    assert.throws(() => ctx7.prepare('docs', id, 'q', undefined, {}, {}, 'en'));
});

test('Context7 mappings retain useful metadata, empty results and explanation-only snippets', () => {
  assert.deepEqual(ctx7.libraryData(library), {
    provider: 'ctx7',
    results: [
      {
        id: '/example/ui',
        title: 'UI',
        versions: ['v1', 'v2'],
        total_snippets: 0,
        trust_score: 8.3,
        benchmark_score: 88.5,
        state: 'processing',
      },
    ],
    search_filter_applied: true,
  });
  assert.deepEqual(ctx7.libraryData({ results: [], searchFilterApplied: false }), {
    provider: 'ctx7',
    results: [],
  });
  const mapped = ctx7.docsData(
    { ...docs, rules: { global: [], libraryOwn: ['rule', ' '], libraryTeam: null } },
    '/example/ui/v2',
  );
  assert.equal(mapped.library_id, '/example/ui/v2');
  assert.deepEqual(mapped.rules, { library_own: ['rule'] });
  const explanation = ctx7.docsData(
    {
      codeSnippets: [
        {
          ...code,
          codeTitle: 'Same',
          codeDescription: 'Same',
          codeList: [],
          isDynamic: true,
          sourceFile: 'src/ui.ts',
        },
      ],
      infoSnippets: [],
    },
    '/a/b',
  );
  assert.deepEqual(explanation.code_snippets, [
    { url: code.codeId, description: 'Same', is_dynamic: true, source_file: 'src/ui.ts' },
  ]);
  assert.doesNotMatch(renderContext7(explanation, 'zh'), /```|### Same/);
  for (const value of [
    undefined,
    {},
    { results: [] },
    { ...library, searchFilterApplied: 'true' },
    ...[
      { id: 'ui' },
      { trustScore: 10.1 },
      { benchmarkScore: 101 },
      { totalSnippets: -1 },
      { versions: [''] },
      { title: 1 },
    ].map((change) => ({ ...library, results: [{ ...library.results[0], ...change }] })),
  ])
    assert.throws(() => ctx7.libraryData(value));
  for (const value of [
    { codeSnippets: [] },
    { infoSnippets: [] },
    ...[
      { codeId: 'bad' },
      { codeList: null },
      { codeDescription: null },
      { codeList: [], codeDescription: '' },
      { isDynamic: 1 },
      { codeList: [{ language: 'js', code: '' }] },
    ].map((change) => ({ ...docs, codeSnippets: [{ ...code, ...change }] })),
  ])
    assert.throws(() => ctx7.docsData(value, '/a/b'));
});

test('Context7 Markdown protects code fences without losing code or unsafe language names', () => {
  const content = '```md\n# inner\n````\n';
  const mapped = ctx7.docsData(
    {
      ...docs,
      codeSnippets: [{ ...code, codeList: [{ language: 'odd`\nlanguage', code: content }] }],
    },
    '/a/b',
  );
  const md = renderContext7(mapped, 'en');
  assert.ok(md.includes(`\n\`\`\`\`\`\n${content}\`\`\`\`\``));
  assert.match(md, /Language: odd\\` language/);
  assert.match(md, /\*\*Guide\*\*/);
});

test('Context7 renders large code and rule collections, keeping metadata on one line', () => {
  const content = '`value`\n'.repeat(100000);
  const sourceFile = 'src/ui\n\n# source.ts';
  const mapped = ctx7.docsData(
    {
      codeSnippets: [{ ...code, sourceFile, codeList: [{ language: 'js', code: content }] }],
      infoSnippets: [],
      rules: { global: Array(150000).fill('Keep this rule.') },
    },
    '/example/ui',
  );
  const md = renderContext7(mapped, 'en');
  assert.ok(md.includes(content));
  assert.equal(md.match(/Keep this rule\./g)?.length, 150000);
  assert.equal(mapped.code_snippets[0].source_file, sourceFile);
  assert.ok(md.includes('Source file: `src/ui # source.ts`'));
  const libraries = ctx7.libraryData({
    results: [{ id: '/example/ui', versions: ['v1\n\n# version', 'v`2'] }],
    searchFilterApplied: false,
  });
  assert.ok(
    renderContext7(libraries, 'en').includes('Available versions: `v1 # version`, `` v`2 ``'),
  );
});

test('Context7 anonymous readiness and optional credential validation use actual operations', () => {
  assert.deepEqual(localStatus({}, {}, 'en', ctx7.operations).services, [
    { provider: 'ctx7', state: 'ready' },
  ]);
  for (const [env, state] of [
    [{ UNISEARCH_CTX7_API_KEY: '' }, 'invalid'],
    [{ UNISEARCH_CTX7_BASE_URL: 'bad' }, 'invalid'],
  ] as const)
    assert.equal(localStatus({}, env, 'en', ctx7.operations).services[0].state, state);
  assert.equal(
    localStatus({ providers: { ctx7: { enabled: false } } }, {}, 'en', ctx7.operations).services[0]
      .state,
    'disabled',
  );
  assert.equal(redactError('ordinary message', ''), 'ordinary message');
  assert.equal(
    redactDiagnostics('Authorization: Bearer private\nhttps://u:p@example.org', []),
    'Authorization: [REDACTED]\nhttps://[REDACTED]@example.org',
  );
});

test('Context7 HTTP CLI supports auth, output, retry, errors and cancellation without changing libraries', async (t) => {
  const root = temporary(t);
  const calls: { url: string; auth?: string; method?: string; contentType?: string }[] = [];
  let status = 200;
  let body: unknown = docs;
  let delay = false;
  let retry = false;
  const server = createServer((req, res) => {
    calls.push({
      url: req.url!,
      auth: req.headers.authorization,
      method: req.method,
      contentType: req.headers['content-type'],
    });
    if (delay) {
      res.writeHead(200);
      res.write('{');
      return;
    }
    res.statusCode = retry ? 429 : status;
    res.setHeader('x-context7-request-id', 'fixture-request');
    if (retry) {
      retry = false;
      res.setHeader('retry-after', '0');
      res.end(JSON.stringify({ error: 'rate_limited', message: 'slow down' }));
    } else res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const env = {
    UNISEARCH_CTX7_BASE_URL: `http://127.0.0.1:${address.port}/api`,
    UNISEARCH_LANG: 'en',
    UNISEARCH_RETRIES: '1',
  };
  const run = async (args: string[], extra = {}) => {
    const channels = capture();
    const exit = await createCli('test', {
      config: context(root, { ...env, ...extra }),
      channels,
    }).run(args);
    return { exit, ...channels };
  };
  for (const args of [
    ['ctx7'],
    ['ctx7', 'docs', '--help'],
    ['status', '--json'],
    ['config', 'get', 'providers.ctx7'],
  ])
    assert.equal((await run(args)).exit, 0);
  assert.equal(calls.length, 0);
  for (const args of [
    ['ctx7', 'docs'],
    ['ctx7', 'library', 'ui'],
    ['ctx7', 'docs', '/a/b', 'q', '--tokens', '2'],
    ['ctx7', 'docs', '/a/b', 'q', '--verbose', '--verbose'],
  ])
    assert.equal((await run(args)).exit, 2);
  const target = join(root, 'docs.md');
  const ok = await run(['ctx7', 'docs', '/a/b@v1', 'q', '--output', target, '--verbose']);
  assert.equal(ok.exit, 0);
  assert.equal(ok.out, '');
  assert.equal(
    readFileSync(target, 'utf8'),
    `${renderContext7(ctx7.docsData(docs, '/a/b@v1'), 'en')}\n`,
  );
  assert.equal(calls[0].auth, undefined);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].contentType, undefined);
  retry = true;
  assert.equal(
    (await run(['ctx7', 'docs', '/a/b', 'q'], { UNISEARCH_CTX7_API_KEY: 'fixture-key' })).exit,
    0,
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[1].auth, 'Bearer fixture-key');
  assert.equal(calls[1].url, calls[2].url);
  for (const [http, tag, expected] of [
    [400, 'bad', 'INVALID_ARGUMENT'],
    [401, 'invalid_api_key', 'AUTHENTICATION_ERROR'],
    [402, 'spending_limit_exceeded', 'QUOTA_EXCEEDED'],
    [403, 'denied', 'ACCESS_DENIED'],
    [202, 'library_not_finalized', 'CONTENT_UNAVAILABLE'],
    [404, 'tag_not_found', 'CONTENT_UNAVAILABLE'],
    [422, 'no_code_found', 'CONTENT_UNAVAILABLE'],
    [422, 'unknown', 'UPSTREAM_ERROR'],
    [301, 'library_redirected', 'UPSTREAM_ERROR'],
  ] as const) {
    status = http;
    body = {
      error: tag,
      message: 'fixture-key https://user:pass@example.org',
      redirectUrl: '/new/library',
    };
    const before: number = calls.length;
    const failed = await run(['ctx7', 'docs', '/a/b/v1', 'q', '--format', 'json'], {
      UNISEARCH_CTX7_API_KEY: 'fixture-key',
    });
    assert.equal(JSON.parse(failed.out).error.code, expected);
    assert.equal(calls.length, before + 1);
    assert.doesNotMatch(failed.out, /fixture-key|user:pass/);
  }
  status = 404;
  body = { error: 'no_libraries_found', message: 'none' };
  const emptyError = await run(['ctx7', 'library', 'a', 'q', '--format', 'json']);
  assert.equal(JSON.parse(emptyError.out).error.code, 'UPSTREAM_ERROR');
  status = 200;
  body = { codeSnippets: [], infoSnippets: [] };
  assert.equal((await run(['ctx7', 'docs', '/a/b', 'q', '--output', target])).exit, 0);
  writeFileSync(target, 'original');
  status = 401;
  body = 'invalid';
  const failed = await run(['ctx7', 'docs', '/a/b', 'q', '--output', target, '--format', 'json']);
  assert.equal(JSON.parse(failed.out).error.details.reason, 'error_body_invalid');
  assert.equal(readFileSync(target, 'utf8'), 'original');
  delay = true;
  const timed = await run(['ctx7', 'docs', '/a/b', 'q', '--timeout', '0.03', '--format', 'json']);
  assert.equal(JSON.parse(timed.out).error.details.timeout_scope, 'total');
  const controller = new AbortController();
  const request = ctx7.prepare('docs', '/a/b', 'q', undefined, {}, env, 'en');
  const pending = ctx7.request(request, { signal: controller.signal }, 'en');
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending);
});
