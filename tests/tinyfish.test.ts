import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, error, hit, page, search, url } from './tinyfish-fixture.js';

test('TinyFish configuration, separate operation status, credential sources and offline help', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['tinyfish'],
    ['tinyfish', '--help'],
    ['tinyfish', 'search', '--help'],
    ['tinyfish', 'fetch', '--help'],
  ]) {
    for (const lang of ['zh', 'en']) {
      const r = await f.run(args, { UNISEARCH_LANG: lang });
      assert.equal(r.exit, 0);
      assert.match(r.channels.out, lang === 'zh' ? /用法/ : /Usage/);
    }
  }
  const state = async (env = {}) =>
    (await f.run(['status', '--json'], env))
      .json()
      .data.services.find((s: { provider: string }) => s.provider === 'tinyfish');
  assert.equal((await state()).state, 'ready');
  assert.equal(
    (await state({ UNISEARCH_TINYFISH_API_KEY: undefined, TINYFISH_API_KEY: 'old-key' })).state,
    'missing',
  );
  assert.equal((await f.run(['config', 'set', 'providers.tinyfish.enabled', 'false'])).exit, 0);
  assert.equal((await state()).state, 'disabled');
  assert.equal((await f.run(['config', 'unset', 'providers.tinyfish.enabled'])).exit, 0);
  assert.equal((await state({ UNISEARCH_TINYFISH_API_KEY: ' ' })).state, 'invalid');
  const different = await state({ UNISEARCH_TINYFISH_FETCH_URL: 'invalid' });
  assert.equal(
    different.operations.find((s: { operation: string }) => s.operation === 'fetch').state,
    'invalid',
  );
  assert.equal(
    different.operations.find((s: { operation: string }) => s.operation === 'search').state,
    'ready',
  );
  for (const [key, value] of [
    ['search.location', 'US'],
    ['search.language', 'en'],
    ['fetch.ttl', '0'],
    ['fetch.per_url_timeout_ms', '45000'],
  ]) {
    assert.equal((await f.run(['config', 'set', `providers.tinyfish.${key}`, value])).exit, 2);
    assert.equal((await f.run(['config', 'get', `providers.tinyfish.${key}`])).exit, 2);
  }
  const key = (await f.run(['config', 'get', 'providers.tinyfish.api_key'])).channels.out;
  assert.ok(key.includes('[REDACTED]'));
  assert.ok(!key.includes('tinyfish-fixture-key'));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {
    providers: { jina: { enabled: false }, anysearch: { enabled: false } },
  });
});

test('TinyFish search sends one correctly encoded page with explicit parameters', async (t) => {
  const f = await fixture(t);
  const query = '中文 C++ & # news\nnext';
  const r = await f.run([
    'tinyfish',
    'search',
    query,
    '--location',
    'GB',
    '--language',
    'en',
    '--purpose',
    'Compare\nresults',
    '--include-domains',
    'example.org,example.com',
    '--exclude-domains',
    'ads.example.org',
    '--after-date',
    '2024-02-29',
    '--before-date',
    '2026-10-01',
    '--page',
    '10',
    '--search-type',
    'news',
    '--format=json',
  ]);
  assert.equal(r.exit, 0, r.channels.out);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.method, 'GET');
  assert.equal(call.path, '/tf-search/');
  assert.equal(call.headers['x-api-key'], 'tinyfish-fixture-key');
  assert.equal(call.headers.authorization, undefined);
  assert.equal(call.raw.length, 0);
  assert.deepEqual(Object.fromEntries(call.url.searchParams), {
    query,
    purpose: 'Compare\nresults',
    domain_type: 'news',
    page: '10',
    include_domains: 'example.org,example.com',
    exclude_domains: 'ads.example.org',
    after_date: '2024-02-29',
    before_date: '2026-10-01',
    location: 'GB',
    language: 'en',
  });
  assert.deepEqual(r.json(), {
    status: 'success',
    data: { provider: 'tinyfish', page: 0, results: [hit] },
  });
  f.save({});
  assert.equal(
    (
      await f.run([
        'tinyfish',
        'search',
        'paper',
        '--search-type',
        'research_paper',
        '--pub-year-min',
        '0',
        '--pub-year-max',
        '9999',
      ])
    ).exit,
    0,
  );
  assert.equal(f.calls[1].url.searchParams.get('pub_year_min'), '0');
  assert.equal(f.calls[1].url.searchParams.get('pub_year_max'), '9999');
  assert.equal(f.calls[1].url.searchParams.has('location'), false);
  assert.equal(f.calls[1].url.searchParams.has('language'), false);
});

test('TinyFish validates search bounds and incompatible options before any HTTP', async (t) => {
  const f = await fixture(t);
  for (const extra of [
    ['--limit', '5'],
    ['--page', '-1'],
    ['--page', '11'],
    ['--page', '1.0'],
    ['--page', '1e0'],
    ['--page', '0', '--page', '1'],
    ['--location', 'two words'],
    ['--purpose', ' '],
    ['--purpose', 'a'.repeat(2001)],
    ['--search-type', 'images'],
    ['--recency-minutes', '0'],
    ['--recency-minutes', '5256001'],
    ['--recency-minutes', '1', '--after-date', '2026-01-01'],
    ['--after-date', '2025-02-29'],
    ['--before-date', '2026-10-01T00:00:00Z'],
    ['--after-date', '2026-10-02', '--before-date', '2026-10-01'],
    ['--pub-year-min', '2020'],
    ['--search-type', 'research_paper', '--recency-minutes', '5'],
    ['--search-type', 'research_paper', '--pub-year-min', '2026', '--pub-year-max', '2025'],
    ['--search-type', 'research_paper', '--pub-year-max', '10000'],
    ['--include-domains', 'https://example.org'],
    ['--exclude-domains', 'example.org/path'],
  ]) {
    const r = await f.run(['tinyfish', 'search', 'query', ...extra, '--format=json']);
    assert.equal(r.exit, 2, `${extra}: ${r.channels.out}`);
  }
  for (const query of [' ', 'a'.repeat(2001)])
    assert.equal((await f.run(['tinyfish', 'search', query])).exit, 2);
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.run(['tinyfish', 'search', '😀'.repeat(2000), '--recency-minutes', '5256000'])).exit,
    0,
  );
});

test('TinyFish search retains useful fields and all results, with stable empty and invalid results', async (t) => {
  const f = await fixture(t);
  const rich = {
    ...hit,
    date: '2026-10-01',
    publisher: 'Publisher',
    authors: ['A', 'B'],
    venue: 'Journal',
    year: 2025,
    cited_by_count: 0,
    pdf_url: 'https://example.org/p.pdf',
    thumbnail_url: 'https://example.org/p.png',
  };
  f.reply({
    ...search,
    results: Array.from({ length: 25 }, (_, n) => ({ ...rich, position: n + 1 })),
    total_results: 25,
  });
  const r = await f.run(['tinyfish', 'search', 'q', '--format=json']);
  assert.equal(r.exit, 0);
  assert.equal(r.json().data.results.length, 25);
  assert.deepEqual(r.json().data.results[0], rich);
  assert.deepEqual(Object.keys(r.json().data), ['provider', 'page', 'results']);
  f.reply({ page: 2, results: [] });
  assert.deepEqual((await f.run(['tinyfish', 'search', 'q', '--format=json'])).json(), {
    status: 'success',
    data: { provider: 'tinyfish', page: 2, results: [] },
  });
  for (const body of [
    null,
    {},
    { page: 0, results: 'bad' },
    { results: [hit] },
    { ...search, results: [{ ...rich, cited_by_count: '0' }, hit] },
  ]) {
    f.reply(body);
    const bad = await f.run(['tinyfish', 'search', 'q', '--format=json']);
    assert.equal(bad.exit, 4, bad.channels.out);
    assert.equal(bad.json().error.code, 'INVALID_RESPONSE');
  }
  f.reply({ ...search, results: [{ url: false }, hit] });
  const partial = (await f.run(['tinyfish', 'search', 'q', '--format=json'])).json();
  assert.equal(partial.status, 'error');
  assert.deepEqual(partial.data.results, [hit]);
  assert.equal(partial.error.details.provider, undefined);
  assert.equal(partial.error.details.http_status, undefined);
});

test('TinyFish fetch maps batch and selectors without truncating body or metadata', async (t) => {
  const f = await fixture(t);
  const content =
    ' \n# Guide\n\n```sh\nrun\n```\n' +
    '中文😀'.repeat(12000) +
    '\nenable javascript and cookies to continue\n ';
  const extra = 'https://example.org/other';
  const metadata = { canonical: extra, og: { image: ['a', 'b'], score: 0, enabled: false } };
  f.reply({
    results: [
      {
        ...page(),
        text: content,
        description: content,
        final_url: extra,
        language: 'zh',
        author: 'Author',
        published_date: '2026-10-01',
        links: ['mailto:a@example.org', extra],
        image_links: [],
        page_metadata: metadata,
        unmatched_selectors: ['aside'],
        latency_ms: 0,
      },
      page(extra),
    ],
    errors: [],
  });
  const r = await f.run([
    'tinyfish',
    'fetch',
    url,
    extra,
    '--purpose',
    'Read\narticle',
    '--ttl',
    '0',
    '--per-url-timeout-ms',
    '1',
    '--target-selector',
    'main, article',
    '--target-selector',
    'aside',
    '--remove-selector',
    '.ad\n',
    '--include-links',
    '--include-image-links',
    '--include-metadata',
    '--format=json',
    '--verbose',
  ]);
  assert.equal(r.exit, 0, r.channels.out);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.path, '/tf-fetch/');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers['x-api-key'], 'tinyfish-fixture-key');
  assert.deepEqual(call.body, {
    urls: [url, extra],
    format: 'markdown',
    purpose: 'Read\narticle',
    include_selectors: ['main, article', 'aside'],
    exclude_selectors: ['.ad\n'],
    links: true,
    image_links: true,
    page_metadata: true,
    ttl: 0,
    per_url_timeout_ms: 1,
  });
  const data = r.json().data;
  assert.equal(data.results[0].text, content);
  assert.equal(data.results[0].description, undefined);
  assert.equal(data.results[0].latency_ms, undefined);
  assert.deepEqual(data.results[0].page_metadata, metadata);
  assert.deepEqual(data.results[1].missing_content, ['links', 'image_links']);
  assert.deepEqual(r.json().meta.attempts[0].page_latencies, [{ url, latency_ms: 0 }]);
  const md = await f.run(['tinyfish', 'fetch', url, '--include-links', '--include-image-links']);
  assert.equal(md.exit, 4); // The same two-result response cannot satisfy a one-URL request.
  assert.ok(md.channels.out.includes(content));
  assert.ok(md.channels.out.includes('`mailto:a@example.org`'));
});

test('TinyFish batch bounds, duplicates, explicit options and repeated selectors', async (t) => {
  const f = await fixture(t);
  for (const args of [
    [],
    Array(11).fill(url),
    [url, '--ttl', '-1'],
    [url, '--per-url-timeout-ms', '110001'],
    [url, '--target-selector', ' '],
    [url, '--target-selector', 'a'.repeat(1001)],
    [url, ...Array(21).fill(['--target-selector', 'main']).flat()],
    [url, '--include-links', '--include-links'],
  ]) {
    assert.equal((await f.run(['tinyfish', 'fetch', ...args])).exit, 2, String(args));
  }
  assert.equal(f.calls.length, 0);
  assert.equal(
    (
      await f.run([
        'tinyfish',
        'fetch',
        ...Array(10).fill(url),
        '--ttl',
        '3600',
        '--per-url-timeout-ms',
        '110000',
      ])
    ).exit,
    0,
  );
  assert.equal((f.calls[0].body!.urls as string[]).length, 10);
  assert.equal(f.calls[0].body!.per_url_timeout_ms, 110000);
});

test('TinyFish distinguishes per-page failures, partial batches and invalid input without retrying completed results', async (t) => {
  const f = await fixture(t);
  const entries = [
    'timeout',
    'target_http_error',
    'page_not_found',
    'bot_blocked',
    'empty_content',
    'login_required',
    'content_too_large',
    'target_unreachable',
    'proxy_error',
    'invalid_redirect_url',
    'selector_not_matched',
    'selector_unsupported',
  ];
  for (const tag of entries) {
    f.reply({
      results: [],
      errors: [{ url, error: tag, ...(tag === 'target_http_error' ? { status: 403 } : {}) }],
    });
    const before = f.calls.length;
    const r = await f.run(['tinyfish', 'fetch', url, '--format=json'], { UNISEARCH_RETRIES: '2' });
    assert.equal(r.exit, 4);
    assert.equal(r.json().error.code, 'CONTENT_UNAVAILABLE', tag);
    assert.equal(r.json().error.details.upstream_code, tag);
    assert.equal(r.json().error.details.http_status, undefined);
    assert.equal(r.json().error.details.failures, undefined);
    assert.equal(f.calls.length, before + 1);
  }
  const other = 'https://example.org/b';
  f.reply({
    results: [page()],
    errors: [
      {
        url: other,
        error: 'selector_not_matched',
        unmatched_selectors: ['article'],
        candidate_selectors: ['main', '#content'],
      },
    ],
  });
  const mixed = await f.run(['tinyfish', 'fetch', url, other, '--format=json']);
  assert.equal(mixed.exit, 6);
  assert.equal(mixed.json().error.details.provider, undefined);
  assert.deepEqual(mixed.json().error.details.failures[0].details.candidate_selectors, [
    'main',
    '#content',
  ]);
  f.reply({ results: [], errors: [{ url, error: 'unknown_failure' }] });
  assert.equal(
    (await f.run(['tinyfish', 'fetch', url, '--format=json'])).json().error.code,
    'UPSTREAM_ERROR',
  );
  f.reply({ results: [page()], errors: [{ url: other, error: 'invalid_url' }] });
  const argument = await f.run(['tinyfish', 'fetch', url, other, '--format=json']);
  assert.equal(argument.exit, 2);
  assert.equal(argument.json().data.results[0].text, page().text);
  f.reply({ results: [page()], errors: [{ url, error: 'timeout' }] });
  assert.equal((await f.run(['tinyfish', 'fetch', url, url])).exit, 6);
  assert.equal((await f.run(['tinyfish', 'fetch', url])).exit, 4);
});

test('TinyFish response corruption preserves independently valid body without inventing successful pages', async (t) => {
  const f = await fixture(t);
  for (const body of [
    { results: [], errors: [] },
    { results: [page()] },
    { errors: [] },
    { results: [page(), page()], errors: [] },
    { results: [{ ...page(), title: false }], errors: [] },
    { results: [{ ...page(), text: {} }], errors: [] },
    { results: [{ ...page(), format: 'html' }], errors: [] },
    { results: [{ ...page(), links: false }], errors: [] },
    { results: [{ ...page(), latency_ms: -1 }], errors: [] },
    { results: [], errors: [{ url, error: 'page_not_found', status: '404' }] },
  ]) {
    f.reply(body);
    const r = await f.run(['tinyfish', 'fetch', url, '--format=json']);
    assert.equal(r.exit, 4, JSON.stringify(body));
    assert.equal(r.json().error.code, 'INVALID_RESPONSE');
  }
  f.reply({ results: [{ ...page(), title: false }], errors: [] });
  const r = await f.run(['tinyfish', 'fetch', url, '--format=json']);
  assert.equal(r.json().data.results[0].text, page().text);
  assert.deepEqual(r.json().error.details, { field: 'results[0].title' });
  f.reply({ results: [{ ...page(), text: ' ', author: 'Author' }], errors: [] });
  const empty = await f.run(['tinyfish', 'fetch', url, '--format=json']);
  assert.equal(empty.json().error.code, 'CONTENT_UNAVAILABLE');
  assert.equal(empty.json().data.results[0].author, 'Author');
  assert.equal(empty.json().data.results[0].text, undefined);
  f.handle((_call, res) => res.end(Buffer.from([0xff, 0xfe])));
  const invalid = await f.run(['tinyfish', 'fetch', url, '--format=json']);
  assert.equal(invalid.json().error.code, 'INVALID_RESPONSE');
  assert.equal(invalid.json().data, undefined);
});

test('TinyFish maps HTTP and structured errors, never follows endpoint redirects, and preserves diagnostics', async (t) => {
  const f = await fixture(t);
  for (const [status, tag, code, exit] of [
    [400, 'INVALID_INPUT', 'INVALID_ARGUMENT', 2],
    [422, 'INVALID_INPUT', 'INVALID_ARGUMENT', 2],
    [401, 'INVALID_API_KEY', 'AUTHENTICATION_ERROR', 3],
    [403, 'FORBIDDEN', 'ACCESS_DENIED', 3],
    [429, 'RATE_LIMIT_EXCEEDED', 'RATE_LIMITED', 4],
    [429, 'DAILY_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED', 4],
    [402, 'INSUFFICIENT_CREDITS', 'QUOTA_EXCEEDED', 4],
    [408, 'TIMEOUT', 'TIMEOUT', 4],
    [504, 'BACKEND_UNAVAILABLE', 'TIMEOUT', 4],
    [500, 'INTERNAL_ERROR', 'UPSTREAM_ERROR', 4],
    [503, 'SERVICE_BUSY', 'UPSTREAM_ERROR', 4],
    [404, 'NOT_FOUND', 'UPSTREAM_ERROR', 4],
  ] as const) {
    f.reply(error(tag), status, { 'x-request-id': 'fixture-id' });
    const r = await f.run(['tinyfish', 'fetch', url, '--format=json']);
    assert.equal(r.exit, exit);
    assert.equal(r.json().error.code, code);
    assert.equal(r.json().error.details.http_status, status);
    assert.equal(r.json().error.details.request_id, 'fixture-id');
  }
  f.reply(error('FORBIDDEN'), 402);
  assert.equal(
    (await f.run(['tinyfish', 'search', 'q', '--format=json'])).json().error.code,
    'ACCESS_DENIED',
  );
  assert.equal(
    (await f.run(['tinyfish', 'fetch', url, '--format=json'])).json().error.code,
    'UPSTREAM_ERROR',
  );
  f.handle((_call, res) => {
    res.writeHead(401);
    res.end('<html>Unauthorized</html>');
  });
  const invalid = (await f.run(['tinyfish', 'fetch', url, '--format=json'])).json();
  assert.equal(invalid.error.code, 'AUTHENTICATION_ERROR');
  assert.equal(invalid.error.details.reason, 'error_body_invalid');
  f.reply({}, 302, { location: `${f.base}/forbidden-redirect` });
  const before = f.calls.length;
  assert.equal((await f.run(['tinyfish', 'fetch', url])).exit, 4);
  assert.equal(f.calls.length, before + 1);
});

test('TinyFish output files preserve success, empty search and useful failure data, while pure failures preserve the old file', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, '结果 with spaces.json');
  writeFileSync(path, 'old');
  const ready = await f.run(['tinyfish', 'fetch', url, '--output', path, '--format=json']);
  assert.equal(ready.exit, 0);
  assert.equal(ready.channels.out, '');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).data.results[0].text, page().text);
  f.reply({ results: [{ ...page(), title: false }], errors: [] });
  const bad = await f.run(['tinyfish', 'fetch', url, '--output', path, '--format=json']);
  assert.equal(bad.exit, 4);
  assert.equal(bad.channels.out, '');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).data.results[0].text, page().text);
  f.reply({ results: [], errors: [{ url, error: 'bot_blocked' }] });
  const previous = readFileSync(path, 'utf8');
  assert.equal(
    (await f.run(['tinyfish', 'fetch', url, '--output', path, '--format=json'])).exit,
    4,
  );
  assert.equal(readFileSync(path, 'utf8'), previous);
  f.reply({ results: [], page: 0 });
  assert.equal(
    (await f.run(['tinyfish', 'search', 'none', '--output', path, '--format=json'])).exit,
    0,
  );
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).data.results, []);
  const before = f.calls.length;
  assert.equal(
    (await f.run(['tinyfish', 'fetch', url, '--output', join(f.root, 'missing', 'file')])).exit,
    5,
  );
  assert.equal(f.calls.length, before);
  assert.deepEqual(readdirSync(f.root).sort(), ['config.json', '结果 with spaces.json'].sort());
});
