import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as jina from '../src/providers/jina.js';
import { localStatus } from '../src/config/status.js';
import { fixture, envelope, page, url } from './jina-helpers.js';

const key = { UNISEARCH_JINA_API_KEY: 'fixture-jina-secret' };

test('Jina native POST preserves targets, selectors and independent connection prefixes', async (t) => {
  const f = await fixture(t);
  const before = readFileSync(f.file, 'utf8');
  const result = await f.run([
    'jina',
    'fetch',
    url,
    '--format=json',
    '--target-selector',
    ':is(main, article)',
    '--remove-selector',
    'nav, .ad',
    '--wait-for-selector',
    'main .ready',
    '--no-cache',
    '--max-tokens',
    '500',
  ]);
  assert.equal(result.exit, 0);
  assert.deepEqual(f.calls[0].body, {
    respondWith: 'markdown',
    url,
    targetSelector: [':is(main, article)'],
    removeSelector: ['nav, .ad'],
    waitForSelector: ['main .ready'],
    noCache: true,
    maxTokens: 500,
  });
  assert.equal(f.calls[0].path, '/reader/');
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].headers.accept, 'application/json');
  assert.equal(f.calls[0].headers['content-type'], 'application/json');
  assert.equal(f.calls[0].headers.authorization, undefined);
  for (const options of [[], ['--wait-for-selector', 'main']]) {
    assert.equal((await f.run(['jina', 'fetch', url, ...options], key)).exit, 0);
    assert.equal(f.calls.at(-1)?.body.respondWith, 'content');
    assert.equal(f.calls.at(-1)?.body.noCache, undefined);
    assert.equal(f.calls.at(-1)?.headers.authorization, `Bearer ${key.UNISEARCH_JINA_API_KEY}`);
  }
  assert.equal((await f.run(['jina', 'fetch', url, '--remove-selector', 'aside'])).exit, 0);
  assert.equal(f.calls.at(-1)?.body.respondWith, 'markdown');
  const query = ` site:example.org 中文 ${'a'.repeat(600)} `;
  for (const searchType of ['web', 'news', 'images']) {
    f.reply(envelope([{ ...page, imageUrl: 'https://example.org/image.png' }]));
    const result = await f.run(
      [
        'jina',
        'search',
        query,
        '--format=json',
        '--limit',
        '20',
        '--country',
        'US',
        '--language',
        'sr-ME',
        '--search-type',
        searchType,
      ],
      key,
    );
    assert.equal(result.exit, 0);
    assert.equal(result.json().data.search_type, searchType);
    assert.deepEqual(f.calls.at(-1)?.body, {
      q: query,
      num: 20,
      type: searchType,
      gl: 'US',
      hl: 'sr-ME',
      fallback: false,
    });
    assert.equal(f.calls.at(-1)?.headers['x-respond-with'], 'no-content');
    assert.equal(f.calls.at(-1)?.path, '/searcher/search');
  }
  f.reply(envelope([{ ...page, imageUrl: 'https://example.org/image.png' }]));
  assert.equal((await f.run(['jina', 'search', query, '--include-text'], key)).exit, 0);
  assert.equal(f.calls.at(-1)?.body.respondWith, 'content');
  assert.equal(f.calls.at(-1)?.headers['x-respond-with'], undefined);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('Jina config CRUD, environment origins and operation readiness share effective settings', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(['config', 'set', 'providers.jina.search.limit', '1'])).exit, 0);
  assert.equal((await f.run(['config', 'set', 'providers.jina.fetch.max_tokens', '800'])).exit, 2);
  const before = readFileSync(f.file, 'utf8');
  const status = (await f.run(['status', '--json']))
    .json()
    .data.services.find((item: { provider: string }) => item.provider === 'jina');
  assert.equal(status.state, 'ready');
  assert.deepEqual(
    status.operations.map((item: { operation: string; state: string }) => [
      item.operation,
      item.state,
    ]),
    [
      ['fetch', 'ready'],
      ['search', 'missing'],
    ],
  );
  const configured = await f.run(['config', 'get', 'providers.jina.api_key'], key);
  assert.equal(configured.json().data.value, '[REDACTED]');
  assert.equal(configured.json().data.source, 'UNISEARCH_JINA_API_KEY');
  assert.equal((await f.run(['config', 'list'])).exit, 0);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.run(['jina', 'fetch', url, '--max-tokens', '900'])).exit, 0);
  assert.equal(f.calls.at(-1)?.body.maxTokens, 900);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  for (const [values, expected] of [
    [{}, ['ready', 'missing']],
    [{ api_key: 'secret' }, ['ready', 'ready']],
    [{ enabled: false }, ['disabled', 'disabled']],
    [{ api_key: '' }, ['invalid', 'invalid']],
    [{ reader_url: 'bad', api_key: 'secret' }, ['invalid', 'ready']],
    [{ search: { limit: 0 } }, ['ready', 'invalid']],
  ] as const) {
    const result = localStatus({ providers: { jina: values } }, {}, 'en', jina.operations)
      .services[0];
    const states = result.operations?.map((item) => item.state) ?? [result.state, result.state];
    assert.deepEqual(states, expected);
  }
  f.save({ providers: { jina: { search: { limit: 'bad' } } } });
  assert.equal((await f.run(['jina', 'fetch', url, '--max-tokens', '500'])).exit, 0);
  f.reply(envelope([page]));
  assert.equal((await f.run(['jina', 'search', 'q', '--limit', '1'], key)).exit, 0);
  assert.equal(f.calls.at(-1)?.body.maxTokens, undefined);
  assert.equal((await f.run(['config', 'unset', 'providers.jina'])).exit, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {});
});

test('Jina rejects invalid inputs, credentials and disabled operations before HTTP', async (t) => {
  const f = await fixture(t);
  for (const options of [
    ['--max-tokens', '499'],
    ['--max-tokens', '-1'],
    ['--max-tokens', '5e2'],
    ['--max-tokens', '500.0'],
    ['--max-tokens', '9007199254740992'],
    ['--target-selector', ' '],
    ['--remove-selector', '\nmain'],
    ['--max-tokens', '500', '--max-tokens', '600'],
    ['--unknown'],
    [url],
  ])
    assert.equal((await f.run(['jina', 'fetch', url, ...options])).exit, 2, options.join(' '));
  for (const options of [
    ['--limit', '0'],
    ['--limit', '21'],
    ['--country', 'USA'],
    ['--country', '中英'],
    ['--language', 'en US'],
    ['--language', 'en\u0000'],
    ['--search-type', 'video'],
    ['--limit', '1', '--limit', '2'],
    ['--include-text', '--include-text'],
  ])
    assert.equal((await f.run(['jina', 'search', 'q', ...options], key)).exit, 2);
  assert.equal((await f.run(['jina', 'search', ' \n '], key)).exit, 2);
  assert.equal((await f.run(['jina', 'search', 'q'])).exit, 3);
  for (const override of [{ UNISEARCH_JINA_API_KEY: '' }, { UNISEARCH_JINA_API_KEY: 'a b' }]) {
    for (const command of [
      ['jina', 'fetch', url],
      ['jina', 'search', 'q'],
    ])
      assert.equal((await f.run(command, override)).exit, 3);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.run(['jina', 'fetch', url, '--max-tokens', String(Number.MAX_SAFE_INTEGER)])).exit,
    0,
  );
  assert.equal(f.calls[0].body.maxTokens, Number.MAX_SAFE_INTEGER);
});

test('Jina maps complete content, metadata arrays, external relations and distinct dates without rewriting text', async (t) => {
  const f = await fixture(t);
  const metadata = { author: ['A', 'B'], nil: null, nested: { empty: [] }, 'line|key': 'a\nb' };
  const external = {
    canonical: { [url]: {} },
    alternate: { 'mailto:docs@example.org': { hreflang: 'en' } },
  };
  const content = '  # CAPTCHA\n\nDiscuss Authorization: example, not a challenge.\n';
  const entry = {
    ...page,
    content,
    description: 'Independent summary',
    publishedTime: 'today',
    date: 'today',
    source: 'Original publisher',
    metadata,
    external,
    numPages: 0,
    warning: 'Notice one\n## Notice two',
    imageUrl: 'https://example.org/img.png',
    imageWidth: 0,
    imageHeight: 12,
    siteLinks: [
      { title: '', link: url },
      { title: 'Docs', link: url },
    ],
  };
  f.reply(envelope([entry], 0));
  const result = await f.run(['jina', 'search', 'q', '--format=json', '--verbose'], key);
  assert.equal(result.exit, 0);
  assert.deepEqual(result.json().data, {
    provider: 'jina',
    search_type: 'web',
    results: [
      {
        url,
        title: 'Guide',
        text: content,
        description: 'Independent summary',
        published_date: 'today',
        date: 'today',
        source: 'Original publisher',
        metadata,
        external,
        num_pages: 0,
        warnings: ['Notice one\n## Notice two'],
        image_url: 'https://example.org/img.png',
        image_width: 0,
        image_height: 12,
        site_links: [{ url }, { title: 'Docs', url }],
      },
    ],
  });
  assert.equal(result.json().meta.attempts[0].billed_tokens, 0);
  const md = await f.run(['jina', 'search', 'q'], key);
  assert.match(md.channels.out, /Published: today/);
  assert.match(md.channels.out, /Search date label: today/);
  assert.match(md.channels.out, /Upstream warning: Notice one\n## Notice two/);
  assert.ok(md.channels.out.includes(content));
  assert.match(md.channels.out, /0 × 12/);
  assert.match(md.channels.out, /canonical/);
  assert.match(md.channels.out, /Document pages: 0/);
  assert.doesNotMatch(md.channels.out, /Billed usage/);
});

test('Jina preserves short independent descriptions and removes only exact title or complete text duplicates', async (t) => {
  const f = await fixture(t);
  for (const description of [page.title, page.content, '# Guide', 'Guide summary']) {
    f.reply(envelope({ ...page, description }));
    const result = await f.run(['jina', 'fetch', url, '--format=json']);
    const pageResult = result.json().data.results[0];
    const expectedKeys = ['url', 'title'];
    if (pageResult.description !== undefined) expectedKeys.push('description');
    expectedKeys.push('text');
    assert.deepEqual(Object.keys(pageResult), expectedKeys);
    assert.equal(
      pageResult.description,
      [page.title, page.content].includes(description) ? undefined : description,
    );
    assert.equal(pageResult.text, page.content);
  }
});

test('Jina search retains empty, short, oversized and partial result sets with stable public error indices', async (t) => {
  const f = await fixture(t);
  for (const entries of [[], [page]]) {
    f.reply(envelope(entries));
    const result = await f.run(['jina', 'search', 'q', '--format=json'], key);
    assert.equal(result.exit, 0);
    assert.equal(result.json().data.results.length, entries.length);
  }
  f.reply(envelope([page, page]));
  const excess = await f.run(
    ['jina', 'search', 'q', '--limit', '1', '--include-text', '--format=json'],
    key,
  );
  assert.equal(excess.exit, 4);
  assert.equal(excess.json().data.results.length, 2);
  for (const entries of [[{ url, title: 'Empty' }], [page, { url, content: null }]]) {
    f.reply(envelope(entries));
    const result = await f.run(['jina', 'search', 'q', '--include-text', '--format=json'], key);
    assert.equal(result.exit, 6);
    assert.equal(result.json().data.results.length, entries.length);
    assert.equal(result.json().error.details.failures[0].details.index, entries.length - 1);
  }
  f.reply(envelope([null, { url }, { ...page, title: 123 }]));
  const invalid = await f.run(['jina', 'search', 'q', '--include-text', '--format=json'], {
    ...key,
    UNISEARCH_RETRIES: '2',
  });
  assert.equal(invalid.exit, 4);
  assert.equal(invalid.json().data.results[1].text, page.content);
  assert.equal(invalid.json().error.details.causes[0].details.upstream_index, 0);
  assert.equal(invalid.json().error.details.causes[1].details.index, 1);
  assert.equal(invalid.json().error.details.failures[0].details.index, 0);
});

test('Jina image absence is partial while malformed URLs or field types explicitly retain independent data', async (t) => {
  const f = await fixture(t);
  for (const imageUrl of [undefined, null, ' ', 'bad', 123, 'https://example.org/img.png']) {
    f.reply(envelope([{ ...page, imageUrl }]));
    const result = await f.run(
      ['jina', 'search', 'q', '--search-type', 'images', '--format=json'],
      key,
    );
    const missing = imageUrl == null || imageUrl === ' ';
    let expected = 4;
    if (missing) expected = 6;
    else if (imageUrl === 'https://example.org/img.png') expected = 0;
    assert.equal(result.exit, expected);
    assert.equal(result.json().data.results[0].text, page.content);
    if (missing)
      assert.equal(result.json().error.details.failures[0].details.reason, 'missing_image');
  }
  for (const invalid of [
    { title: 0 },
    { content: {} },
    { description: [] },
    { numPages: -1 },
    { metadata: [] },
    { external: { canonical: { [url]: [] } } },
    { warning: [] },
    { httpStatus: '200' },
  ]) {
    f.reply(envelope({ ...page, ...invalid }));
    const result = await f.run(['jina', 'fetch', url, '--format=json']);
    assert.equal(result.exit, 4, JSON.stringify(invalid));
    assert.equal(result.json().data.results[0].url, url);
    if (!('content' in invalid)) assert.equal(result.json().data.results[0].text, page.content);
  }
});

test('Jina target errors use HTTP metadata and exact warning lines, retaining full warnings and error pages', async (t) => {
  const f = await fixture(t);
  for (const [extra, code, status] of [
    [{ content: ' ' }, 'CONTENT_UNAVAILABLE', undefined],
    [{ httpStatus: 403, httpStatusText: 'Origin denied' }, 'CONTENT_UNAVAILABLE', 403],
    [
      { warning: 'Before\nTarget URL returned error 404: missing\nAfter' },
      'CONTENT_UNAVAILABLE',
      404,
    ],
    [{ warning: 'Target URL returned error 404x' }, undefined, undefined],
    [{ warning: 'May need CAPTCHA' }, undefined, undefined],
    [{ httpStatus: 200, warning: 'Target URL returned error 403' }, 'INVALID_RESPONSE', undefined],
    [
      { warning: 'Target URL returned error 403\nTarget URL returned error 404' },
      'INVALID_RESPONSE',
      undefined,
    ],
  ] as const) {
    f.reply(envelope({ ...page, ...extra }));
    const result = await f.run(['jina', 'fetch', url, '--format=json']);
    assert.equal(result.json().error?.code, code);
    assert.equal(result.json().error?.details.page_status, status);
    if ('warning' in extra)
      assert.deepEqual(result.json().data.results[0].warnings, [extra.warning]);
    if ('httpStatusText' in extra)
      assert.equal(result.json().error.details.upstream_message, extra.httpStatusText);
  }
});

test('Jina validates HTTP envelopes, encodings and compatible business codes without redirects or anonymous retry', async (t) => {
  const f = await fixture(t);
  const cases = [
    [400, 40001, 'INVALID_ARGUMENT', 2],
    [401, 40102, 'AUTHENTICATION_ERROR', 3],
    [402, 40203, 'QUOTA_EXCEEDED', 4],
    [402, 40202, 'ACCESS_DENIED', 3],
    [403, 40305, 'ACCESS_DENIED', 3],
    [409, 40902, 'CONTENT_UNAVAILABLE', 4],
    [413, 41302, 'CONTENT_UNAVAILABLE', 4],
    [422, 42205, 'CONTENT_UNAVAILABLE', 4],
    [422, 42206, 'CONTENT_UNAVAILABLE', 4],
    [451, 45101, 'CONTENT_UNAVAILABLE', 4],
    [409, 40904, 'UPSTREAM_ERROR', 4],
    [422, 42203, 'INVALID_ARGUMENT', 2],
    [422, 42299, 'UPSTREAM_ERROR', 4],
    [404, 40401, 'UPSTREAM_ERROR', 4],
    [302, 30200, 'UPSTREAM_ERROR', 4],
    [408, 40800, 'TIMEOUT', 4],
    [429, 42903, 'RATE_LIMITED', 4],
    [500, 50002, 'UPSTREAM_ERROR', 4],
    [502, 50200, 'UPSTREAM_ERROR', 4],
    [503, 50304, 'UPSTREAM_ERROR', 4],
    [504, 50400, 'TIMEOUT', 4],
  ] as const;
  for (const [status, tag, code, exit] of cases) {
    f.reply(
      { code: status, status: tag, message: 'Diagnostic', readableMessage: 'Additional details' },
      status,
      { location: `${f.base}/redirect` },
    );
    const before = f.calls.length;
    const result = await f.run(['jina', 'fetch', url, '--format=json'], key);
    assert.equal(result.exit, exit, `${status}/${tag}`);
    assert.equal(result.json().error.code, code);
    assert.equal(result.json().error.details.upstream_code, tag);
    assert.equal(f.calls.length, before + 1);
    assert.equal(f.calls.at(-1)?.headers.authorization, `Bearer ${key.UNISEARCH_JINA_API_KEY}`);
  }
  f.reply({ code: 422, status: 42205, message: 'No content available' }, 422);
  assert.equal(
    (await f.run(['jina', 'search', 'q', '--format=json'], key)).json().error.code,
    'UPSTREAM_ERROR',
  );
  for (const body of [
    {},
    { code: 200, status: 40102, data: page },
    { code: 401, status: 40102, data: page },
    envelope([]),
  ]) {
    f.reply(body);
    const before = f.calls.length;
    const result = await f.run(['jina', 'fetch', url, '--format=json'], { UNISEARCH_RETRIES: '2' });
    assert.equal(result.json().error.code, 'INVALID_RESPONSE');
    assert.equal(f.calls.length, before + 1);
  }
  for (const status of [200, 401])
    for (const bytes of [Buffer.from([0xff]), Buffer.from('<html>bad</html>')]) {
      f.handle((_call, res) => {
        res.writeHead(status);
        res.end(bytes);
      });
      const result = await f.run(['jina', 'fetch', url, '--format=json']);
      assert.equal(
        result.json().error.code,
        status === 200 ? 'INVALID_RESPONSE' : 'AUTHENTICATION_ERROR',
      );
      if (status !== 200) assert.equal(result.json().error.details.reason, 'error_body_invalid');
    }
  f.reply({ code: 422, status: 40102, message: 'mismatch' }, 422);
  const mismatch = await f.run(['jina', 'fetch', url, '--format=json']);
  assert.equal(mismatch.json().error.code, 'UPSTREAM_ERROR');
  assert.equal(mismatch.json().error.details.reason, 'error_body_invalid');
});
