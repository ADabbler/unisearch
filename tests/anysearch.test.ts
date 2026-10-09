import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as anysearch from '../src/providers/anysearch.js';
import { localStatus } from '../src/config/status.js';
import { fixture, envelope, page, pageUrl, hit } from './anysearch-fixture.js';

test('AnySearch help, command arity, duplicate scalars and input validation precede HTTP', async (t) => {
  const f = await fixture(t);
  for (const language of ['en', 'zh']) {
    for (const command of [
      [],
      ['anysearch'],
      ...['search', 'domains', 'extract'].map((op) => ['anysearch', op]),
    ]) {
      const result = await f.run([...command, '--help'], { UNISEARCH_LANG: language });
      assert.equal(result.exit, 0);
      assert.match(result.channels.out, language === 'zh' ? /^用法：/ : /^Usage:/);
    }
    const group = await f.run(['anysearch'], { UNISEARCH_LANG: language });
    assert.equal(
      group.channels.out,
      (await f.run(['anysearch', '--help'], { UNISEARCH_LANG: language })).channels.out,
    );
  }
  for (const args of [
    ['search'],
    ['extract'],
    ['domains', 'one', 'two'],
    ['extract', pageUrl, pageUrl],
    ['search', 'q', '--unknown'],
    ['search', 'q', '--max-results', '3'],
    ['extract', pageUrl, '--max-length', '100'],
    ['search', ''],
    ['search', ' \n '],
    ...['0', '11', '1.5', '-1', '1e1', '01', ' '].map((n) => ['search', 'q', '--limit', n]),
    ...['', 'code', 'code.', '.doc', 'code.doc.extra', 'code. doc'].map((tag) => [
      'search',
      'q',
      '--tag',
      tag,
    ]),
    ...['{', '[]', 'null', '1', 'true', 'x=y', '@file', '{"nested":[1e400]}'].map((params) => [
      'search',
      'q',
      '--params',
      params,
    ]),
    ['search', 'q', '--zone', 'us'],
    ['search', 'q', '--language', 'en US'],
    ['domains', ''],
    ['domains', 'two words'],
    ['extract', 'relative'],
    ['extract', 'https://u:p@example.org'],
    ...[
      ['--limit', '1'],
      ['--tag', 'code.doc'],
      ['--params', '{}'],
      ['--zone', 'cn'],
      ['--language', 'en'],
    ].map((option) => ['search', 'q', ...option, ...option]),
  ]) {
    const result = await f.run(['anysearch', args[0], '--format=json', ...args.slice(1)]);
    assert.equal(result.exit, 2, JSON.stringify(args));
    assert.equal(result.json().error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(f.calls.length, 0);
});

test('AnySearch search preserves explicit REST fields, limit precedence, language independence and --', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, '.env'), 'UNISEARCH_ANYSEARCH_API_KEY=ignored\n');
  const query = '  中文 + & ? # release  ';
  for (const n of [undefined, '1', '10']) {
    const result = await f.run([
      'anysearch',
      'search',
      '--format=json',
      query,
      ...(n ? ['--limit', n] : []),
    ]);
    assert.equal(result.exit, 0, result.channels.out);
    const call = f.calls.at(-1)!;
    assert.equal(call.path, '/gateway/v1/search');
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.body, { query, max_results: n ? Number(n) : 5, format: 'markdown' });
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers.accept, 'application/json');
    assert.equal(call.headers['content-type'], 'application/json');
  }
  f.save({ providers: { anysearch: { search: { limit: 3 } } } });
  const params = {
    library: '中文',
    flag: false,
    count: 0,
    blank: '',
    nested: { choices: [1, null, true] },
    __custom: 'value',
  };
  await f.run(
    [
      'anysearch',
      'search',
      '--format=json',
      query,
      '--tag',
      'future.new',
      '--params',
      JSON.stringify(params),
      '--zone',
      'intl',
      '--language',
      'en',
    ],
    { UNISEARCH_LANG: 'zh' },
  );
  assert.deepEqual(f.calls.at(-1)!.body, {
    query,
    max_results: 3,
    format: 'markdown',
    tag: 'future.new',
    params,
    zone: 'intl',
    language: 'en',
  });
  for (const options of [
    ['--params', '{}'],
    ['--tag', 'code.doc'],
  ]) {
    await f.run(['anysearch', 'search', query, ...options]);
    assert.equal(f.calls.at(-1)!.body?.max_results, 3);
  }
  await f.run(['anysearch', 'search', query, '--limit', '2']);
  assert.equal(f.calls.at(-1)!.body?.max_results, 2);
  await f.run(['anysearch', 'search', '--format=json', '--', '--help']);
  assert.equal(f.calls.at(-1)!.body?.query, '--help');
  assert.ok(f.calls.every((call) => call.path.endsWith('/search')));
});

test('AnySearch catalog is offline and online domains retain usable parameter definitions', async (t) => {
  const f = await fixture(t);
  const bad = {
    providers: { anysearch: { base_url: 42, api_key: '', search: { limit: 0 } } },
    execution: { retries: 'bad', timeout_seconds: 0 },
  };
  f.save(bad);
  const result = await f.run(['anysearch', 'domains', '--verbose', '--format=json'], {
    UNISEARCH_ANYSEARCH_BASE_URL: '',
  });
  assert.equal(result.exit, 0, result.channels.out);
  assert.deepEqual(result.json(), {
    status: 'success',
    data: { provider: 'anysearch', catalog_source: 'bundled', domains: anysearch.rootDomains },
  });
  f.save({ providers: { anysearch: { enabled: false } } });
  assert.equal((await f.run(['anysearch', 'domains'])).exit, 3);
  assert.equal(f.calls.length, 0);
  f.save({});
  const description =
    'Values: `stock`, `crypto`; unit: USD; empty string "" means any.\nExample: 0.';
  const domains = [
    {
      domain: 'finance',
      description: 'Market',
      sub_domains: [
        {
          sub_domain: 'finance.quote',
          params: {
            first: { required: false, description, sort_order: 99 },
            second: { required: true, sort_order: 'ignored' },
          },
        },
      ],
    },
  ];
  f.reply(envelope({ domains }));
  const online = await f.run(['anysearch', 'domains', 'future+&?#中文', '--format=json']);
  assert.equal(online.exit, 0);
  const call = f.calls.at(-1)!;
  assert.equal(call.method, 'GET');
  assert.equal(call.body, undefined);
  assert.deepEqual([...call.url.searchParams], [['domain', 'future+&?#中文']]);
  assert.deepEqual(online.json().data.domains[0].sub_domains[0].params, {
    first: { required: false, description },
    second: { required: true },
  });
  assert.equal(online.json().data.catalog_source, undefined);
  for (const domains of [[], [{ domain: 'future', sub_domains: [] }]]) {
    f.reply(envelope({ domains }));
    assert.deepEqual(
      (await f.run(['anysearch', 'domains', 'future', '--format=json'])).json().data.domains,
      domains,
    );
  }
});

test('AnySearch extract sends only the original URL and preserves long bodies and returned URLs', async (t) => {
  const f = await fixture(t);
  for (const content of [
    '# Markdown\n\n```ts\nrun();\n```',
    '<article>HTML</article>',
    '{"valid":true}',
    'plain text',
  ].map((s) => s.repeat(5000))) {
    f.reply(envelope({ ...page, url: 'https://example.org/returned', content, title: null }));
    const result = await f.run(['anysearch', 'extract', pageUrl, '--format=json']);
    assert.equal(result.exit, 0);
    assert.deepEqual(f.calls.at(-1)!.body, { url: pageUrl });
    assert.deepEqual(result.json().data, {
      provider: 'anysearch',
      url: 'https://example.org/returned',
      text: content,
    });
  }
  const base = 'https://example.org/中文?key=';
  const length = Buffer.byteLength(JSON.stringify({ url: base }));
  const exact = base + 'x'.repeat(16384 - length);
  assert.equal((await f.run(['anysearch', 'extract', exact])).exit, 0);
  assert.equal(f.calls.at(-1)!.raw.length, 16384);
  const before = f.calls.length;
  assert.equal((await f.run(['anysearch', 'extract', exact + 'x'])).exit, 2);
  assert.equal(f.calls.length, before);
});

test('AnySearch config management, effective overrides and status use actual operations without HTTP', async (t) => {
  const f = await fixture(t);
  for (const [field, value] of [
    ['base_url', 'https://example.org/gateway'],
    ['search.limit', '3'],
    ['api_key', 'fixture-saved-key'],
  ]) {
    const result = await f.run(['config', 'set', `providers.anysearch.${field}`, value]);
    assert.equal(result.exit, 0, result.channels.out);
  }
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {
    providers: {
      jina: { enabled: false },
      anysearch: {
        base_url: 'https://example.org/gateway',
        search: { limit: 3 },
        api_key: 'fixture-saved-key',
      },
    },
  });
  const connection = (await f.run(['config', 'get', 'providers.anysearch.base_url'])).json().data;
  assert.equal(connection.value, f.env.UNISEARCH_ANYSEARCH_BASE_URL);
  assert.equal(connection.source, 'UNISEARCH_ANYSEARCH_BASE_URL');
  const saved = await f.run(['config', 'get', 'providers.anysearch.base_url'], {
    UNISEARCH_ANYSEARCH_BASE_URL: undefined,
  });
  assert.equal(saved.json().data.source, 'config');
  assert.doesNotMatch((await f.run(['config', 'list'])).channels.out, /fixture-saved-key/);
  assert.equal((await f.run(['config', 'set', 'providers.anysearch.search.limit', '11'])).exit, 2);
  assert.equal((await f.run(['config', 'unset', 'providers.anysearch'])).exit, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {
    providers: { jina: { enabled: false } },
  });
  assert.equal(
    (await f.run(['status', '--json']))
      .json()
      .data.services.find((s: { provider: string }) => s.provider === 'anysearch').state,
    'ready',
  );
  for (const [env, state] of [
    [{ UNISEARCH_ANYSEARCH_API_KEY: '' }, 'invalid'],
    [{ UNISEARCH_ANYSEARCH_BASE_URL: 'bad' }, 'invalid'],
  ] as const)
    assert.equal(localStatus({}, env, 'en', anysearch.operations).services[0].state, state);
  assert.equal(
    localStatus({ providers: { anysearch: { enabled: false } } }, {}, 'en', anysearch.operations)
      .services[0].state,
    'disabled',
  );
  const statuses = localStatus(
    { providers: { anysearch: { search: { limit: 0 } } } },
    {},
    'en',
    anysearch.operations,
  );
  assert.deepEqual(
    statuses.services[0].operations?.map((op) => [op.operation, op.state]),
    [
      ['search', 'invalid'],
      ['domains', 'ready'],
      ['extract', 'ready'],
    ],
  );
  const req = anysearch.prepare(
    'search',
    'q',
    {},
    { providers: { anysearch: { base_url: 'bad', api_key: '' } } },
    {
      UNISEARCH_ANYSEARCH_BASE_URL: f.env.UNISEARCH_ANYSEARCH_BASE_URL,
      UNISEARCH_ANYSEARCH_API_KEY: 'fixture-override',
    },
    'en',
  );
  assert.equal(req.apiKey, 'fixture-override');
  const defaults = anysearch.prepare(
    'search',
    'q',
    {},
    {},
    { ANYSEARCH_API_KEY: 'ignored', ANYSEARCH_API_URL: 'bad' },
    'en',
  );
  assert.equal(defaults.apiKey, undefined);
  assert.equal(defaults.url, 'https://api.anysearch.com/v1/search');
  assert.equal(f.calls.length, 0);
});

test('AnySearch search validates required data without discarding useful optional text or duplicate URLs', async (t) => {
  const f = await fixture(t);
  const results = [
    { ...hit, snippet: 'same', content: 'same' },
    { url: pageUrl, snippet: 'summary', content: 'summary and more' },
    { url: pageUrl, title: null, snippet: '', content: '  ' },
  ];
  f.reply(envelope({ results, metadata: { total_results: 999, search_time_ms: 1 } }));
  assert.deepEqual((await f.run(['anysearch', 'search', 'q', '--format=json'])).json().data, {
    provider: 'anysearch',
    results: [
      { url: pageUrl, title: hit.title, content: 'same' },
      { url: pageUrl, snippet: 'summary', content: 'summary and more' },
      { url: pageUrl },
    ],
  });
  for (const data of [
    {},
    { results: null },
    { results: [hit, hit] },
    { results: [{ url: 'bad' }] },
    ...['title', 'snippet', 'content'].map((key) => ({ results: [{ ...hit, [key]: 1 }] })),
  ]) {
    f.reply(envelope(data));
    const result = await f.run(['anysearch', 'search', 'q', '--limit', '1', '--format=json']);
    assert.equal(result.json().error.code, 'INVALID_RESPONSE');
  }
  f.reply(envelope({ results: [] }));
  assert.deepEqual(
    (await f.run(['anysearch', 'search', 'q', '--format=json'])).json().data.results,
    [],
  );
});

test('AnySearch domains and extract reject malformed required fields explicitly', async (t) => {
  const f = await fixture(t);
  for (const data of [
    {},
    { domains: null },
    { domains: [{}] },
    ...[
      { sub_domain: 'code.doc', params: { lang: {} } },
      { sub_domain: 'code.doc', params: { lang: { required: 'false' } } },
      { sub_domain: 'code.doc', params: null },
      { sub_domain: 'bad' },
      { sub_domain: 'code.doc', description: 0 },
    ].map((sub) => ({ domains: [{ domain: 'code', sub_domains: [sub] }] })),
  ]) {
    f.reply(envelope(data));
    assert.equal(
      (await f.run(['anysearch', 'domains', 'code', '--format=json'])).json().error.code,
      'INVALID_RESPONSE',
    );
  }
  for (const params of [undefined, {}]) {
    f.reply(
      envelope({
        domains: [{ domain: 'code', sub_domains: [{ sub_domain: 'code.doc', params }] }],
      }),
    );
    assert.equal(
      (await f.run(['anysearch', 'domains', 'code', '--format=json'])).json().data.domains[0]
        .sub_domains[0].params,
      undefined,
    );
  }
  for (const content of [undefined, null, 42, false]) {
    f.reply(envelope({ ...page, content }));
    assert.equal(
      (await f.run(['anysearch', 'extract', pageUrl, '--format=json'])).json().error.code,
      'INVALID_RESPONSE',
    );
  }
  f.reply(envelope({ ...page, content: ' \n ' }));
  const empty = (await f.run(['anysearch', 'extract', pageUrl, '--format=json'])).json();
  assert.equal(empty.error.code, 'CONTENT_UNAVAILABLE');
  assert.equal(empty.error.details.reason, 'empty_content');
  f.reply(envelope({ ...page, url: 'bad' }));
  assert.equal(
    (await f.run(['anysearch', 'extract', pageUrl, '--format=json'])).json().error.code,
    'INVALID_RESPONSE',
  );
});
