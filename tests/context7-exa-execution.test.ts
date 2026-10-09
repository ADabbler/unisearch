import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createCli } from '../src/cli/program.js';
import * as ctx7 from '../src/providers/context7.js';
import * as exa from '../src/providers/exa.js';
import { executeRequest } from '../src/execution.js';
import type { ExecutionClock, AttemptContext } from '../src/execution.js';
import { capture, context, temporary } from './helpers.js';
import type { JsonObject } from '../src/result.js';

const pageUrl = 'https://example.org/a';
const providers = ['ctx7', 'exa'] as const;
function operation(provider: (typeof providers)[number], transport: typeof fetch) {
  if (provider === 'ctx7') {
    const request = ctx7.prepare('docs', '/a/b', 'q', undefined, {}, {}, 'en');
    return (context: AttemptContext) => ctx7.request(request, context, 'en', transport);
  }
  const env = { UNISEARCH_EXA_API_KEY: 'fixture-exa-key' };
  const request = exa.prepareFetch([pageUrl], {}, {}, env, 'en');
  return (context: AttemptContext) => exa.requestFetch(request, context, 'en', transport);
}

test('Context7 and Exa classify invalid encodings, network failures and internal exceptions explicitly', async () => {
  for (const provider of providers) {
    for (const payload of [new Uint8Array([0xff]), '<html>bad</html>', '{', '{}']) {
      const result = await operation(
        provider,
        async () => new Response(payload),
      )({ signal: new AbortController().signal });
      assert.equal(result.outcome.result.error?.code, 'INVALID_RESPONSE');
      assert.equal(result.retry, false);
      assert.equal(result.outcome.result.data, undefined);
    }
    for (const [code, expected, retry] of [
      ['ECONNRESET', 'NETWORK_ERROR', true],
      ['ENOTFOUND', 'NETWORK_ERROR', false],
      ['CERT_HAS_EXPIRED', 'NETWORK_ERROR', false],
      ['ETIMEDOUT', 'TIMEOUT', true],
    ] as const) {
      const result = await operation(provider, async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('fixture transport'), { code }),
        });
      })({ signal: new AbortController().signal });
      assert.equal(result.outcome.result.error?.code, expected);
      assert.equal(result.retry, retry);
    }
    const result = await operation(provider, async () => {
      throw new Error('programming error');
    })({ signal: new AbortController().signal });
    assert.equal(result.outcome.exitCode, 5);
  }
});

test('late timeouts do not restart complete failures or permanent transport errors', async () => {
  for (const provider of providers)
    for (const mode of ['invalid', 'content', 'permanent', 'temporary'] as const) {
      let now = 0;
      let calls = 0;
      let cleared = 0;
      const abort = new AbortController();
      const time: ExecutionClock = {
        now: () => now,
        wallNow: () => 0,
        schedule: () => () => {
          cleared++;
        },
        sleep: async (ms) => {
          now += ms;
        },
      };
      const transport: typeof fetch = async () => {
        if (mode === 'permanent')
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('fixture'), { code: 'ENOTFOUND' }),
          });
        if (mode === 'temporary') return Response.json({}, { status: 503 });
        if (mode === 'invalid') return Response.json({});
        return provider === 'ctx7'
          ? Response.json({ error: 'library_not_finalized', message: 'not ready' }, { status: 202 })
          : Response.json({ results: [], statuses: [{ id: pageUrl, status: 'error' }] });
      };
      const invoke = operation(provider, transport);
      const result = await executeRequest<JsonObject>(
        async (context) => {
          calls++;
          const result = await invoke(context);
          now += 30001;
          return result;
        },
        {
          provider,
          timeout: 100,
          requestLimit: 30,
          retries: 1,
          signal: abort.signal,
          language: 'en',
          clock: time,
          record: {},
        },
      );
      assert.equal(result.result.error?.code, 'TIMEOUT');
      assert.equal(calls, mode === 'temporary' ? 2 : 1, `${provider}: ${mode}`);
      assert.equal(cleared, calls);
    }
});

test('Context7 and Exa respect Retry-After, remaining budget and cancellation during waits', async () => {
  for (const provider of providers)
    for (const mode of ['valid', 'invalid', 'exceeds', 'cancel'] as const) {
      let now = 0;
      let calls = 0;
      const caps: number[] = [];
      const waits: number[] = [];
      const controller = new AbortController();
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
          if (mode === 'cancel') controller.abort();
        },
      };
      const invoke = operation(provider, async () => {
        calls++;
        now += 500;
        if (calls === 1)
          return Response.json(
            { error: 'busy', message: 'busy' },
            {
              status: 503,
              headers: {
                'retry-after': { valid: '1', invalid: 'broken', exceeds: '4', cancel: '1' }[mode],
              },
            },
          );
        return Response.json(
          provider === 'ctx7'
            ? { codeSnippets: [], infoSnippets: [] }
            : { results: [{ url: pageUrl, title: 'A', text: 'body' }] },
        );
      });
      const record: JsonObject = {};
      const result = await executeRequest<JsonObject>(invoke, {
        provider,
        timeout: 4,
        requestLimit: 30,
        retries: 1,
        signal: controller.signal,
        language: 'en',
        record,
        clock: time,
      });
      const expectedExit = { valid: 0, invalid: 0, exceeds: 4, cancel: 130 }[mode];
      assert.equal(result.exitCode, expectedExit);
      assert.deepEqual(caps, mode === 'valid' || mode === 'invalid' ? [4000, 2500] : [4000]);
      assert.deepEqual(waits, mode === 'exceeds' ? [] : [1000]);
      if (mode === 'invalid')
        assert.equal((record.attempts as JsonObject[])[0].retry_after_invalid, true);
      if (mode === 'exceeds')
        assert.equal(result.result.error?.details?.reason, 'retry_wait_exceeds_budget');
    }
});

test('native Context7 and Exa requests cancel during headers or body, preserving existing files and listeners', async (t) => {
  const root = temporary(t);
  const output = join(root, 'saved.json');
  let stage: 'headers' | 'body' = 'headers';
  let received!: () => void;
  const server = createServer((req, res) => {
    req.resume();
    if (stage === 'body') {
      res.writeHead(200);
      res.write('{');
    }
    received();
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
  for (const provider of providers)
    for (const phase of ['headers', 'body'] as const) {
      stage = phase;
      writeFileSync(output, 'original');
      const ready = new Promise<void>((done) => {
        received = done;
      });
      const channels = capture();
      const before = process.listenerCount('SIGINT');
      const command =
        provider === 'ctx7' ? ['ctx7', 'docs', '/a/b', 'q'] : ['exa', 'fetch', pageUrl];
      const pending = createCli('test', {
        config: context(root, {
          UNISEARCH_LANG: 'en',
          UNISEARCH_EXA_API_KEY: 'fixture-key',
          UNISEARCH_EXA_BASE_URL: base,
          UNISEARCH_CTX7_BASE_URL: base,
        }),
        channels,
      }).run([...command, '--output', output, '--format=json']);
      await ready;
      process.emit('SIGINT');
      assert.equal(await pending, 130);
      assert.equal(JSON.parse(channels.out).data, undefined);
      assert.equal(readFileSync(output, 'utf8'), 'original');
      assert.deepEqual(readdirSync(root), ['saved.json']);
      assert.equal(process.listenerCount('SIGINT'), before);
    }
});

test('Context7 request IDs and redirects redact all credential sources while document content remains intact', async () => {
  const request = ctx7.prepare(
    'docs',
    '/a/b',
    'q',
    undefined,
    { providers: { ctx7: { api_key: 'old-secret' }, exa: { api_key: 'exa-secret' } } },
    { UNISEARCH_CTX7_API_KEY: 'new-secret' },
    'en',
  );
  const result = await ctx7.request(
    request,
    { signal: new AbortController().signal },
    'en',
    async () =>
      Response.json(
        {
          error: 'library_redirected',
          message: 'old-secret exa-secret new-secret',
          redirectUrl: '/old-secret/exa-secret',
        },
        {
          status: 301,
          headers: { 'x-request-id': 'new-secret', 'x-context7-request-id': 'secondary' },
        },
      ),
  );
  assert.doesNotMatch(JSON.stringify(result), /old-secret|exa-secret|new-secret|secondary/);
  assert.equal(result.outcome.result.error?.details?.request_id, '[REDACTED]');
  const ok = await ctx7.request(request, { signal: new AbortController().signal }, 'en', async () =>
    Response.json({
      codeSnippets: [],
      infoSnippets: [{ content: 'old-secret exa-secret new-secret' }],
    }),
  );
  assert.equal(
    (ok.outcome.result.data as ctx7.DocsData).info_snippets[0].content,
    'old-secret exa-secret new-secret',
  );
});
