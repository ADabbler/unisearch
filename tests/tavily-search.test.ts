import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createCli } from '../src/cli/program.js';
import { text } from '../src/i18n/messages.js';
import { renderTavilySearch } from '../src/output/tavily.js';
import { tavilySearchData } from '../src/providers/tavily.js';
import type { JsonObject } from '../src/result.js';
import { capture, context, temporary } from './helpers.js';

test('Tavily scores preserve finite raw numbers including zero and omit absent values', () => {
  const scoreLabel = text('en', 'relevanceScore');
  for (const score of [0, -0.1, 1.5, 0.987654321]) {
    const data = tavilySearchData({ results: [{ url: 'https://example.org', score }] }, false);
    assert.equal(data.results[0].score, score);
    const markdown = renderTavilySearch(data, 'en');
    const lines = markdown.split('\n');
    assert.ok(
      lines.some((line) => line.startsWith(scoreLabel) && line.endsWith(`: ${score}`)),
      markdown,
    );
  }
  for (const score of [undefined, null]) {
    const data = tavilySearchData({ results: [{ url: 'https://example.org', score }] }, false);
    assert.equal(Object.hasOwn(data.results[0], 'score'), false);
    const markdown = renderTavilySearch(data, 'en');
    assert.ok(!markdown.includes(scoreLabel), markdown);
  }
  for (const score of ['0.8', Infinity])
    assert.throws(
      () => tavilySearchData({ results: [{ url: 'https://example.org', score }] }, false),
      { code: 'INVALID_RESPONSE' },
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

test('Three native tasks start concurrently, reuse saved operation settings and retain requested source order', async (t) => {
  const root = temporary(t);
  const file = join(root, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      providers: {
        tavily: { search: { limit: 8, search_depth: 'advanced' } },
        exa: { search: { limit: 2, search_type: 'lite' } },
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
    assert.equal(exa.body.type, 'lite');
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
      '--sources',
      'model,' + sources,
      '--format=json',
      '--timeout',
      '2',
      '--verbose',
    ]);
    assert.equal(exit, 0, channels.out);
    const json = JSON.parse(channels.out);
    assert.deepEqual(
      json.data.sources
        .filter((source: { provider: string }) => source.provider !== 'model')
        .map((item: { provider: string }) => item.provider),
      sources.split(','),
    );
    assert.equal(
      json.data.sources.find((item: { provider: string }) => item.provider === 'tavily').data
        .provider,
      undefined,
    );
    assert.equal(json.meta.attempts.length, 3);
  }
  assert.equal(calls, 6);
});

test('Combined search retains Tavily scores and reports supplemental failures in source order', async (t) => {
  const root = temporary(t);
  let tavilyFails = false;
  const base = await server(t, (req, res) => {
    if (req.url === '/responses') res.end(JSON.stringify(answer));
    else if (req.url?.startsWith('/exa/')) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'busy' }));
    } else if (tavilyFails) {
      res.writeHead(432);
      res.end(JSON.stringify({ detail: { error: 'quota exhausted' } }));
    } else {
      res.end(
        JSON.stringify({
          results: [{ url: 'https://example.org/a', content: 'Relevant', score: 0.875 }],
        }),
      );
    }
  });
  const config = context(root, {
    ...env,
    UNISEARCH_MODEL_BASE_URL: base,
    UNISEARCH_EXA_BASE_URL: `${base}/exa`,
    UNISEARCH_TAVILY_BASE_URL: `${base}/tavily`,
  });
  for (tavilyFails of [false, true]) {
    const channels = capture();
    const exit = await createCli('test', { config, channels }).run([
      'search',
      'q',
      '--sources',
      'model,tavily,exa',
      '--format=json',
    ]);
    assert.equal(exit, 6);
    const result = JSON.parse(channels.out);
    assert.equal(result.status, 'partial');
    assert.deepEqual(
      result.error.details.failures.map(
        ({ provider, code }: { provider: string; code: string }) => [provider, code],
      ),
      tavilyFails
        ? [
            ['tavily', 'QUOTA_EXCEEDED'],
            ['exa', 'UPSTREAM_ERROR'],
          ]
        : [['exa', 'UPSTREAM_ERROR']],
    );
    const tavily = result.data.sources.find(
      ({ provider }: { provider: string }) => provider === 'tavily',
    );
    if (tavilyFails) assert.equal(tavily, undefined);
    else {
      assert.equal(tavily.data.results[0].summary, 'Relevant');
      assert.equal(tavily.data.results[0].score, 0.875);
    }
  }
});

test('A bad selected Tavily prerequisite prevents all three native requests', async (t) => {
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
    }).run(['search', 'q', '--sources', 'model,exa,tavily']);
    assert.equal(exit, 3);
  }
  assert.equal(calls, 0);
});
