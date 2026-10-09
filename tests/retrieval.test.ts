import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createCli } from '../src/cli/program.js';
import { prepareRetrieval, retrieve } from '../src/retrieval.js';
import type { ExecutionClock } from '../src/execution.js';
import type { JsonObject } from '../src/result.js';
import { capture, context, temporary } from './helpers.js';

const url = 'https://example.org/docs?q=1#part';
const payloads: Record<string, unknown> = {
  '/tavily/extract': { results: [{ url, raw_content: '# Page\n\nBody.' }], failed_results: [] },
  '/firecrawl/scrape': { success: true, data: { markdown: '# Page\n\nBody.' } },
  '/tavily/map': { results: [url] },
  '/firecrawl/map': { success: true, links: [{ url, title: 'Guide', description: 'Reference.' }] },
};
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
async function fixture(t: TestContext) {
  const root = temporary(t);
  const file = join(root, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({ providers: { jina: { enabled: false }, anysearch: { enabled: false } } }),
  );
  const calls: { path: string; body: JsonObject }[] = [];
  let handler: (path: string, res: ServerResponse) => void = (path, res) =>
    res.end(JSON.stringify(payloads[path]));
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = req.url!;
    calls.push({ path, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (path.startsWith('/exa/')) assert.equal(req.headers['x-api-key'], 'fixture-exa-secret');
    else assert.match(String(req.headers.authorization), /^Bearer fixture-/);
    handler(path, res);
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
  const env = {
    UNISEARCH_CONFIG_PATH: file,
    UNISEARCH_LANG: 'en',
    UNISEARCH_RETRIES: '0',
    UNISEARCH_TAVILY_API_KEY: 'fixture-tavily-secret',
    UNISEARCH_TAVILY_BASE_URL: `${base}/tavily`,
    UNISEARCH_FIRECRAWL_API_KEY: 'fixture-firecrawl-secret',
    UNISEARCH_FIRECRAWL_BASE_URL: `${base}/firecrawl`,
    UNISEARCH_EXA_API_KEY: 'fixture-exa-secret',
    UNISEARCH_EXA_BASE_URL: `${base}/exa`,
    UNISEARCH_MODEL_API_KEY: 'fixture-model-secret',
    UNISEARCH_MODEL_BASE_URL: `${base}/model`,
    UNISEARCH_MODEL_ID: 'primary',
  };
  const save = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  async function run(args: string[], override: NodeJS.ProcessEnv = {}) {
    const channels = capture();
    const exit = await createCli('test', {
      config: context(root, { ...env, ...override }),
      channels,
    }).run(args);
    return { exit, channels, json: () => JSON.parse(channels.out) };
  }
  return {
    root,
    env,
    save,
    run,
    calls,
    base,
    handle(value: typeof handler) {
      handler = value;
    },
    reply(replies: Record<string, Reply>) {
      handler = (path, res) => {
        const reply = replies[path] ?? {};
        res.writeHead(reply.status ?? 200, reply.headers);
        res.end(JSON.stringify(reply.body ?? payloads[path]));
      };
    },
  };
}

test('unified commands select real configured operations and share each provider’s settings', async (t) => {
  const f = await fixture(t);
  for (const operation of ['fetch', 'map'] as const) {
    for (const providers of [undefined, ['firecrawl', 'tavily']] as const) {
      f.save({ [operation]: providers ? { providers } : undefined });
      const result = await f.run([operation, url, '--format=json']);
      assert.equal(result.exit, 0, result.channels.out);
      assert.equal(
        result.json().data.provider,
        providers || operation === 'fetch' ? 'firecrawl' : 'tavily',
      );
      assert.equal(result.json().meta, undefined);
      assert.deepEqual(
        operation === 'fetch'
          ? result.json().data.results.map((p: { url: string }) => p.url)
          : result.json().data.links.map((p: { url: string }) => p.url),
        [url],
      );
    }
  }
  f.save({
    fetch: { providers: ['tavily', 'firecrawl'] },
    providers: {
      tavily: { extract: { extract_depth: 'advanced' }, map: { limit: 81 } },
    },
  });
  await f.run(['fetch', url]);
  assert.deepEqual(f.calls.at(-1)!.body, {
    urls: [url],
    extract_depth: 'advanced',
    format: 'markdown',
    timeout: 30,
    include_images: false,
    include_favicon: false,
    include_usage: false,
  });
  await f.run(['map', url]);
  assert.equal(f.calls.at(-1)!.body.limit, 81);
  assert.equal(f.calls.at(-1)!.body.max_depth, 1);
  f.save({
    fetch: { providers: ['tavily', 'firecrawl'] },
    providers: { tavily: { enabled: false } },
  });
  const single = await f.run(['fetch', url, '--format=json']);
  assert.equal(single.json().data.provider, 'firecrawl');
});

test('selection and parameter errors fail before HTTP; disabled fallback scopes configuration checks', async (t) => {
  const f = await fixture(t);
  for (const values of [
    { fetch: { providers: [] } },
    { fetch: { providers: ['tavily', 'tavily'] } },
    { fetch: { providers: ['wrong-id'] } },
    { map: { providers: ['exa'] } },
    { providers: { firecrawl: { scrape: { only_main_content: 'bad' } } } },
  ]) {
    f.save(values);
    const operation = 'map' in values ? 'map' : 'fetch';
    assert.notEqual((await f.run([operation, url])).exit, 0);
  }
  f.save({});
  for (const args of [
    ['fetch', 'relative'],
    ['fetch', url, url],
    ['fetch', url, '--no-fallback', '--no-fallback'],
    ['map', url, '--limit', '0'],
    ['map', url, '--limit', '1.5'],
    ['map', url, '--limit', '9007199254740992'],
    ['map', url, '--limit', '100001'],
  ])
    assert.equal((await f.run(args)).exit, 2);
  assert.equal(f.calls.length, 0);
  f.save({
    fetch: { providers: ['tavily', 'firecrawl'] },
    providers: {
      tavily: { search: { limit: 'bad' } },
    },
  });
  const invalidFirecrawl = { UNISEARCH_FIRECRAWL_BASE_URL: 'bad' };
  const before = f.calls.length;
  assert.equal((await f.run(['fetch', url], invalidFirecrawl)).exit, 3);
  assert.equal(f.calls.length, before);
  assert.equal((await f.run(['fetch', url, '--no-fallback'], invalidFirecrawl)).exit, 0);
  assert.equal(
    (await f.run(['fetch', url], { ...invalidFirecrawl, UNISEARCH_FALLBACK: 'false' })).exit,
    0,
  );
  f.save({ execution: { fallback: false } });
  assert.equal((await f.run(['map', url, '--limit', '100001'])).exit, 0);
  f.save({ providers: { tavily: { map: { limit: 'bad' } } } });
  assert.equal((await f.run(['map', url, '--limit', '1'])).exit, 0);
  const onlyTavily = await f.run(['map', url, '--limit', '100001'], {
    UNISEARCH_FIRECRAWL_API_KEY: undefined,
  });
  assert.equal(onlyTavily.exit, 0, onlyTavily.channels.out);
});

test('fetch and map switch in either direction and retain only the successful data and concise summary', async (t) => {
  const f = await fixture(t);
  for (const operation of ['fetch', 'map'] as const) {
    for (const providers of [
      ['tavily', 'firecrawl'],
      ['firecrawl', 'tavily'],
    ]) {
      f.calls.length = 0;
      f.save({
        [operation]: { providers },
        providers: { tavily: { map: { limit: 7 } }, firecrawl: { map: { limit: 9 } } },
      });
      f.handle((path, res) => {
        if (path.startsWith(`/${providers[0]}/`)) {
          res.writeHead(401, { 'x-request-id': 'first-request' });
          res.end('{}');
        } else res.end(JSON.stringify(payloads[path]));
      });
      const result = await f.run([operation, url, '--format=json']);
      assert.equal(result.exit, 0, result.channels.out);
      const data = result.json();
      assert.equal(data.data.provider, providers[1]);
      assert.deepEqual(Object.keys(data.meta), ['service_fallbacks']);
      assert.deepEqual(Object.keys(data.meta.service_fallbacks[0]), [
        'from',
        'to',
        'code',
        'message',
      ]);
      assert.equal(data.meta.service_fallbacks[0].from, providers[0]);
      assert.equal(data.meta.service_fallbacks[0].to, providers[1]);
      if (operation === 'map')
        assert.deepEqual(
          f.calls.map((c) => c.body.limit),
          providers.map((p) => (p === 'tavily' ? 7 : 9)),
        );
      const detailed = await f.run([operation, url, '--format=json', '--verbose']);
      assert.equal(detailed.json().meta.attempts[0].request_id, 'first-request');
      const fixed = await f.run([operation, url, '--no-fallback', '--format=json']);
      assert.equal(fixed.exit, 3);
      assert.equal(fixed.json().meta, undefined);
    }
  }
});

test('empty map is success, provider limit semantics and returned URLs survive normalization', async (t) => {
  const f = await fixture(t);
  f.save({ fetch: { providers: ['tavily', 'firecrawl'] } });
  f.reply({ '/tavily/map': { body: { results: [] } } });
  const empty = await f.run(['map', url, '--format=json']);
  assert.deepEqual(empty.json(), { status: 'success', data: { provider: 'tavily', links: [] } });
  assert.equal(f.calls.length, 1);
  f.reply({
    '/tavily/map': { body: { results: [url, url] } },
    '/tavily/extract': {
      body: {
        results: [{ url: 'https://example.org/final', raw_content: 'body' }],
        failed_results: [],
      },
    },
  });
  const surplus = await f.run(['map', url, '--limit', '1', '--format=json']);
  assert.equal(surplus.json().data.links.length, 2);
  const fetched = await f.run(['fetch', url, '--format=json']);
  assert.deepEqual(fetched.json().data.results, [
    { url: 'https://example.org/final', text: 'body' },
  ]);
  f.save({ map: { providers: ['firecrawl', 'tavily'] } });
  f.reply({ '/firecrawl/map': { body: { success: true, links: [{ url }, { url }] } } });
  const switched = await f.run(['map', url, '--limit', '1', '--format=json']);
  assert.equal(switched.json().data.provider, 'tavily');
  assert.equal(switched.json().meta.service_fallbacks[0].code, 'INVALID_RESPONSE');
});

test('content failures switch; unknown upstream and parameter failures terminate; aggregate exits retain all reasons', async (t) => {
  const f = await fixture(t);
  f.save({ fetch: { providers: ['tavily', 'firecrawl'] } });
  for (const body of [
    { results: [{ url, raw_content: ' ' }], failed_results: [] },
    { results: [], failed_results: [{ url, error: 'Cannot extract' }] },
    { results: [{ url }], failed_results: [] },
  ]) {
    f.reply({ '/tavily/extract': { body } });
    assert.equal((await f.run(['fetch', url, '--format=json'])).json().data.provider, 'firecrawl');
  }
  for (const status of [400, 404]) {
    f.calls.length = 0;
    f.reply({ '/tavily/extract': { status, body: {} } });
    const result = await f.run(['fetch', url, '--format=json']);
    assert.equal(result.exit, status === 400 ? 2 : 4);
    assert.equal(f.calls.length, 1);
  }
  for (const [status, code] of [
    [401, 3],
    [402, 4],
    [400, 2],
  ] as const) {
    f.reply({
      '/tavily/extract': { status: 401, body: {} },
      '/firecrawl/scrape': { status, body: {} },
    });
    const result = await f.run(['fetch', url, '--format=json']);
    assert.equal(result.exit, code);
    assert.equal(
      result.json().error.code,
      status === 400 ? 'INVALID_ARGUMENT' : 'ALL_PROVIDERS_FAILED',
    );
    assert.deepEqual(
      result.json().error.details.failures.map((e: { provider: string }) => e.provider),
      ['tavily', 'firecrawl'],
    );
    assert.equal(result.json().meta, undefined);
  }
  f.save({ fetch: { providers: ['firecrawl', 'tavily'] } });
  f.calls.length = 0;
  f.reply({
    '/firecrawl/scrape': { status: 500, body: { success: false, code: 'SCRAPE_JOB_CANCELLED' } },
  });
  assert.equal((await f.run(['fetch', url])).exit, 4);
  assert.equal(f.calls.length, 1);
  f.reply({
    '/firecrawl/scrape': {
      body: { success: true, data: { markdown: 'error page', metadata: { statusCode: 404 } } },
    },
  });
  assert.equal((await f.run(['fetch', url, '--format=json'])).json().data.provider, 'tavily');
});

test('malformed extraction preserves complete pages across later failure and output files', async (t) => {
  const f = await fixture(t);
  f.save({ fetch: { providers: ['tavily', 'firecrawl'] } });
  const pages = [
    { url, raw_content: 'Page one.' },
    { url: 'https://example.org/extra', raw_content: 'Page two.' },
  ];
  f.reply({
    '/tavily/extract': { body: { results: pages, failed_results: [] } },
    '/firecrawl/scrape': { status: 401, body: {} },
  });
  const output = join(f.root, 'result.json');
  const result = await f.run(['fetch', url, '--format=json', '--output', output]);
  assert.equal(result.exit, 4);
  const data = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(data.data.provider, 'tavily');
  assert.deepEqual(
    data.data.results.map((p: { text: string }) => p.text),
    ['Page one.', 'Page two.'],
  );
  assert.equal(data.error.code, 'ALL_PROVIDERS_FAILED');
  f.reply({ '/tavily/extract': { body: { results: pages, failed_results: [] } } });
  const recovered = await f.run(['fetch', url, '--format=json']);
  assert.equal(recovered.exit, 0);
  assert.equal(recovered.json().data.results.length, 1);
  assert.equal(recovered.json().data.provider, 'firecrawl');
});

test('shared deadline and Retry-After use remaining time across actual provider requests', async (t) => {
  const f = await fixture(t);
  let now = 0;
  const caps: number[] = [];
  const waits: number[] = [];
  const time: ExecutionClock = {
    now: () => now,
    wallNow: () => 0,
    schedule: (ms) => {
      caps.push(ms);
      return () => {};
    },
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  };
  f.reply({ '/tavily/map': { status: 429, body: {}, headers: { 'retry-after': '300' } } });
  const plan = prepareRetrieval(
    'map',
    url,
    { timeout: 200 },
    {},
    { ...f.env, UNISEARCH_RETRIES: '2' },
    'en',
  );
  const record: JsonObject = {};
  const result = await retrieve(plan, new AbortController().signal, 'en', record, {
    clock: time,
    transport: async (...args) => {
      const response = await fetch(...args);
      now += 5000;
      return response;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(caps, [160000, 60000]);
  assert.deepEqual(waits, []);
  assert.equal(
    result.result.meta?.service_fallbacks &&
      (result.result.meta.service_fallbacks as JsonObject[])[0].code,
    'RATE_LIMITED',
  );
  now = 0;
  caps.length = 0;
  const shorter = await retrieve(
    prepareRetrieval('map', url, { timeout: 50 }, {}, { ...f.env, UNISEARCH_RETRIES: '2' }, 'en'),
    new AbortController().signal,
    'en',
    {},
    {
      clock: time,
      transport: async (...args) => {
        const response = await fetch(...args);
        now += 5000;
        return response;
      },
    },
  );
  assert.equal(shorter.exitCode, 0);
  assert.deepEqual(caps, [50000, 45000]);
  f.calls.length = 0;
  caps.length = 0;
  now = 0;
  const total = await retrieve(
    prepareRetrieval('map', url, { timeout: 0.5 }, {}, f.env, 'en'),
    new AbortController().signal,
    'en',
    {},
    {
      clock: time,
      transport: async (...args) => {
        const response = await fetch(...args);
        now = 500;
        return response;
      },
    },
  );
  assert.equal(total.result.error?.code, 'TIMEOUT');
  assert.equal(total.result.error?.details?.timeout_scope, 'total');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(caps, [500]);
  f.calls.length = 0;
  now = 0;
  caps.length = 0;
  let count = 0;
  f.handle((path, res) => {
    if (++count === 1) {
      res.writeHead(503, { 'retry-after': '1' });
      res.end('{}');
    } else res.end(JSON.stringify(payloads[path]));
  });
  const retried = await retrieve(
    prepareRetrieval(
      'fetch',
      url,
      { fallback: false },
      {},
      { ...f.env, UNISEARCH_RETRIES: '1' },
      'en',
    ),
    new AbortController().signal,
    'en',
    record,
    { clock: time },
  );
  assert.equal(retried.exitCode, 0);
  assert.equal(retried.result.meta, undefined);
  assert.deepEqual(waits, [1000]);
  assert.equal(f.calls.length, 2);
  assert.equal((record.attempts as JsonObject[])[0].wait_ms, 1000);
});

test('permanent transport errors can switch, programming errors stop and retain completed extraction data', async (t) => {
  const f = await fixture(t);
  const plan = prepareRetrieval(
    'fetch',
    url,
    {},
    { fetch: { providers: ['tavily', 'firecrawl'] } },
    f.env,
    'en',
  );
  const network = await retrieve(
    plan,
    new AbortController().signal,
    'en',
    {},
    {
      transport: async (...args) => {
        if (String(args[0]).includes('/tavily/'))
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('fixture DNS'), { code: 'ENOTFOUND' }),
          });
        return fetch(...args);
      },
    },
  );
  assert.equal(network.exitCode, 0);
  assert.equal(network.result.data?.provider, 'firecrawl');
  f.reply({
    '/tavily/extract': {
      body: {
        results: [
          { url, raw_content: 'one' },
          { url, raw_content: 'two' },
        ],
        failed_results: [],
      },
    },
  });
  const internal = await retrieve(
    plan,
    new AbortController().signal,
    'en',
    {},
    {
      transport: async (...args) => {
        if (String(args[0]).includes('/firecrawl/')) throw new Error('programming defect');
        return fetch(...args);
      },
    },
  );
  assert.equal(internal.exitCode, 5);
  assert.equal(internal.result.error?.code, 'INTERNAL_ERROR');
  assert.equal(internal.result.data?.provider, 'tavily');
  f.reply({
    '/tavily/map': { status: 403, body: { detail: { error: '[403] URL is not supported' } } },
  });
  assert.equal((await f.run(['map', url, '--format=json'])).json().data.provider, 'firecrawl');
});

test(
  'SIGINT in a root retrieval leaves an existing output file unchanged',
  { skip: process.platform === 'win32', timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const output = join(f.root, 'old.json');
    writeFileSync(output, 'original');
    let received!: () => void;
    const ready = new Promise<void>((done) => {
      received = done;
    });
    f.handle((_path, res) => {
      res.writeHead(200);
      res.write('{"results":');
      received();
    });
    const child = spawn(
      process.execPath,
      [resolve('dist/cli.js'), 'fetch', url, '--format=json', '--output', output],
      { cwd: f.root, env: f.env },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    const closed = once(child, 'close');
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    await ready;
    child.kill('SIGINT');
    assert.equal((await closed)[0], 130);
    assert.equal(JSON.parse(stdout).error.code, 'CANCELLED');
    assert.equal(readFileSync(output, 'utf8'), 'original');
    assert.deepEqual(readdirSync(f.root).sort(), ['config.json', 'old.json']);
  },
);

test('native slow body cancellation preserves earlier complete data and reports the started service', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.handle((path, res) => {
    if (path === '/tavily/extract')
      res.end(
        JSON.stringify({
          results: [
            { url, raw_content: 'one' },
            { url, raw_content: 'two' },
          ],
          failed_results: [],
        }),
      );
    else {
      res.writeHead(200);
      res.write('{"success":true,"data":');
      release();
    }
  });
  const abort = new AbortController();
  const task = retrieve(
    prepareRetrieval(
      'fetch',
      url,
      {},
      { fetch: { providers: ['tavily', 'firecrawl'] } },
      f.env,
      'en',
    ),
    abort.signal,
    'en',
    {},
  );
  await pending;
  abort.abort();
  const result = await task;
  assert.equal(result.exitCode, 130);
  assert.equal(result.result.data?.provider, 'tavily');
  const last = result.result.error?.details?.failures?.at(-1);
  assert.ok(last && 'provider' in last);
  assert.equal(last.provider, 'firecrawl');
  assert.equal(result.result.meta, undefined);
});

test('file preparation, empty success, errors and Markdown verbosity use the shared output lifecycle', async (t) => {
  const f = await fixture(t);
  f.save({ fetch: { providers: ['tavily', 'firecrawl'] } });
  assert.equal((await f.run(['fetch', url, '--output', join(f.root, 'absent', 'out')])).exit, 5);
  assert.equal(f.calls.length, 0);
  const output = join(f.root, 'out.md');
  writeFileSync(output, 'old');
  f.reply({
    '/tavily/extract': { status: 401, body: {} },
    '/firecrawl/scrape': { status: 401, body: {} },
  });
  assert.equal((await f.run(['fetch', url, '--output', output])).exit, 3);
  assert.equal(readFileSync(output, 'utf8'), 'old');
  f.reply({ '/tavily/extract': { status: 401, body: {} } });
  const result = await f.run(['fetch', url, '--verbose', '--output', output]);
  assert.equal(result.exit, 0);
  assert.match(result.channels.err, /Execution time:/);
  assert.doesNotMatch(readFileSync(output, 'utf8'), /duration_ms|Execution time:/);
  assert.match(readFileSync(output, 'utf8'), /Service fallback: tavily → firecrawl/);
  f.reply({ '/tavily/map': { body: { results: [] } } });
  await f.run(['map', url, '--output', output]);
  assert.match(readFileSync(output, 'utf8'), /No site links found/);
  assert.deepEqual(readdirSync(f.root).sort(), ['config.json', 'out.md']);
});

test('unified Firecrawl metadata and diagnostics retain content while redacting every known credential', async (t) => {
  const f = await fixture(t);
  f.save({
    fetch: { providers: ['firecrawl'] },
    providers: { tavily: { api_key: 'fixture-old-key' } },
  });
  f.reply({
    '/firecrawl/scrape': {
      body: {
        success: true,
        data: {
          markdown: '# PDF\n\nContent.',
          warning: `Notice ${f.env.UNISEARCH_TAVILY_API_KEY} fixture-old-key`,
          metadata: {
            title: 'Report',
            url: 'https://example.org/report.pdf',
            contentType: 'application/pdf',
            numPages: 2,
            totalPages: 5,
          },
        },
      },
    },
  });
  const result = await f.run(['fetch', url, '--format=json', '--verbose']);
  const page = result.json().data.results[0];
  assert.equal(page.text, '# PDF\n\nContent.');
  assert.equal(page.final_url, 'https://example.org/report.pdf');
  assert.deepEqual(page.content_truncation, { parsed_pages: 2, total_pages: 5 });
  assert.doesNotMatch(result.channels.out, /fixture-tavily-secret|fixture-old-key/);
  const md = await f.run(['fetch', url]);
  assert.match(md.channels.out, /2 of 5/);
  assert.match(md.channels.out, /\[REDACTED\]/);
});

test('all four search tasks start together, preserve order and redact cross-service diagnostics', async (t) => {
  const f = await fixture(t);
  f.save({
    providers: {
      firecrawl: { search: { limit: 2 } },
      exa: { search: { limit: 3 } },
      tavily: { search: { limit: 4 } },
    },
  });
  let pending: { path: string; res: ServerResponse }[] = [];
  f.handle((path, res) => {
    pending.push({ path, res });
    if (pending.length !== 4) return;
    for (const item of pending.toReversed()) {
      if (item.path === '/model/responses')
        item.res.end(
          JSON.stringify({
            model: 'actual',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Answer.' }],
              },
            ],
          }),
        );
      else if (item.path === '/firecrawl/search')
        item.res.end(
          JSON.stringify({
            success: true,
            data: {
              web: [{ url, markdown: ' ', metadata: { error: f.env.UNISEARCH_TAVILY_API_KEY } }],
            },
            warning: f.env.UNISEARCH_EXA_API_KEY,
          }),
        );
      else item.res.end('{"results":[]}');
    }
    pending = [];
  });
  const result = await f.run([
    'search',
    'q',
    '--extra-sources',
    'firecrawl,tavily,exa',
    '--format=json',
    '--timeout',
    '2',
  ]);
  assert.equal(result.exit, 0, result.channels.out);
  assert.deepEqual(
    result.json().data.extra_sources.map((s: { provider: string }) => s.provider),
    ['firecrawl', 'tavily', 'exa'],
  );
  assert.equal(f.calls.find((c) => c.path === '/firecrawl/search')!.body.limit, 2);
  assert.equal(f.calls.find((c) => c.path === '/tavily/search')!.body.max_results, 4);
  assert.equal(f.calls.find((c) => c.path === '/exa/search')!.body.numResults, 3);
  assert.doesNotMatch(result.channels.out, /fixture-tavily-secret|fixture-exa-secret/);
  const before = f.calls.length;
  assert.equal(
    (await f.run(['search', 'x'.repeat(501), '--extra-sources', 'exa,tavily,firecrawl'])).exit,
    2,
  );
  assert.equal(
    (
      await f.run(['search', 'q', '--extra-sources', 'exa,tavily,firecrawl'], {
        UNISEARCH_TAVILY_API_KEY: undefined,
      })
    ).exit,
    3,
  );
  assert.equal(f.calls.length, before);
});
