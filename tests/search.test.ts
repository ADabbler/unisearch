import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createCli } from '../src/cli/program.js';
import { combinedSearch, prepareCombinedSearch } from '../src/search.js';
import { requestModel } from '../src/providers/model.js';
import { prepareModel } from '../src/providers/model-config.js';
import { renderCombinedSearch, renderSearchExecution } from '../src/output/search.js';
import { execute } from '../src/output/index.js';
import type { JsonObject } from '../src/result.js';
import { capture, context, temporary } from './helpers.js';

const answer = {
  model: 'actual',
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Complete answer.' }],
    },
  ],
};
const env = {
  UNISEARCH_MODEL_API_KEY: 'model-secret',
  UNISEARCH_MODEL_ID: 'primary',
  UNISEARCH_MODEL_BASE_URL: 'https://fixture.example',
  UNISEARCH_EXA_API_KEY: 'exa-secret',
  UNISEARCH_RETRIES: '0',
  UNISEARCH_LANG: 'en',
};
async function server(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const instance = createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise<void>((done) => instance.close(() => done()));
  });
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function body(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('Model config management stores typed tools and independent efforts and rejects duplicate candidates without modifying the file', async (t) => {
  const root = temporary(t);
  const file = join(root, 'config.json');
  const config = context(root, { UNISEARCH_CONFIG_PATH: file, UNISEARCH_LANG: 'en' });
  for (const [key, value] of [
    ['base_url', 'https://fixture.example/v1'],
    ['model.id', 'primary'],
    ['model.effort', 'high'],
    ['fallback_models', '[{"id":"primary","effort":"low"},{"id":"backup"}]'],
    ['tools', '["web_search",{"type":"custom_hosted","nested":{"flag":true}}]'],
    ['protocol', 'chat-completions'],
    ['stream', 'true'],
  ]) {
    assert.equal(
      await createCli('test', { config, channels: capture() }).run([
        'config',
        'set',
        `providers.model.${key}`,
        value,
      ]),
      0,
    );
    const channels = capture();
    assert.equal(
      await createCli('test', { config, channels }).run([
        'config',
        'get',
        `providers.model.${key}`,
      ]),
      0,
    );
    assert.equal(JSON.parse(channels.out).data.source, 'config');
  }
  const original = readFileSync(file, 'utf8');
  for (const [key, value] of [
    ['model.effort', 'low'],
    ['fallback_models', '[{"id":"primary","effort":"high"}]'],
    ['tools', '["web_search",{"type":"web_search"}]'],
  ]) {
    assert.equal(
      await createCli('test', { config, channels: capture() }).run([
        'config',
        'set',
        `providers.model.${key}`,
        value,
      ]),
      2,
    );
    assert.equal(readFileSync(file, 'utf8'), original);
  }
  const channels = capture();
  assert.equal(await createCli('test', { config, channels }).run(['config', 'list']), 0);
  assert.deepEqual(JSON.parse(channels.out).data.values.providers.model.fallback_models, [
    { id: 'primary', effort: 'low' },
    { id: 'backup' },
  ]);
});

test('Root search help, scalar validation and all selected prerequisites fail locally with zero requests', async (t) => {
  const root = temporary(t);
  let calls = 0;
  const base = await server(t, (_req, res) => {
    calls++;
    res.end(JSON.stringify(answer));
  });
  const config = context(root, {
    ...env,
    UNISEARCH_MODEL_BASE_URL: base,
    UNISEARCH_EXA_BASE_URL: base,
  });
  for (const args of [
    ['search'],
    ['search', ' '],
    ['search', 'q', '--model', 'a', '--model', 'b'],
    ['search', 'q', '--effort', 'a', '--effort', 'b'],
    ['search', 'q', '--stream', '--no-stream'],
    ['search', 'q', '--stream', '--stream'],
    ['search', 'q', '--no-stream', '--no-stream'],
    ['search', 'q', '--no-fallback', '--no-fallback'],
    ['search', 'q', '--extra-sources', 'exa', '--extra-sources', 'exa'],
    ...['', ',exa', 'exa,', 'exa,exa', ' exa', 'unknown-source', 'tavily,tavily'].map((value) => [
      'search',
      'q',
      '--extra-sources',
      value,
    ]),
  ]) {
    const channels = capture();
    assert.equal(
      await createCli('test', { config, channels }).run([...args, '--format=json']),
      2,
      channels.out,
    );
  }
  for (const language of ['en', 'zh']) {
    const channels = capture();
    assert.equal(
      await createCli('test', {
        config: context(root, { UNISEARCH_LANG: language }),
        channels,
      }).run(['search', '--help']),
      0,
    );
    assert.match(channels.out, /--effort/);
  }
  const file = join(root, 'config.json');
  for (const exa of [{}, { enabled: false }, { search: { limit: 0 } }]) {
    writeFileSync(file, JSON.stringify({ providers: { exa } }));
    const environment: NodeJS.ProcessEnv = { ...config.env, UNISEARCH_CONFIG_PATH: file };
    if (!Object.keys(exa).length) delete environment.UNISEARCH_EXA_API_KEY;
    assert.equal(
      await createCli('test', { config: context(root, environment), channels: capture() }).run([
        'search',
        'q',
        '--extra-sources',
        'exa',
      ]),
      3,
    );
  }
  assert.equal(
    await createCli('test', { config, channels: capture() }).run([
      'search',
      'q',
      '--output',
      join(root, 'missing', 'out'),
    ]),
    5,
  );
  assert.equal(calls, 0);
});

test('Local HTTP barrier proves parallel execution and exact model/Exa mappings without feeding supplemental data to the model', async (t) => {
  const root = temporary(t);
  const waiting: ServerResponse[] = [];
  const requests: { url: string; headers: IncomingMessage['headers']; body: JsonObject }[] = [];
  const base = await server(t, (req, res) => {
    void body(req).then((data) => {
      requests.push({ url: req.url!, headers: req.headers, body: data });
      waiting.push(res);
      if (waiting.length === 2)
        for (const [index, pending] of waiting.entries())
          pending.end(
            JSON.stringify(requests[index].url.endsWith('/responses') ? answer : { results: [] }),
          );
    });
  });
  const file = join(root, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({ providers: { exa: { search: { limit: 3, search_type: 'fast' } } } }),
  );
  const channels = capture();
  const config = context(root, {
    ...env,
    UNISEARCH_CONFIG_PATH: file,
    UNISEARCH_MODEL_BASE_URL: `${base}/prefix`,
    UNISEARCH_EXA_BASE_URL: base,
  });
  assert.equal(
    await createCli('test', { config, channels }).run([
      'search',
      ' q ',
      '--extra-sources',
      'exa',
      '--timeout',
      '2',
      '--format=json',
      '--verbose',
    ]),
    0,
    channels.out,
  );
  assert.equal(requests.length, 2);
  const model = requests.find((request) => request.url === '/prefix/responses')!;
  const exa = requests.find((request) => request.url === '/search')!;
  assert.equal(model.headers.authorization, 'Bearer model-secret');
  assert.equal(model.headers.accept, 'application/json');
  assert.equal(model.body.store, false);
  assert.deepEqual(model.body.input, [{ role: 'user', content: ' q ' }]);
  assert.deepEqual(exa.body, {
    query: ' q ',
    numResults: 3,
    type: 'fast',
    contents: { text: false, highlights: false },
  });
  assert.equal(exa.headers['x-api-key'], 'exa-secret');
  const result = JSON.parse(channels.out);
  assert.deepEqual(result.data, {
    answer: { model: 'actual', text: 'Complete answer.' },
    extra_sources: [{ provider: 'exa', data: { results: [] } }],
  });
  assert.deepEqual(
    result.meta.attempts.map((entry: JsonObject) => entry.provider),
    ['model', 'exa'],
  );
  assert.equal(channels.err, '');
});

test('Four actual combinations preserve data, deterministic failure order and model exit classification in JSON and files', async (t) => {
  const root = temporary(t);
  const file = join(root, 'result.json');
  for (const [modelOk, exaOk, expected, status] of [
    [true, true, 0, 'success'],
    [true, false, 6, 'partial'],
    [false, true, 3, 'error'],
    [false, false, 3, 'error'],
  ] as const) {
    const base = await server(t, (req, res) => {
      if (req.url === '/responses') {
        res.statusCode = modelOk ? 200 : 401;
        res.end(JSON.stringify(modelOk ? answer : { error: { message: 'Rejected' } }));
      } else {
        res.statusCode = exaOk ? 200 : 503;
        res.end(JSON.stringify(exaOk ? { results: [] } : { error: 'Unavailable' }));
      }
    });
    writeFileSync(file, 'old');
    const config = context(root, {
      ...env,
      UNISEARCH_MODEL_BASE_URL: base,
      UNISEARCH_EXA_BASE_URL: base,
    });
    const channels = capture();
    assert.equal(
      await createCli('test', { config, channels }).run([
        'search',
        'q',
        '--extra-sources',
        'exa',
        '--format=json',
        '--output',
        file,
      ]),
      expected,
    );
    const result = JSON.parse(modelOk || exaOk ? readFileSync(file, 'utf8') : channels.out);
    assert.equal(result.status, status);
    assert.equal(Boolean(result.data?.answer), modelOk);
    assert.equal(Boolean(result.data?.extra_sources), exaOk);
    assert.deepEqual(
      result.error?.details.failures.map((entry: JsonObject) => entry.provider) ?? [],
      [...(!modelOk ? ['model'] : []), ...(!exaOk ? ['exa'] : [])],
    );
    if (!modelOk && !exaOk) assert.equal(readFileSync(file, 'utf8'), 'old');
    if (modelOk || exaOk) assert.equal(channels.out, '');
    if (expected && (modelOk || exaOk)) assert.match(channels.err, /result.json/);
  }
});

test('CLI stream overrides are independent of stored defaults and both protocols stop after terminal events without EOF', async (t) => {
  const root = temporary(t);
  const file = join(root, 'config.json');
  const streams: boolean[] = [];
  const base = await server(t, (req, res) => {
    void body(req).then((data) => {
      streams.push(data.stream as boolean);
      const isChat = req.url === '/chat/completions';
      const chatBody = {
        model: 'actual',
        choices: [{ index: 0, message: { content: 'Complete answer.' }, finish_reason: 'stop' }],
      };
      if (!data.stream) {
        res.end(JSON.stringify(isChat ? chatBody : answer));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (isChat)
        res.write(
          `data: ${JSON.stringify({ model: 'actual', choices: [{ index: 0, delta: { content: 'Complete answer.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        );
      else
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: answer })}\n\n`);
    });
  });
  for (const protocol of ['responses', 'chat-completions'])
    for (const saved of [false, true])
      for (const flag of [undefined, '--stream', '--no-stream']) {
        writeFileSync(
          file,
          JSON.stringify({ providers: { model: { stream: saved, protocol, tools: [] } } }),
        );
        const channels = capture();
        const config = context(root, {
          ...env,
          UNISEARCH_CONFIG_PATH: file,
          UNISEARCH_MODEL_BASE_URL: base,
        });
        assert.equal(
          await createCli('test', { config, channels }).run([
            'search',
            'q',
            '--timeout',
            '1',
            '--format=json',
            ...(flag ? [flag] : []),
          ]),
          0,
          channels.out,
        );
        assert.equal(streams.at(-1), flag === undefined ? saved : flag === '--stream');
        assert.equal(JSON.parse(channels.out).data.answer.text, 'Complete answer.');
      }
});

test('Transport format mismatches, bad UTF-8 and JSON are explicit and never trigger protocol switches', async () => {
  for (const stream of [false, true]) {
    const request = prepareModel('q', { stream }, {}, env, 'en');
    let calls = 0;
    const result = await requestModel(
      request,
      request.candidates[0],
      'prompt',
      { signal: new AbortController().signal },
      'en',
      async () => {
        calls++;
        return stream
          ? Response.json(answer)
          : new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    );
    assert.equal(result.outcome.result.error?.code, 'INVALID_RESPONSE');
    assert.equal(calls, 1);
  }
  for (const body of ['bad JSON', new Uint8Array([0xff])]) {
    const request = prepareModel('q', {}, {}, env, 'en');
    const result = await requestModel(
      request,
      request.candidates[0],
      'prompt',
      { signal: new AbortController().signal },
      'en',
      async () => new Response(body),
    );
    assert.equal(result.outcome.result.error?.code, 'INVALID_RESPONSE');
  }
});

test('Native SSE completes beyond its initial deadline with successful supplemental results', async (t) => {
  const timers: NodeJS.Timeout[] = [];
  t.after(() => timers.forEach(clearTimeout));
  const base = await server(t, (req, res) => {
    if (req.url === '/search') {
      res.end(JSON.stringify({ results: [] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"Complete "}\n\n');
    timers.push(
      setTimeout(
        () => res.write('data: {"type":"response.output_text.delta","delta":"answer."}\n\n'),
        700,
      ),
    );
    timers.push(
      setTimeout(
        () =>
          res.write(
            `data: ${JSON.stringify({ type: 'response.completed', response: answer })}\n\n`,
          ),
        1400,
      ),
    );
  });
  const plan = prepareCombinedSearch(
    'q',
    { stream: true, timeout: 1, extraSources: 'exa' },
    {},
    { ...env, UNISEARCH_MODEL_BASE_URL: base, UNISEARCH_EXA_BASE_URL: base },
    'en',
  );
  const result = await combinedSearch(plan, new AbortController().signal, 'en', {});
  assert.equal(result.exitCode, 0);
  assert.equal(result.result.data?.answer?.text, 'Complete answer.');
  assert.deepEqual(result.result.data?.extra_sources, [{ provider: 'exa', data: { results: [] } }]);
});

test('Slow native HTTP bodies and SSE honor deadlines while started model streams use idle timeouts', async (t) => {
  for (const stallModel of [false, true])
    for (const stream of [false, true]) {
      const base = await server(t, (req, res) => {
        const model = req.url === '/responses';
        if (model !== stallModel) {
          res.end(JSON.stringify(model ? answer : { results: [] }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': model && stream ? 'text/event-stream' : 'application/json',
        });
        res.write(
          model && stream
            ? 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
            : '{',
        );
      });
      const plan = prepareCombinedSearch(
        'q',
        { extraSources: 'exa', timeout: 0.15, stream: stallModel && stream },
        {},
        { ...env, UNISEARCH_MODEL_BASE_URL: base, UNISEARCH_EXA_BASE_URL: base },
        'en',
      );
      const record: JsonObject = {};
      const started = performance.now();
      const result = await combinedSearch(plan, new AbortController().signal, 'en', record);
      assert.equal(result.exitCode, stallModel ? 4 : 6);
      assert.equal(Boolean(result.result.data?.answer), !stallModel);
      assert.equal(Boolean(result.result.data?.extra_sources), stallModel);
      const timeout = result.result.error?.details?.failures?.[0].details;
      assert.equal(timeout?.timeout_scope, stallModel && stream ? 'stream_idle' : 'total');
      assert.ok(performance.now() - started < 1500);
      assert.equal((record.attempts as JsonObject[]).length, 2);
    }
});

test('Internal programming failures cancel pending siblings with exit 5, never masquerade as user cancellation', async () => {
  const plan = prepareCombinedSearch('q', { extraSources: 'exa' }, {}, env, 'en');
  let aborted = false;
  const result = await combinedSearch(
    plan,
    new AbortController().signal,
    'en',
    {},
    {
      transport: async (url, init) => {
        if (String(url).endsWith('/responses')) {
          await Promise.resolve();
          throw new TypeError('private internal details');
        }
        return new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      },
    },
  );
  assert.equal(result.exitCode, 5);
  assert.equal(result.result.error?.code, 'INTERNAL_ERROR');
  assert.equal(aborted, true);
  assert.doesNotMatch(JSON.stringify(result), /CANCELLED|private internal/);
});

test('Internal failure after completed Exa retains its data and cancellation retains completed supplemental data without deltas', async () => {
  for (const cancel of [false, true]) {
    const plan = prepareCombinedSearch('q', { extraSources: 'exa', stream: true }, {}, env, 'en');
    const abort = new AbortController();
    const result = await combinedSearch(
      plan,
      abort.signal,
      'en',
      {},
      {
        transport: async (url, init) => {
          if (!String(url).endsWith('/responses')) return Response.json({ results: [] });
          await new Promise((done) => setImmediate(done));
          if (cancel) {
            abort.abort();
            init!.signal!.throwIfAborted();
          }
          throw new TypeError('internal');
        },
      },
    );
    assert.equal(result.exitCode, cancel ? 130 : 5);
    assert.deepEqual(result.result.data, {
      extra_sources: [{ provider: 'exa', data: { results: [] } }],
    });
  }
});

test('All known credentials are redacted across provider failures and verbose request IDs', async () => {
  const plan = prepareCombinedSearch(
    'q',
    { extraSources: 'exa' },
    { providers: { tavily: { api_key: 'third-secret' } } },
    env,
    'en',
  );
  const record: JsonObject = {};
  const result = await combinedSearch(plan, new AbortController().signal, 'en', record, {
    transport: async (url) => {
      const model = String(url).endsWith('/responses');
      return Response.json(
        {
          error: model
            ? { message: 'exa-secret third-secret model-secret', code: 'custom' }
            : 'model-secret third-secret exa-secret',
        },
        { status: 401, headers: { 'x-request-id': 'model-secret exa-secret third-secret' } },
      );
    },
  });
  assert.doesNotMatch(JSON.stringify({ result, record }), /model-secret|exa-secret|third-secret/);
  assert.match(JSON.stringify(result), /REDACTED/);
});

test('Verbose execution details remain outside Markdown files', async (t) => {
  const root = temporary(t);
  const file = join(root, 'result.md');
  const channels = capture();
  const plan = prepareCombinedSearch('q', { extraSources: 'exa' }, {}, env, 'en');
  const record: JsonObject = {};
  assert.equal(
    await execute(
      () =>
        combinedSearch(plan, new AbortController().signal, 'en', record, {
          transport: async (url) =>
            Response.json(String(url).endsWith('/responses') ? answer : { results: [] }),
        }),
      {
        output: file,
        cwd: root,
        language: 'en',
        format: 'markdown',
        verbose: true,
        renderData: renderCombinedSearch,
        execution: { data: record, markdown: renderSearchExecution },
      },
      channels,
    ),
    0,
  );
  assert.equal(channels.out, '');
  assert.match(channels.err, /model\/primary.*HTTP 200/);
  assert.doesNotMatch(channels.err, /Success|Complete answer/);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /Execution time|HTTP 200/);
});

test(
  'Search SIGINT cancels native SSE and preserves an old output file with completed Exa data',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = temporary(t);
    const config = join(root, 'config.json');
    const output = join(root, 'old.json');
    writeFileSync(config, '{}');
    writeFileSync(output, 'old');
    let child: ReturnType<typeof spawn>;
    let timer: NodeJS.Timeout;
    const base = await server(t, (req, res) => {
      if (req.url === '/search') {
        res.end('{"results":[]}');
        timer = setTimeout(() => child.kill('SIGINT'), 100);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
      }
    });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('UNISEARCH_')),
    );
    child = spawn(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'search',
        'q',
        '--stream',
        '--extra-sources',
        'exa',
        '--format=json',
        '--output',
        output,
      ],
      {
        env: {
          ...environment,
          ...env,
          UNISEARCH_CONFIG_PATH: config,
          UNISEARCH_MODEL_BASE_URL: base,
          UNISEARCH_EXA_BASE_URL: base,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on('data', (chunk) => {
      stderr += chunk;
    });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const [code, signal] = await once(child, 'close');
      assert.equal(code, 130, stderr);
      assert.equal(signal, null);
      assert.deepEqual(JSON.parse(stdout).data, {
        extra_sources: [{ provider: 'exa', data: { results: [] } }],
      });
      assert.equal(JSON.parse(stdout).error.code, 'CANCELLED');
      assert.equal(readFileSync(output, 'utf8'), 'old');
    } finally {
      clearTimeout(watchdog);
      clearTimeout(timer!);
    }
  },
);
