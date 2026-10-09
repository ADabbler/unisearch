import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as zhipu from '../src/providers/zhipu.js';
import { fieldAt } from '../src/config/fields.js';
import { resolveField } from '../src/config/resolve.js';
import { AppError } from '../src/errors.js';
import { fixture, hit, page, reader, url } from './zhipu-fixture.js';

test('Zhipu platform defaults, overrides and config mutations preserve explicitly saved values', async (t) => {
  const f = await fixture(t);
  for (const [platform, base, engine] of [
    ['bigmodel', 'https://open.bigmodel.cn/api/paas/v4', 'search_std'],
    ['zai', 'https://api.z.ai/api/paas/v4', 'search-prime'],
  ]) {
    const env = {
      ...f.env,
      UNISEARCH_ZHIPU_PLATFORM: platform,
      UNISEARCH_ZHIPU_BASE_URL: undefined,
    };
    assert.equal(resolveField({}, env, fieldAt('providers.zhipu.base_url')).value, base);
    assert.equal(zhipu.prepare('search', 'q', {}, {}, env, 'en').body.search_engine, engine);
    assert.equal(zhipu.prepare('fetch', url, {}, {}, env, 'en').url, `${base}/reader`);
    const config = (
      await f.run(['config', 'get', 'providers.zhipu'], {
        UNISEARCH_ZHIPU_PLATFORM: platform,
        UNISEARCH_ZHIPU_BASE_URL: undefined,
      })
    ).json();
    assert.equal(config.data.value.base_url, base);
    assert.equal(config.data.value.api_key, '[REDACTED]');
    assert.equal(config.data.value.search.engine, engine);
    assert.equal(config.data.value.search.content_size, undefined);
  }
  await f.run(['config', 'set', 'providers.zhipu.base_url', `${f.base}/saved`]);
  await f.run(['config', 'set', 'providers.zhipu.platform', 'zai']);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {
    providers: {
      jina: { enabled: false },
      anysearch: { enabled: false },
      zhipu: { base_url: `${f.base}/saved`, platform: 'zai' },
    },
  });
  assert.equal(
    (
      await f.run(['config', 'get', 'providers.zhipu.base_url'], {
        UNISEARCH_ZHIPU_BASE_URL: undefined,
      })
    ).json().data.value,
    `${f.base}/saved`,
  );
  assert.equal(
    (await f.run(['config', 'get', 'providers.zhipu.base_url'])).json().data.source,
    'UNISEARCH_ZHIPU_BASE_URL',
  );
  await f.run(['config', 'unset', 'providers.zhipu.base_url']);
  assert.equal(
    (
      await f.run(['config', 'get', 'providers.zhipu.base_url'], {
        UNISEARCH_ZHIPU_BASE_URL: undefined,
      })
    ).json().data.value,
    'https://api.z.ai/api/paas/v4',
  );
  assert.equal(f.calls.length, 0);
  for (const field of ['base_url', 'search.engine', 'search.limit']) {
    const result = await f.run(['config', 'get', `providers.zhipu.${field}`], {
      UNISEARCH_ZHIPU_PLATFORM: 'bad',
    });
    assert.equal(result.exit, 3);
    assert.equal(result.json().error.details.field, 'providers.zhipu.platform');
  }
  assert.equal(
    (
      await f.run(['zhipu', 'search', 'q', '--engine', 'search_std'], {
        UNISEARCH_ZHIPU_PLATFORM: 'bad',
      })
    ).exit,
    3,
  );
});

test('Zhipu local status and operation preflight agree without coupling Reader to search', async (t) => {
  const f = await fixture(t);
  f.save({ providers: { zhipu: { search: { engine: 'search_pro' } } } });
  const env = { UNISEARCH_ZHIPU_PLATFORM: 'zai' };
  const status = (await f.run(['status', '--json'], env))
    .json()
    .data.services.find((s: { provider: string }) => s.provider === 'zhipu');
  assert.equal(status.state, 'ready');
  assert.deepEqual(
    status.operations.map((o: { operation: string; state: string }) => [o.operation, o.state]),
    [
      ['search', 'invalid'],
      ['fetch', 'ready'],
    ],
  );
  assert.equal((await f.run(['zhipu', 'search', 'q'], env)).exit, 3);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.run(['zhipu', 'fetch', url], env)).exit, 0);
  for (const overrides of [
    { UNISEARCH_ZHIPU_PLATFORM: '' },
    { UNISEARCH_ZHIPU_PLATFORM: 'unknown' },
    { UNISEARCH_ZHIPU_BASE_URL: 'bad' },
    { UNISEARCH_ZHIPU_API_KEY: '' },
    { UNISEARCH_ZHIPU_API_KEY: undefined },
  ]) {
    const before: number = f.calls.length;
    for (const op of ['search', 'fetch'])
      assert.equal((await f.run(['zhipu', op, op === 'search' ? 'q' : url], overrides)).exit, 3);
    assert.equal(f.calls.length, before);
    const local = (await f.run(['status', '--json'], overrides))
      .json()
      .data.services.find((s: { provider: string }) => s.provider === 'zhipu');
    assert.notEqual(local.state, 'ready');
  }
});

test('Zhipu search sends the exact documented domestic and international request contracts', async (t) => {
  const f = await fixture(t);
  for (const platform of ['bigmodel', 'zai']) {
    const query = '  原样 QUERY 😀\n第二行 ';
    const args = [
      'zhipu',
      'search',
      query,
      '--include-domains',
      ' gov.cn,xinhuanet.com ',
      '--recency',
      'oneWeek',
      '--limit',
      '2',
      '--format=json',
    ];
    if (platform === 'bigmodel') args.push('--engine', 'search_pro', '--content-size', 'high');
    const result = await f.run(args, { UNISEARCH_ZHIPU_PLATFORM: platform });
    assert.equal(result.exit, 0);
    const call = f.calls.at(-1)!;
    assert.equal(call.path, '/gateway/web_search');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, 'Bearer fixture-zhipu-key');
    assert.equal(call.headers.accept, 'application/json');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(call.body, {
      search_query: query,
      search_engine: platform === 'bigmodel' ? 'search_pro' : 'search-prime',
      count: 2,
      search_domain_filter: ' gov.cn,xinhuanet.com ',
      search_recency_filter: 'oneWeek',
      ...(platform === 'bigmodel' ? { search_intent: false, content_size: 'high' } : {}),
    });
    assert.deepEqual(result.json().data.results, [
      {
        url,
        title: hit.title,
        description: hit.content,
        source: hit.media,
        published_date: hit.publish_date,
        refer: hit.refer,
      },
    ]);
  }
  await f.run(['zhipu', 'search', 'q', '--recency', 'noLimit']);
  assert.deepEqual(f.calls.at(-1)!.body, {
    search_engine: 'search_std',
    search_query: 'q',
    search_intent: false,
    count: 10,
  });
});

test('Zhipu query validation counts Unicode code points without truncating or changing international queries', async (t) => {
  const f = await fixture(t);
  const query = '😀'.repeat(70);
  assert.equal((await f.run(['zhipu', 'search', query])).exit, 0);
  assert.equal(f.calls.at(-1)!.body!.search_query, query);
  for (const input of ['', ' \n ', query + 'a']) {
    const before = f.calls.length;
    assert.equal((await f.run(['zhipu', 'search', input])).exit, 2);
    assert.equal(f.calls.length, before);
  }
  const long = query.repeat(3);
  assert.equal(
    (await f.run(['zhipu', 'search', long], { UNISEARCH_ZHIPU_PLATFORM: 'zai' })).exit,
    0,
  );
  assert.equal(f.calls.at(-1)!.body!.search_query, long);
});

test('Zhipu engine capabilities distinguish default, saved and CLI values', async (t) => {
  const f = await fixture(t);
  f.reply({ search_result: [] });
  for (const limit of ['10', '20', '30', '40', '50'])
    assert.equal(
      (await f.run(['zhipu', 'search', 'q', '--engine', 'search_pro_sogou', '--limit', limit]))
        .exit,
      0,
    );
  await f.run([
    'zhipu',
    'search',
    'q',
    '--engine',
    'search_pro_sogou',
    '--include-domains',
    'example.org',
    '--recency',
    'oneDay',
  ]);
  assert.equal(f.calls.at(-1)!.body!.count, undefined);
  await f.run(['zhipu', 'search', 'q', '--engine', 'search_pro_quark', '--recency', 'oneYear']);
  assert.equal(f.calls.at(-1)!.body!.count, undefined);
  for (const args of [
    ['--engine', 'search_pro_sogou', '--limit', '1'],
    ['--engine', 'search_pro_quark', '--limit', '10'],
    ['--engine', 'search_pro_quark', '--include-domains', 'example.org'],
    [
      '--engine',
      'search_pro_sogou',
      '--include-domains',
      'example.org',
      '--recency',
      'oneDay',
      '--limit',
      '10',
    ],
    ['--include-domains', '  '],
    ['--content-size', 'short'],
    ['--engine', 'search-prime'],
    ['--recency', 'week'],
    ...['0', '51', '1.5', '1e1', '+2', '02'].map((limit) => ['--limit', limit]),
  ]) {
    const before = f.calls.length;
    assert.equal((await f.run(['zhipu', 'search', 'q', ...args])).exit, 2, args.join(' '));
    assert.equal(f.calls.length, before);
  }
  for (const [platform, size] of [
    ['bigmodel', 'short'],
    ['zai', 'medium'],
  ]) {
    const invalidSize = await f.run(['zhipu', 'search', 'q', '--content-size', size], {
      UNISEARCH_ZHIPU_PLATFORM: platform,
      UNISEARCH_ZHIPU_API_KEY: undefined,
    });
    assert.equal(invalidSize.exit, 2);
    assert.match(invalidSize.channels.err, /--content-size/);
  }
  assert.equal(
    (
      await f.run(['zhipu', 'search', 'q', '--content-size', 'medium'], {
        UNISEARCH_ZHIPU_PLATFORM: 'zai',
      })
    ).exit,
    2,
  );
  f.save({ providers: { zhipu: { search: { engine: 'search_pro_sogou', limit: 3 } } } });
  assert.equal((await f.run(['zhipu', 'search', 'q'])).exit, 3);
  assert.equal((await f.run(['zhipu', 'search', 'q', '--limit', '20'])).exit, 0);
  assert.equal((await f.run(['zhipu', 'search', 'q', '--engine', 'search_std'])).exit, 0);
  f.save({
    providers: { zhipu: { search: { engine: 'search_std', limit: 5, content_size: 'bad' } } },
  });
  assert.equal((await f.run(['zhipu', 'search', 'q', '--content-size', 'high'])).exit, 3);
  assert.equal((await f.run(['config', 'unset', 'providers.zhipu.search.content_size'])).exit, 0);
  assert.equal((await f.run(['zhipu', 'search', 'q', '--content-size', 'high'])).exit, 0);
  f.save({ providers: { zhipu: { search: { engine: 'search_std', limit: 5 } } } });
  assert.equal((await f.run(['zhipu', 'search', 'q', '--engine', 'search_pro_quark'])).exit, 2);
  f.save({ providers: { zhipu: { search: { engine: 'search_pro_quark', limit: 10 } } } });
  assert.equal((await f.run(['zhipu', 'search', 'q'])).exit, 3);
  f.save({ providers: { zhipu: { search: { engine: 'search_pro_sogou', limit: 20 } } } });
  assert.equal(
    (
      await f.run([
        'zhipu',
        'search',
        'q',
        '--include-domains',
        'example.org',
        '--recency',
        'oneMonth',
      ])
    ).exit,
    2,
  );
});

test('Zhipu both platforms expose the same translated options and reject scalar repetition', async (t) => {
  const f = await fixture(t);
  for (const op of ['search', 'fetch']) {
    const flags: string[][] = [];
    for (const platform of ['bigmodel', 'zai'])
      for (const lang of ['zh', 'en']) {
        const result = await f.run(['zhipu', op, '--help'], {
          UNISEARCH_ZHIPU_PLATFORM: platform,
          UNISEARCH_LANG: lang,
        });
        assert.equal(result.exit, 0);
        assert.match(result.channels.out, lang === 'zh' ? /用法：/ : /Usage:/);
        flags.push([...result.channels.out.matchAll(/--[a-z-]+/g)].map((m) => m[0]));
      }
    flags.forEach((f) => assert.deepEqual(f, flags[0]));
  }
  for (const [op, args] of [
    ['search', ['--engine', 'search_std']],
    ['search', ['--limit', '1']],
    ['search', ['--recency', 'noLimit']],
    ['search', ['--include-domains', 'example.org']],
    ['search', ['--content-size', 'high']],
    ['fetch', ['--no-cache']],
    ['fetch', ['--no-images']],
    ['fetch', ['--include-images-summary']],
    ['fetch', ['--include-links-summary']],
  ] as const)
    assert.equal(
      (await f.run(['zhipu', op, op === 'search' ? 'q' : url, ...args, ...args])).exit,
      2,
    );
  assert.equal(f.calls.length, 0);
});

test('Zhipu Reader forwards only the three default fields and explicit independent switches', async (t) => {
  const f = await fixture(t);
  for (const platform of ['bigmodel', 'zai']) {
    assert.equal(
      (
        await f.run(['zhipu', 'fetch', url], {
          UNISEARCH_ZHIPU_PLATFORM: platform,
        })
      ).exit,
      0,
    );
    assert.deepEqual(f.calls.at(-1)!.body, { url, return_format: 'markdown', timeout: 20 });
    assert.equal(f.calls.at(-1)!.path, '/gateway/reader');
    for (const [flag, key, value] of [
      ['--no-cache', 'no_cache', true],
      ['--no-images', 'retain_images', false],
      ['--include-images-summary', 'with_images_summary', true],
      ['--include-links-summary', 'with_links_summary', true],
    ] as const) {
      assert.equal(
        (await f.run(['zhipu', 'fetch', url, flag], { UNISEARCH_ZHIPU_PLATFORM: platform })).exit,
        0,
      );
      assert.deepEqual(f.calls.at(-1)!.body, {
        url,
        return_format: 'markdown',
        timeout: 20,
        [key]: value,
      });
    }
  }
  await f.run([
    'zhipu',
    'fetch',
    url,
    '--no-cache',
    '--no-images',
    '--include-images-summary',
    '--include-links-summary',
  ]);
  assert.deepEqual(f.calls.at(-1)!.body, {
    url,
    return_format: 'markdown',
    timeout: 20,
    no_cache: true,
    retain_images: false,
    with_images_summary: true,
    with_links_summary: true,
  });
  for (const input of [
    'relative',
    'file:///etc/passwd',
    'https://u:p@example.org',
    'https://example.org/a b',
  ]) {
    const before = f.calls.length;
    assert.equal((await f.run(['zhipu', 'fetch', input])).exit, 2);
    assert.equal(f.calls.length, before);
  }
});

test('Zhipu response cleaning removes exact echoes and decoration while retaining differences and order', async (t) => {
  const f = await fixture(t);
  const q = 'Query';
  f.reply({
    search_result: [
      hit,
      { ...hit, title: 'same', content: 'same', media: null, publish_date: ' ', refer: null },
      hit,
    ],
    search_intent: [
      { intent: 'SEARCH_ALWAYS', query: q, keywords: q },
      { query: 'query', keywords: 'query' },
      { intent: 'OTHER', query: 'Query ', keywords: 'different' },
      {},
    ],
  });
  const result = (await f.run(['zhipu', 'search', q, '--format=json'])).json();
  assert.equal(result.data.results.length, 3);
  assert.equal(result.data.results[1].description, undefined);
  assert.equal(result.data.results[1].source, undefined);
  assert.deepEqual(result.data.search_intent, [
    { query: 'query' },
    { intent: 'OTHER', query: 'Query ', keywords: 'different' },
  ]);
  f.reply({ search_result: [] });
  assert.deepEqual((await f.run(['zhipu', 'search', q, '--format=json'])).json(), {
    status: 'success',
    data: { provider: 'zhipu', search_engine: 'search_std', results: [] },
  });
});

test('Zhipu invalid fields and excess results fail explicitly with all independent usable data retained', async (t) => {
  const f = await fixture(t);
  for (const body of [
    { search_result: [hit, { link: 'bad' }, { ...hit, title: 5 }] },
    { search_result: [hit, hit] },
    { search_result: [hit], search_intent: ['bad'] },
    { search_result: [hit], search_intent: false },
  ]) {
    f.reply(body);
    const result = await f.run(['zhipu', 'search', 'q', '--limit', '1', '--format=json']);
    assert.equal(result.exit, 4);
    assert.equal(result.json().error.code, 'INVALID_RESPONSE');
    assert.ok(result.json().data.results.length >= 1);
    if (body.search_result.length > 1) assert.equal(result.json().data.results.length, 2);
  }
  f.reply({ search_result: Array.from({ length: 51 }, () => hit) });
  assert.equal((await f.run(['zhipu', 'search', 'q', '--engine', 'search_pro_quark'])).exit, 0);
  for (const body of [
    {},
    { search_result: null },
    { search_result: {} },
    { search_result: [{ url }] },
    [],
    null,
  ]) {
    f.reply(body);
    const result = await f.run(['zhipu', 'search', 'q', '--format=json']);
    assert.equal(result.exit, 4);
    assert.equal(result.json().data, undefined);
  }
});

test('Zhipu Reader preserves Markdown, unknown metadata, content relationships and meaningful empty values', async (t) => {
  const f = await fixture(t);
  const metadata = {
    keywords: ['CLI'],
    viewport: 'width',
    'format-detection': false,
    description: page.description,
    custom: { code: 0, provider: false, nullable: null, values: [] },
    empty: '',
    title: page.title,
  };
  const external = {
    stylesheet: 'ignored',
    canonical: { [url]: {} },
    alternate: { 'https://example.org/guide.pdf': { type: 'application/pdf', custom: null } },
    empty: {},
  };
  f.reply({ ...reader, reader_result: { ...page, metadata, external } });
  const result = (await f.run(['zhipu', 'fetch', url, '--format=json'])).json();
  assert.deepEqual(result.data, {
    provider: 'zhipu',
    results: [
      {
        url,
        title: page.title,
        description: page.description,
        text: page.content,
        metadata: { keywords: ['CLI'], custom: metadata.custom, empty: '', title: page.title },
        external: { canonical: external.canonical, alternate: external.alternate },
      },
    ],
  });
  assert.equal(result.meta, undefined);
  for (const description of [page.title, page.content]) {
    f.reply({ reader_result: { ...page, description, metadata: { description } } });
    const data = (await f.run(['zhipu', 'fetch', url, '--format=json'])).json().data.results[0];
    assert.equal(data.description, undefined);
    assert.equal(data.metadata, undefined);
  }
});

test('Zhipu Reader distinguishes empty bodies from corrupt fields and preserves reliable evidence', async (t) => {
  const f = await fixture(t);
  for (const value of ['', ' \n ', null, false, undefined]) {
    f.reply({ reader_result: { ...page, content: value } });
    const result = await f.run(['zhipu', 'fetch', url, '--format=json']);
    assert.equal(result.exit, 4);
    assert.equal(
      result.json().error.code,
      typeof value === 'string' ? 'CONTENT_UNAVAILABLE' : 'INVALID_RESPONSE',
    );
    assert.equal(result.json().data.results[0].title, page.title);
    assert.equal(result.json().data.results[0].text, undefined);
  }
  for (const change of [
    { title: 0 },
    { metadata: null },
    { metadata: [] },
    { external: null },
    { external: [] },
    { external: { alternate: { 'bad-url': {} }, canonical: { [url]: {} } } },
  ]) {
    f.reply({ reader_result: { ...page, ...change } });
    const result = await f.run(['zhipu', 'fetch', url, '--format=json']);
    assert.equal(result.exit, 4);
    assert.equal(result.json().data.results[0].text, page.content);
  }
  for (const body of [{}, { reader_result: null }, { reader_result: { ...page, url: 'bad' } }]) {
    f.reply(body);
    assert.equal((await f.run(['zhipu', 'fetch', url, '--format=json'])).json().data, undefined);
  }
  f.reply({ reader_result: { ...page, content: '404 Forbidden token Authorization: example' } });
  assert.equal((await f.run(['zhipu', 'fetch', url])).exit, 0);
});

test('Zhipu does not infer platform from custom hosts or share MCP credentials', () => {
  const env = {
    UNISEARCH_ZHIPU_API_KEY: 'fixture',
    UNISEARCH_ZHIPU_BASE_URL: 'https://api.z.ai/custom',
  };
  assert.equal(zhipu.prepare('search', 'q', {}, {}, env, 'en').body.search_engine, 'search_std');
  assert.throws(
    () => zhipu.prepare('search', 'q', {}, {}, { UNISEARCH_ZHIPU_MCP_API_KEY: 'fixture' }, 'en'),
    (e: unknown) => e instanceof AppError && e.code === 'MISSING_CONFIG',
  );
});
