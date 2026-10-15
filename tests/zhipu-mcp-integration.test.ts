import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { fixture, pageUrl, pageText, rpc } from './zhipu-mcp-fixture.js';
import { prepareRetrieval, retrieve } from '../src/retrieval.js';
import { prepareCombinedSearch, combinedSearch } from '../src/search.js';
import type { ExecutionClock } from '../src/execution.js';
import type { JsonObject } from '../src/result.js';

const modelResult = {
  model: 'fixture-model',
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'model answer', annotations: [] }],
    },
  ],
};

test('Zhipu MCP unified fetch keeps the default position, uses one configuration and preserves fallback rules', async (t) => {
  const f = await fixture(t);
  const configured = (await f.run(['config', 'get', 'fetch.providers'])).json().data
    .value as string[];
  assert.ok(configured.indexOf('jina') < configured.indexOf('zhipu-mcp'));
  assert.ok(configured.indexOf('zhipu-mcp') < configured.indexOf('tinyfish'));
  assert.equal(
    (await f.run(['fetch', pageUrl, '--format=json'])).json().data.provider,
    'zhipu-mcp',
  );
  f.env.UNISEARCH_EXA_API_KEY = 'fixture-exa-key';
  f.env.UNISEARCH_EXA_BASE_URL = `${f.base}/exa`;
  f.save({ fetch: { providers: ['zhipu-mcp', 'exa'] } });
  for (const [kind, expected, switched] of [
    ['empty', 0, true],
    ['invalid', 0, true],
    ['auth', 0, true],
    ['unknown-tool', 4, false],
  ] as const) {
    f.calls.length = 0;
    f.handle((call, res) => {
      if (call.path === '/exa/contents')
        res.end(
          JSON.stringify({ results: [{ url: pageUrl, title: 'Exa page', text: 'Exa page' }] }),
        );
      else if (kind === 'auth') {
        res.writeHead(401);
        res.end('{}');
      } else if (kind === 'empty') rpc(res, call.body.id, { content: [] });
      else if (kind === 'invalid')
        rpc(res, call.body.id, {
          content: [
            { type: 'text', text: pageText },
            { type: 'text', text: null },
          ],
        });
      else
        rpc(res, call.body.id, { isError: true, content: [{ type: 'text', text: 'tool error' }] });
    });
    const result = await f.run(['fetch', pageUrl, '--format=json']);
    assert.equal(result.exit, expected, result.channels.out);
    assert.equal(f.calls.length, switched ? 4 : 3);
    if (switched) assert.equal(result.json().data.provider, 'exa');
  }
  f.calls.length = 0;
  f.result({ content: [] });
  assert.equal((await f.run(['fetch', pageUrl, '--no-fallback', '--format=json'])).exit, 4);
  assert.equal(f.calls.length, 3);
  f.save({ fetch: { providers: ['zhipu-mcp', 'exa'] }, providers: { exa: { base_url: 'bad' } } });
  f.calls.length = 0;
  assert.equal((await f.run(['fetch', pageUrl], { UNISEARCH_EXA_BASE_URL: undefined })).exit, 3);
  assert.equal(f.calls.length, 0);
});

test('Zhipu MCP unified fetch retains verified body after later failures and shares its deadline', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_EXA_API_KEY = 'fixture-exa-key';
  f.env.UNISEARCH_EXA_BASE_URL = `${f.base}/exa`;
  f.save({ fetch: { providers: ['zhipu-mcp', 'exa'] } });
  f.handle((call, res) => {
    if (call.path === '/exa/contents') {
      res.writeHead(401);
      res.end('{}');
    } else
      rpc(
        res,
        call.body.id,
        {
          content: [
            { type: 'text', text: pageText },
            { type: 'text', text: null },
          ],
        },
        { 'x-request-id': 'mcp-body' },
      );
  });
  const output = join(f.root, 'retained.json');
  const result = await f.run(['fetch', pageUrl, '--format=json', '--verbose', '--output', output]);
  const saved = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(result.exit, 4);
  assert.equal(saved.data.provider, 'zhipu-mcp');
  assert.equal(saved.data.results[0].text, pageText);
  assert.equal(result.channels.out, '');
  assert.deepEqual(
    saved.error.details.failures.map((failure: JsonObject) => failure.provider),
    ['zhipu-mcp', 'exa'],
  );
  assert.equal(saved.meta.attempts[0].request_id, undefined);

  let now = 0;
  const caps: number[] = [];
  const time: ExecutionClock = {
    now: () => now,
    wallNow: () => 0,
    schedule: (ms) => {
      caps.push(ms);
      return () => {};
    },
    sleep: async (ms) => {
      now += ms;
    },
  };
  const plan = prepareRetrieval(
    'fetch',
    pageUrl,
    { timeout: 4 },
    { fetch: { providers: ['zhipu-mcp', 'exa'] } },
    f.env,
    'en',
  );
  await retrieve(
    plan,
    new AbortController().signal,
    'en',
    {},
    {
      clock: time,
      transport: async (url, options) => {
        now += 500;
        return fetch(url, options);
      },
    },
  );
  assert.deepEqual(caps, [4000, 2500]);
});

test(
  'Zhipu MCP supplement starts alongside model and Exa and preserves order when responses finish in reverse',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    Object.assign(f.env, {
      UNISEARCH_MODEL_API_KEY: 'fixture-model',
      UNISEARCH_MODEL_BASE_URL: `${f.base}/model`,
      UNISEARCH_MODEL_ID: 'example',
      UNISEARCH_EXA_API_KEY: 'fixture-exa',
      UNISEARCH_EXA_BASE_URL: `${f.base}/exa`,
    });
    const waiting = new Map<string, { res: ServerResponse; id: unknown }>();
    f.handle((call, res) => {
      waiting.set(call.path, { res, id: call.body.id });
      if (waiting.size !== 3) return;
      for (const [path, item] of [...waiting.entries()].reverse()) {
        if (path.startsWith('/gateway'))
          rpc(item.res, item.id, { content: [{ type: 'text', text: 'MCP evidence' }] });
        else
          item.res.end(
            JSON.stringify(
              path === '/model/responses'
                ? modelResult
                : { results: [{ url: pageUrl, title: 'Exa page' }] },
            ),
          );
      }
    });
    const result = await f.run([
      'search',
      'q',
      '--extra-sources',
      'zhipu-mcp,exa',
      '--format=json',
      '--timeout',
      '2',
    ]);
    assert.equal(result.exit, 0, result.channels.out);
    assert.deepEqual(
      result.json().data.extra_sources.map((source: JsonObject) => source.provider),
      ['zhipu-mcp', 'exa'],
    );
    assert.deepEqual(result.json().data.extra_sources[0].data, { text: 'MCP evidence' });
  },
);

test('Zhipu MCP failed supplements retain evidence even when every task fails, and model fallback never repeats the tool', async (t) => {
  const f = await fixture(t);
  Object.assign(f.env, {
    UNISEARCH_MODEL_API_KEY: 'fixture-model',
    UNISEARCH_MODEL_BASE_URL: `${f.base}/model`,
    UNISEARCH_MODEL_ID: 'primary',
  });
  f.save({ providers: { model: { fallback_models: [{ id: 'backup' }] } } });
  for (const mode of ['all-fail', 'mcp-fail', 'fallback'] as const) {
    f.calls.length = 0;
    f.handle((call, res) => {
      if (call.path === '/model/responses') {
        if (mode === 'all-fail') {
          res.writeHead(401);
          res.end('{}');
        } else if (mode === 'fallback' && call.body.model === 'primary') res.end('{}');
        else res.end(JSON.stringify(modelResult));
      } else
        rpc(res, call.body.id, {
          content: [
            { type: 'text', text: 'reliable evidence' },
            { type: 'text', text: 1 },
          ],
        });
    });
    const result = await f.run(['search', 'q', '--extra-sources', 'zhipu-mcp', '--format=json']);
    assert.equal(result.exit, mode === 'all-fail' ? 3 : 6, result.channels.out);
    assert.equal(result.json().data.extra_sources[0].data.text, 'reliable evidence');
    assert.equal(result.json().error.details.failures.at(-1).provider, 'zhipu-mcp');
    assert.equal(f.calls.filter((call) => call.body.method === 'tools/call').length, 1);
    assert.equal(
      f.calls.filter((call) => call.path === '/model/responses').length,
      mode === 'fallback' ? 2 : 1,
    );
  }
});

test('Zhipu MCP supplement cancellation and internal transport errors preserve completed evidence', async (t) => {
  const f = await fixture(t);
  Object.assign(f.env, {
    UNISEARCH_MODEL_API_KEY: 'fixture-model',
    UNISEARCH_MODEL_BASE_URL: `${f.base}/model`,
    UNISEARCH_MODEL_ID: 'primary',
  });
  for (const mode of ['cancel', 'internal'] as const) {
    const controller = new AbortController();
    let completed!: () => void;
    const ready = new Promise<void>((done) => {
      completed = done;
    });
    f.result({ content: [{ type: 'text', text: 'preserved evidence' }] });
    const plan = prepareCombinedSearch('q', { extraSources: 'zhipu-mcp' }, {}, f.env, 'en');
    const transport: typeof fetch = async (url, options) => {
      if (String(url).endsWith('/model/responses')) {
        await ready;
        // Let the MCP branch finish mapping its response before stopping the model branch.
        await new Promise<void>((done) => setTimeout(done, 10));
        if (mode === 'internal') throw new Error('fixture programming error');
        controller.abort();
        options!.signal!.throwIfAborted();
      }
      const response = await fetch(url, options);
      if (JSON.parse(String(options!.body)).method === 'tools/call') completed();
      return response;
    };
    const result = await combinedSearch(plan, controller.signal, 'en', {}, { transport });
    assert.equal(result.exitCode, mode === 'cancel' ? 130 : 5);
    const source = result.result.data?.extra_sources?.[0];
    assert.ok(source?.provider === 'zhipu-mcp');
    assert.equal(source.data.text, 'preserved evidence');
  }
});

test('Zhipu MCP file output uses the same result and keeps existing files when no trustworthy data is returned', async (t) => {
  const f = await fixture(t);
  const output = join(f.root, 'result');
  for (const format of ['markdown', 'json']) {
    f.calls.length = 0;
    f.result({ content: [{ type: 'text', text: 'code\n```\nend\n' }] });
    const result = await f.run([
      'zhipu-mcp',
      'read-file',
      'a/b',
      'file',
      '--format',
      format,
      '--output',
      output,
      '--verbose',
    ]);
    assert.equal(result.exit, 0);
    assert.equal(f.calls.length, 3);
    const saved = readFileSync(output, 'utf8');
    assert.equal(result.channels.out, '');
    if (format === 'markdown') {
      assert.match(result.channels.err, /Execution time/);
      assert.match(saved, /````text/);
      assert.doesNotMatch(saved, /Execution time/);
    } else {
      assert.equal(JSON.parse(saved).data.text, 'code\n```\nend\n');
      assert.equal(JSON.parse(saved).meta.attempts.length, 1);
    }
    f.result({ isError: true, content: [{ type: 'text', text: 'failure' }] });
    writeFileSync(output, 'keep');
    assert.equal(
      (
        await f.run([
          'zhipu-mcp',
          'read-file',
          'a/b',
          'file',
          '--format',
          format,
          '--output',
          output,
        ])
      ).exit,
      4,
    );
    assert.equal(readFileSync(output, 'utf8'), 'keep');
  }
});
