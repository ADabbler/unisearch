import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, hit, url } from './deepseek-fixture.js';

test('DeepSeek help, credential state and offline configuration', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['deepseek'],
    ['deepseek', '--help'],
    ['deepseek', 'search', '--help'],
    ['deepseek', 'fetch', '--help'],
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
      .data.services.find((s: { provider: string }) => s.provider === 'deepseek');
  assert.equal((await state()).state, 'ready');
  assert.equal((await state({ UNISEARCH_DEEPSEEK_API_KEY: undefined })).state, 'missing');
  assert.equal((await state({ UNISEARCH_DEEPSEEK_API_KEY: ' ' })).state, 'invalid');
});

test('DeepSeek search sends the documented body and renders every documented field', async (t) => {
  const f = await fixture(t);
  const result = await f.run([
    'deepseek',
    'search',
    'DeepSeek V4',
    '--include-domains',
    'github.com,huggingface.co',
    '--exclude-domains',
    'spam.example',
    '--language',
    'zh,en',
    '--after-date',
    '2025-01-01',
    '--before-date',
    '2026-06-01',
    '--question',
    'V4 有哪些改进？',
    '--format',
    'json',
  ]);
  assert.equal(result.exit, 0, result.channels.out);
  const call = f.calls.at(-1)!;
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, 'Bearer deepseek-fixture-key');
  assert.deepEqual(call.body, {
    query:
      'DeepSeek V4 site:github.com OR site:huggingface.co -site:spam.example lang:zh,en after:2025-01-01 before:2026-06-01',
    count: 10,
    need_content: false,
    ori_question: 'V4 有哪些改进？',
  });
  const item = result.json().data.results[0];
  assert.equal(item.url, url);
  assert.equal(item.title, hit.title);
  assert.equal(item.summary, hit.summary);
  // The short snippet is dropped because the long summary already carries the text.
  assert.equal(item.snippet, undefined);
  assert.equal(item.site_icon, undefined);
  assert.equal(item.authority, 3);
  assert.equal(item.rerank_score, 2.4);
  assert.equal(item.date, hit.date);
  assert.equal(item.site_name, hit.site_name);
});

test('DeepSeek filter flags reach the query only when given', async (t) => {
  const f = await fixture(t);
  await f.run(['deepseek', 'search', 'plain', '--format', 'json']);
  assert.deepEqual(f.calls.at(-1)!.body, { query: 'plain', count: 10, need_content: false });
  await f.run(['deepseek', 'search', 'plain', '--include-text', '--format', 'json']);
  assert.equal(f.calls.at(-1)!.body!.need_content, true);
});

test('DeepSeek sends internationalized domains as ASCII hostnames', async (t) => {
  const f = await fixture(t);
  await f.run([
    'deepseek',
    'search',
    'plain',
    '--include-domains',
    '例子.中国,Example.COM',
    '--exclude-domains',
    '百度.中国',
    '--format',
    'json',
  ]);
  assert.equal(
    f.calls.at(-1)!.body!.query,
    'plain site:xn--fsqu00a.xn--fiqs8s OR site:example.com -site:xn--wxtr44c.xn--fiqs8s',
  );
});

test('DeepSeek rejects input that would change query semantics before sending', async (t) => {
  const f = await fixture(t);
  const cases: [string[], string][] = [
    [['--include-domains', '*.example.com'], '--include-domains'],
    [['--include-domains', 'example.com/path'], '--include-domains'],
    // Empty labels and leading dashes would produce expressions the API cannot honour.
    [['--include-domains', 'a.'], '--include-domains'],
    [['--include-domains', 'a..b'], '--include-domains'],
    [['--include-domains', '-a.com'], '--include-domains'],
    [['--exclude-domains', 'bad domain'], '--exclude-domains'],
    [['--language', 'zh en'], '--language'],
    [['--language', 'zh,'], '--language'],
    [['--after-date', '2025-13-01'], '--after-date'],
    [['--before-date', '2025/01/01'], '--before-date'],
    [['--after-date', '2025-06-01', '--before-date', '2025-01-01'], '--after-date/--before-date'],
    [['--question', ''], '--question'],
  ];
  for (const [flags, option] of cases) {
    const before = f.calls.length;
    const result = await f.run(['deepseek', 'search', 'q', ...flags, '--format', 'json']);
    assert.equal(result.exit, 2, `${flags.join(' ')} ${result.channels.out}`);
    assert.equal(result.json().error.code, 'INVALID_ARGUMENT');
    assert.equal(result.json().error.details.option, option);
    assert.equal(f.calls.length, before, 'no request may be sent');
  }
});

test('DeepSeek reports which options pushed the query past 128 characters', async (t) => {
  const f = await fixture(t);
  const result = await f.run([
    'deepseek',
    'search',
    'a'.repeat(121),
    '--language',
    'zh',
    '--format',
    'json',
  ]);
  assert.equal(result.exit, 2);
  assert.equal(result.json().error.details.option, '--language');
  const overQuery = await f.run(['deepseek', 'search', 'a'.repeat(129), '--format', 'json']);
  assert.equal(overQuery.exit, 2);
  assert.equal(overQuery.json().error.details.option, 'QUERY');
  assert.doesNotMatch(overQuery.json().error.message, /option/i);
  // A query that already overflows is blamed even when a filter is also present.
  const both = await f.run([
    'deepseek',
    'search',
    'a'.repeat(130),
    '--language',
    'zh',
    '--format',
    'json',
  ]);
  assert.equal(both.json().error.details.option, 'QUERY');
  assert.doesNotMatch(both.json().error.message, /option/i);
  // Every given filter is listed, since any of them may be the one to drop.
  const many = await f.run([
    'deepseek',
    'search',
    'a'.repeat(105),
    '--language',
    'zh',
    '--after-date',
    '2025-01-01',
    '--format',
    'json',
  ]);
  assert.equal(many.json().error.details.option, '--language/--after-date');
});

test('DeepSeek fetch posts only the URL and maps terminal page statuses', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['deepseek', 'fetch', url, '--format', 'json']);
  assert.equal(result.exit, 0, result.channels.out);
  const call = f.calls.at(-1)!;
  assert.equal(call.path, '/ds/v1/tools/fetch');
  assert.deepEqual(call.body, { url });
  assert.deepEqual(result.json().data.results, [
    { url, title: 'Install guide', text: '# Install\n\nRun `npm i`.' },
  ]);
});

test('DeepSeek maps documented HTTP failures to the shared error codes', async (t) => {
  const f = await fixture(t);
  const expectations: [number, string, number][] = [
    [400, 'INVALID_ARGUMENT', 2],
    [401, 'AUTHENTICATION_ERROR', 3],
    [402, 'QUOTA_EXCEEDED', 4],
    [403, 'ACCESS_DENIED', 3],
    [413, 'INVALID_ARGUMENT', 2],
    [429, 'RATE_LIMITED', 4],
    [500, 'UPSTREAM_ERROR', 4],
    [504, 'TIMEOUT', 4],
  ];
  for (const [status, code, exit] of expectations) {
    f.reply(
      {
        error: {
          message: `fixture ${status}`,
          type: 'fixture_error',
          code: 'fixture_code',
          param: null,
        },
      },
      status,
    );
    const result = await f.run(['deepseek', 'fetch', url, '--format', 'json']);
    assert.equal(result.exit, exit, `${status} ${result.channels.out}`);
    assert.equal(result.json().error.code, code, String(status));
    assert.equal(result.json().error.details.http_status, status);
    assert.equal(result.json().error.details.upstream_message, `fixture ${status}`);
    assert.equal(result.json().error.details.upstream_type, 'fixture_error');
    assert.equal(result.json().error.details.upstream_code, 'fixture_code');
  }
  // Only a page read can report "no usable content"; search never performs one.
  f.reply({ error: { message: 'fixture 404' } }, 404);
  const search = await f.run(['deepseek', 'search', 'q', '--format', 'json']);
  assert.equal(search.json().error.code, 'UPSTREAM_ERROR');
  const fetch = await f.run(['deepseek', 'fetch', url, '--format', 'json']);
  assert.equal(fetch.json().error.code, 'CONTENT_UNAVAILABLE');
});

test('DeepSeek appears in the extra-source list and its rejection message', async (t) => {
  const f = await fixture(t);
  for (const language of ['zh', 'en']) {
    const help = await f.run(['search', '--help'], { UNISEARCH_LANG: language });
    assert.equal(help.exit, 0);
    assert.match(help.channels.out, /deepseek/);
  }
  const invalid = await f.run(['search', 'q', '--extra-sources', 'unknown', '--format', 'json']);
  assert.equal(invalid.exit, 2);
  assert.match(invalid.json().error.message, /deepseek/);
});

test('DeepSeek 404 stays switchable because it only means no usable content', async (t) => {
  const f = await fixture(t);
  // Two mocked candidates keep the fallback observable without reaching a real service.
  f.save({ fetch: { providers: ['deepseek', 'exa'] } });
  Object.assign(f.env, {
    UNISEARCH_EXA_API_KEY: 'fixture-exa',
    UNISEARCH_EXA_BASE_URL: `${f.base}/exa`,
  });
  f.handle((call, res) => {
    if (call.path === '/ds/v1/tools/fetch') res.writeHead(404).end('{"error":{"message":"none"}}');
    else res.writeHead(500).end('{}');
  });
  const result = await f.run(['fetch', url, '--format', 'json']);
  assert.equal(result.json().data, undefined);
  const error = result.json().error;
  assert.equal(error.code, 'ALL_PROVIDERS_FAILED');
  const failures = error.details.failures as {
    provider: string;
    code: string;
    details?: unknown;
  }[];
  assert.deepEqual(
    failures.map((item) => [item.provider, item.code]),
    [
      ['deepseek', 'CONTENT_UNAVAILABLE'],
      ['exa', 'UPSTREAM_ERROR'],
    ],
  );
  // A page_status would have stopped the fallback before the second service was tried; only
  // the HTTP metadata of the refused call is retained.
  assert.deepEqual(failures[0].details, { http_status: 404, upstream_message: 'none' });
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ['/ds/v1/tools/fetch', '/exa/contents'],
  );
});

test('DeepSeek doctor reads the balance endpoint and reports exhausted accounts', async (t) => {
  const f = await fixture(t);
  const ok = await f.run(['doctor', 'deepseek', '--json']);
  assert.equal(ok.exit, 0, ok.channels.out);
  const call = f.calls.at(-1)!;
  assert.equal(call.path, '/ds/user/balance');
  assert.equal(call.method, 'GET');
  f.reply({ is_available: false, balance_infos: [] });
  const empty = await f.run(['doctor', 'deepseek', '--json']);
  assert.equal(empty.exit, 4);
  assert.equal(empty.json().error.code, 'QUOTA_EXCEEDED');
});
