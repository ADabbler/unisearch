import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createCli } from '../src/cli/program.js';
import { combinedSearch, prepareCombinedSearch } from '../src/search.js';
import { renderTavilySearch } from '../src/output/tavily.js';
import { tavilySearchData } from '../src/providers/tavily.js';
import type { JsonObject } from '../src/result.js';
import { capture, context, temporary } from './helpers.js';

test('Tavily scores preserve finite raw numbers including zero and omit absent values', () => {
  for (const score of [0, -0.1, 1.5, 0.987654321]) {
    const data = tavilySearchData(
      { results: [{ url: 'https://example.org', published_date: '2026-09-01', score }] },
      false,
    );
    assert.equal(data.results[0].score, score);
    assert.ok(
      renderTavilySearch(data, 'en').includes(
        `Published or updated: 2026-09-01 · Relevance score: ${score}`,
      ),
    );
    assert.ok(renderTavilySearch(data, 'zh').includes(`相关性评分：${score}`));
  }
  for (const score of [undefined, null]) {
    const data = tavilySearchData({ results: [{ url: 'https://example.org', score }] }, false);
    assert.equal(Object.hasOwn(data.results[0], 'score'), false);
    assert.doesNotMatch(renderTavilySearch(data, 'en'), /Relevance score/);
  }
  for (const score of ['0.8', '', false, {}, Infinity, NaN])
    assert.throws(() =>
      tavilySearchData({ results: [{ url: 'https://example.org', score }] }, false),
    );
});

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
  UNISEARCH_TAVILY_API_KEY: 'tavily-secret',
  UNISEARCH_RETRIES: '0',
  UNISEARCH_LANG: 'en',
};
async function server(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
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

test('three native tasks start concurrently, reuse saved operation settings and retain requested source order', async (t) => {
  const root = temporary(t);
  const file = join(root, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      providers: {
        tavily: { search: { limit: 8, search_depth: 'advanced' } },
        exa: { search: { limit: 2, search_type: 'fast' } },
      },
    }),
  );
  let pending: { res: ServerResponse; path: string; body: JsonObject }[] = [];
  let calls = 0;
  const base = await server(t, async (req, res) => {
    calls++;
    pending.push({ res, path: req.url!, body: await body(req) });
    if (pending.length !== 3) return;
    const model = pending.find((item) => item.path === '/responses')!;
    assert.deepEqual(model.body.input, [{ role: 'user', content: ' original query ' }]);
    const exa = pending.find((item) => item.path === '/exa/search')!;
    assert.equal(exa.body.query, ' original query ');
    assert.equal(exa.body.numResults, 2);
    assert.equal(exa.body.type, 'fast');
    const tavily = pending.find((item) => item.path === '/tavily/search')!;
    assert.equal(tavily.body.query, ' original query ');
    assert.equal(tavily.body.max_results, 8);
    assert.equal(tavily.body.search_depth, 'advanced');
    assert.equal(tavily.body.topic, 'general');
    assert.equal(tavily.body.include_raw_content, false);
    // Completion order deliberately differs from both requested source orders.
    tavily.res.end('{"results":[{"url":"https://example.com/a","content":"Tavily snippet"}]}');
    model.res.end(JSON.stringify(answer));
    exa.res.end('{"results":[]}');
    pending = [];
  });
  for (const sources of ['exa,tavily', 'tavily,exa']) {
    const channels = capture();
    const exit = await createCli('test', {
      config: context(root, {
        ...env,
        UNISEARCH_CONFIG_PATH: file,
        UNISEARCH_MODEL_BASE_URL: base,
        UNISEARCH_EXA_BASE_URL: `${base}/exa`,
        UNISEARCH_TAVILY_BASE_URL: `${base}/tavily`,
      }),
      channels,
    }).run([
      'search',
      ' original query ',
      '--extra-sources',
      sources,
      '--format=json',
      '--timeout',
      '2',
      '--verbose',
    ]);
    assert.equal(exit, 0, channels.out);
    const json = JSON.parse(channels.out);
    assert.deepEqual(
      json.data.extra_sources.map((item: { provider: string }) => item.provider),
      sources.split(','),
    );
    assert.equal(
      json.data.extra_sources.find((item: { provider: string }) => item.provider === 'tavily').data
        .provider,
      undefined,
    );
    assert.equal(json.meta.attempts.length, 3);
  }
  assert.equal(calls, 6);
});

test('eight model/Exa/Tavily combinations preserve data and failure order, including quota and timeout errors', async (t) => {
  const root = temporary(t);
  let mask = 0;
  let calls = 0;
  const base = await server(t, (req, res) => {
    calls++;
    const provider = req.url === '/responses' ? 'model' : req.url!.split('/')[1];
    const fail = mask & { model: 1, exa: 2, tavily: 4 }[provider as 'model' | 'exa' | 'tavily'];
    if (!fail) {
      let payload: JsonObject = { results: [] };
      if (provider === 'model') payload = answer;
      else if (provider === 'tavily')
        payload = {
          results: [{ url: 'https://example.org/a', content: 'Relevant', score: 0.875 }],
        };
      res.end(JSON.stringify(payload));
      return;
    }
    switch (provider) {
      case 'model':
        res.writeHead(401);
        res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
        break;
      case 'exa':
        res.writeHead(503);
        res.end(JSON.stringify({ error: 'busy' }));
        break;
      case 'tavily':
        res.writeHead(mask === 4 ? 504 : 432);
        res.end(JSON.stringify({ detail: { error: 'failed' } }));
        break;
    }
  });
  for (mask = 0; mask < 8; mask++)
    for (const sources of ['exa,tavily', 'tavily,exa']) {
      const channels = capture();
      const output = join(root, 'result.json');
      writeFileSync(output, 'old');
      const exit = await createCli('test', {
        config: context(root, {
          ...env,
          UNISEARCH_MODEL_BASE_URL: base,
          UNISEARCH_EXA_BASE_URL: `${base}/exa`,
          UNISEARCH_TAVILY_BASE_URL: `${base}/tavily`,
        }),
        channels,
      }).run(['search', 'q', '--extra-sources', sources, '--format=json', '--output', output]);
      let expectedExit = 0;
      let expectedStatus = 'success';
      if (mask & 1) {
        expectedExit = 3;
        expectedStatus = 'error';
      } else if (mask) {
        expectedExit = 6;
        expectedStatus = 'partial';
      }
      assert.equal(exit, expectedExit);
      const saved = readFileSync(output, 'utf8');
      const json = JSON.parse(saved === 'old' ? channels.out : saved);
      assert.equal(json.status, expectedStatus);
      const successful = sources
        .split(',')
        .filter((provider) => !(mask & (provider === 'exa' ? 2 : 4)));
      assert.deepEqual(
        json.data?.extra_sources?.map((item: { provider: string }) => item.provider) ?? [],
        successful,
      );
      assert.equal(json.data?.answer !== undefined, !(mask & 1));
      if (!(mask & 4))
        assert.equal(
          json.data.extra_sources.find((item: { provider: string }) => item.provider === 'tavily')
            .data.results[0].score,
          0.875,
        );
      const failed = ['model', ...sources.split(',')].filter(
        (provider) =>
          mask & { model: 1, exa: 2, tavily: 4 }[provider as 'model' | 'exa' | 'tavily'],
      );
      assert.deepEqual(
        json.error?.details.failures.map((item: { provider: string }) => item.provider) ?? [],
        failed,
      );
      const tavilyFailure = json.error?.details.failures.find(
        (item: { provider: string }) => item.provider === 'tavily',
      );
      if (tavilyFailure) {
        assert.equal(tavilyFailure.code, mask === 4 ? 'TIMEOUT' : 'QUOTA_EXCEEDED');
        assert.equal(tavilyFailure.details.provider, undefined);
      }
      assert.equal(saved === 'old', mask === 7);
    }
  assert.equal(calls, 48);
});

test('a bad selected Tavily prerequisite prevents all three native requests', async (t) => {
  const root = temporary(t);
  let calls = 0;
  const base = await server(t, (_req, res) => {
    calls++;
    res.end('{}');
  });
  const file = join(root, 'config.json');
  for (const tavily of [{}, { enabled: false }, { search: { limit: 21 } }]) {
    writeFileSync(file, JSON.stringify({ providers: { tavily } }));
    const environment: NodeJS.ProcessEnv = {
      ...env,
      UNISEARCH_CONFIG_PATH: file,
      UNISEARCH_MODEL_BASE_URL: base,
      UNISEARCH_EXA_BASE_URL: base,
      UNISEARCH_TAVILY_BASE_URL: base,
    };
    if (!Object.keys(tavily).length) delete environment.UNISEARCH_TAVILY_API_KEY;
    const exit = await createCli('test', {
      config: context(root, environment),
      channels: capture(),
    }).run(['search', 'q', '--extra-sources', 'exa,tavily']);
    assert.equal(exit, 3);
  }
  assert.equal(calls, 0);
});

test('model fallback does not restart either supplement and an empty successful source remains visible', async () => {
  const plan = prepareCombinedSearch(
    'q',
    { extraSources: 'tavily,exa' },
    { providers: { model: { fallback_models: [{ id: 'backup' }] } } },
    env,
    'en',
  );
  const calls: string[] = [];
  const result = await combinedSearch(
    plan,
    new AbortController().signal,
    'en',
    {},
    {
      transport: async (url, init) => {
        const request = JSON.parse(init!.body as string);
        let provider = 'exa';
        if (String(url).endsWith('/responses')) provider = 'model';
        else if (String(url).includes('tavily')) provider = 'tavily';
        calls.push(provider);
        if (provider === 'model')
          return request.model === 'primary'
            ? Response.json(
                { error: { code: 'model_not_found', message: 'Model not found' } },
                { status: 404 },
              )
            : Response.json(answer);
        return Response.json({ results: [] });
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(calls.filter((item) => item === 'model').length, 2);
  assert.equal(calls.filter((item) => item === 'exa').length, 1);
  assert.equal(calls.filter((item) => item === 'tavily').length, 1);
  assert.deepEqual(
    result.result.data?.extra_sources?.map((item) => item.provider),
    ['tavily', 'exa'],
  );
});

test('internal Tavily failure cancels pending tasks; completed supplements survive internal errors and user cancellation', async () => {
  for (const cancel of [false, true]) {
    const plan = prepareCombinedSearch('q', { extraSources: 'tavily,exa' }, {}, env, 'en');
    const abort = new AbortController();
    let modelAborted = false;
    const result = await combinedSearch(
      plan,
      abort.signal,
      'en',
      {},
      {
        transport: async (url, init) => {
          if (new URL(String(url)).hostname === 'api.exa.ai') return Response.json({ results: [] });
          if (String(url).includes('tavily')) {
            await new Promise((done) => setImmediate(done));
            if (cancel) abort.abort();
            throw new Error('private fault');
          }
          return new Promise((_resolve, reject) => {
            init!.signal!.addEventListener(
              'abort',
              () => {
                modelAborted = true;
                reject(new Error('abort'));
              },
              { once: true },
            );
          });
        },
      },
    );
    assert.equal(result.exitCode, cancel ? 130 : 5);
    assert.equal(modelAborted, true);
    assert.deepEqual(result.result.data?.extra_sources, [
      { provider: 'exa', data: { results: [] } },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /private fault/);
  }
});
