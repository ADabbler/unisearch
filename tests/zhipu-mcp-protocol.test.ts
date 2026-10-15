import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import * as mcp from '../src/providers/zhipu-mcp.js';
import { executeRequest } from '../src/execution.js';
import type { ExecutionClock } from '../src/execution.js';
import type { JsonObject } from '../src/result.js';
import { fixture, initializeResult, pageText, pageUrl, rpc } from './zhipu-mcp-fixture.js';

test('Zhipu MCP consumes complete SSE events, split Unicode, multiline data and responds to ping and unsupported requests', async (t) => {
  const f = await fixture(t);
  for (const ending of ['\n', '\r\n', '\r']) {
    f.calls.length = 0;
    f.handle((call, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (message: unknown) => `data: ${JSON.stringify(message)}${ending}${ending}`;
      const result = JSON.stringify(
        {
          jsonrpc: '2.0',
          id: call.body.id,
          result: { content: [{ type: 'text', text: pageText }] },
        },
        null,
        2,
      )
        .split('\n')
        .map((line) => `data: ${line}`)
        .join(ending);
      const stream =
        `: heartbeat${ending}${ending}id: event-1${ending}data:${ending}${ending}` +
        event({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }) +
        event({ jsonrpc: '2.0', id: 'ping-1', method: 'ping' }) +
        event({
          jsonrpc: '2.0',
          id: 'unsupported-1',
          method: 'sampling/createMessage',
          params: {},
        }) +
        result +
        ending +
        ending;
      const bytes = Buffer.from(stream);
      const split = bytes.indexOf(Buffer.from('正文')) + 1;
      res.write(bytes.subarray(0, split));
      setImmediate(() => res.write(bytes.subarray(split)));
      // Leave the connection open: a matched complete result finishes the call.
    });
    const result = await f.run(['zhipu-mcp', 'search', 'q', '--format=json', '--timeout', '2']);
    assert.equal(result.exit, 0, result.channels.out);
    assert.equal(result.json().data.text, pageText);
    assert.deepEqual(
      f.calls.slice(3).map((call) => call.body),
      [
        { jsonrpc: '2.0', id: 'ping-1', result: {} },
        {
          jsonrpc: '2.0',
          id: 'unsupported-1',
          error: { code: -32601, message: 'Method not found' },
        },
      ],
    );
  }
});

test('Zhipu MCP rejects mismatched RPC IDs and damaged envelopes without accepting data', async (t) => {
  const f = await fixture(t);
  for (const body of [
    { jsonrpc: '2.0', id: '2', result: { content: [] } },
    { jsonrpc: '2.0', id: 99, result: { content: [] } },
    { jsonrpc: '1.0', id: 2, result: { content: [] } },
    { jsonrpc: '2.0', id: 2, result: { content: [] }, error: { code: 1, message: 'bad' } },
    { jsonrpc: '2.0', id: 2 },
    { jsonrpc: '2.0', id: 2, result: null },
    { jsonrpc: '2.0', id: 2, error: { code: 'bad', message: 'error' } },
  ]) {
    f.calls.length = 0;
    f.handle((_call, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    const result = await f.run(['zhipu-mcp', 'search', 'q', '--format=json'], {
      UNISEARCH_RETRIES: '2',
    });
    assert.equal(result.json().error.code, 'INVALID_RESPONSE', JSON.stringify(body));
    assert.equal(result.json().data, undefined);
    assert.equal(f.calls.length, 3);
  }
});

test('Zhipu MCP distinguishes incomplete SSE and resumable streams without replaying tools', async (t) => {
  const f = await fixture(t);
  for (const [body, expected, reason] of [
    [
      'data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}\n',
      'INVALID_RESPONSE',
      'incomplete_sse_event',
    ],
    ['data: {bad}\n\n', 'INVALID_RESPONSE', 'invalid_sse_json'],
    [': no result\n\n', 'INVALID_RESPONSE', 'missing_result'],
    ['id: 1\ndata:\n\nretry: 100\n\n', 'UPSTREAM_ERROR', 'stream_resume_required'],
  ]) {
    f.calls.length = 0;
    f.handle((_call, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    const result = await f.run(['zhipu-mcp', 'fetch', pageUrl, '--format=json'], {
      UNISEARCH_RETRIES: '2',
    });
    assert.equal(result.json().error.code, expected);
    assert.equal(result.json().error.details.reason, reason);
    assert.equal(result.json().data, undefined);
    assert.equal(f.calls.length, 3);
  }
});

test('Zhipu MCP HTTP classifications, invalid UTF-8, RPC errors and redirects stay explicit', async (t) => {
  const f = await fixture(t);
  for (const [status, code] of [
    [401, 'AUTHENTICATION_ERROR'],
    [402, 'QUOTA_EXCEEDED'],
    [403, 'ACCESS_DENIED'],
    [429, 'RATE_LIMITED'],
    [408, 'TIMEOUT'],
    [500, 'UPSTREAM_ERROR'],
    [504, 'TIMEOUT'],
    [302, 'UPSTREAM_ERROR'],
  ] as const) {
    f.calls.length = 0;
    f.initialize((_call, res) => {
      res.writeHead(status, { location: `${f.base}/unexpected`, 'x-request-id': 'reject-id' });
      res.end('{bad');
    });
    const result = await f.run(['zhipu-mcp', 'search', 'q', '--format=json', '--verbose']);
    assert.equal(result.json().error.code, code);
    assert.equal(result.json().error.details.reason, 'error_body_invalid');
    assert.equal(result.json().error.details.request_id, 'reject-id');
    assert.equal(result.json().meta.attempts[0].request_id, undefined);
    assert.equal(result.exit, status === 401 || status === 403 ? 3 : 4);
    assert.equal(f.calls.length, 1);
  }
  f.initialize(undefined);
  for (const type of ['application/json', 'text/event-stream']) {
    f.handle((_call, res) => {
      res.writeHead(200, { 'content-type': type });
      res.end(Buffer.from([0xff]));
    });
    const result = await f.run(['zhipu-mcp', 'search', 'q', '--format=json']);
    assert.equal(result.json().error.code, 'INVALID_RESPONSE');
  }
  for (const code of [-32601, -32602]) {
    f.handle((call, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: call.body.id,
          error: { code, message: 'tool rejected', data: { details: false } },
        }),
      );
    });
    const result = await f.run(['zhipu-mcp', 'search', 'q', '--format=json']);
    assert.equal(result.json().error.code, 'UPSTREAM_ERROR');
    assert.deepEqual(result.json().error.details.upstream_data, { details: false });
  }
});

test('Zhipu MCP retries whole sessions through the public budget, tracks Retry-After and preserves stage diagnostics', async (t) => {
  const f = await fixture(t);
  for (const mode of ['session', 'endpoint', 'rate', 'budget'] as const) {
    f.calls.length = 0;
    let failures = 0;
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
    f.initialize((call, res) => {
      now += 200;
      if (mode === 'endpoint') {
        res.writeHead(404);
        res.end('{}');
      } else
        rpc(res, call.body.id, initializeResult, {
          'mcp-session-id': 'fixture-session',
          'x-request-id': 'initial-id',
        });
    });
    f.handle((call, res) => {
      now += 300;
      if (failures++ === 0) {
        res.writeHead(mode === 'session' ? 404 : 429, {
          'retry-after': mode === 'budget' ? '20' : '1',
          'x-request-id': 'tool-id',
        });
        res.end('{}');
      } else rpc(res, call.body.id, { content: [{ type: 'text', text: 'done' }] });
    });
    const request = mcp.prepare('search', 'q', {}, {}, { ...f.env, UNISEARCH_RETRIES: '1' }, 'en');
    const record: JsonObject = {};
    const outcome = await executeRequest((context) => mcp.request(request, context, 'en'), {
      provider: 'zhipu-mcp',
      timeout: 10,
      requestLimit: 30,
      retries: 1,
      language: 'en',
      signal: new AbortController().signal,
      record,
      clock: time,
    });
    if (mode === 'endpoint' || mode === 'budget') {
      assert.equal(outcome.exitCode, 4);
      assert.equal(f.calls.length, mode === 'endpoint' ? 1 : 3);
      assert.deepEqual(waits, []);
    } else {
      assert.equal(outcome.exitCode, 0);
      assert.equal(f.calls.length, 6);
      assert.deepEqual(waits, [1000]);
      assert.deepEqual(caps, [10000, 8500]);
      assert.equal((record.attempts as JsonObject[])[1].request_id, undefined);
    }
  }
});

test('Zhipu MCP handshake, tool request, SSE reading and retry waits stop on cancellation and preserve files', async (t) => {
  const f = await fixture(t);
  const output = join(f.root, 'saved.json');
  for (const phase of ['initialize', 'tool', 'sse', 'wait'] as const) {
    f.calls.length = 0;
    writeFileSync(output, 'original');
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.initialize(phase === 'initialize' ? (_call, _res) => reached() : undefined);
    f.handle((_call, res) => {
      if (phase === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {');
      }
      if (phase === 'wait') {
        res.writeHead(503, { 'retry-after': '30' });
        res.end('{}');
      }
      reached();
    });
    const listeners = process.listenerCount('SIGINT');
    const pending = f.run(['zhipu-mcp', 'search', 'q', '--output', output, '--format=json'], {
      UNISEARCH_RETRIES: '2',
    });
    await ready;
    if (phase === 'wait') await new Promise<void>((done) => setTimeout(done, 20));
    process.emit('SIGINT');
    const result = await pending;
    assert.equal(result.exit, 130);
    assert.equal(readFileSync(output, 'utf8'), 'original');
    assert.equal(f.calls.length, phase === 'initialize' ? 1 : 3);
    assert.equal(process.listenerCount('SIGINT'), listeners);
  }
});

test('Zhipu MCP rejected HTTP bodies cannot turn authentication errors into retryable network failures', async (t) => {
  const f = await fixture(t);
  f.initialize((_call, res) => {
    res.writeHead(401, { 'content-type': 'application/json', 'content-length': '1000' });
    res.write('{');
    setImmediate(() => res.destroy());
  });
  const result = await f.run(['zhipu-mcp', 'search', 'q', '--format=json'], {
    UNISEARCH_RETRIES: '2',
  });
  assert.equal(result.exit, 3, result.channels.out);
  assert.equal(result.json().error.code, 'AUTHENTICATION_ERROR');
  assert.equal(f.calls.length, 1);
});

test('Zhipu MCP single-attempt cap covers the handshake and times out without starting a late tool call', async () => {
  for (const operation of ['search', 'fetch', 'docs', 'tree', 'read-file'] as const) {
    let now = 0;
    let timeout!: () => void;
    const caps: number[] = [];
    let calls = 0;
    const time: ExecutionClock = {
      now: () => now,
      wallNow: () => 0,
      schedule: (ms, cb) => {
        caps.push(ms);
        timeout = cb;
        return () => {};
      },
      sleep: async (ms) => {
        now += ms;
      },
    };
    const target = operation === 'fetch' ? pageUrl : 'a/b';
    const request = mcp.prepare(
      operation,
      target,
      { query: 'q', path: 'file' },
      {},
      { UNISEARCH_ZHIPU_MCP_API_KEY: 'fixture-key' },
      'en',
    );
    const transport: typeof fetch = async (_url, options) => {
      calls++;
      now += mcp.requestLimits[operation] * 1000;
      timeout();
      options!.signal!.throwIfAborted();
      throw new Error('unreachable');
    };
    const result = await executeRequest(
      (context) => mcp.request(request, context, 'en', transport),
      {
        provider: 'zhipu-mcp',
        timeout: 300,
        requestLimit: mcp.requestLimits[operation],
        retries: 0,
        language: 'en',
        signal: new AbortController().signal,
        clock: time,
        record: {},
      },
    );
    assert.equal(result.result.error?.code, 'TIMEOUT');
    assert.equal(result.result.error?.details?.operation, 'initialize');
    assert.equal(calls, 1);
    assert.deepEqual(caps, [mcp.requestLimits[operation] * 1000]);
  }
});

test('Zhipu MCP releases response streams after invalid session headers and failed SSE cleanup', async () => {
  const request = mcp.prepare(
    'search',
    'q',
    {},
    {},
    { UNISEARCH_ZHIPU_MCP_API_KEY: 'fixture-key' },
    'en',
  );
  for (const mode of ['invalid-session', 'cleanup-error']) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === 'cleanup-error')
          controller.enqueue(
            new TextEncoder().encode('data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}\n\n'),
          );
      },
      cancel() {
        cancelled = true;
        if (mode === 'cleanup-error') throw new Error('fixture cleanup error');
      },
    });
    const transport: typeof fetch = async (_url, options) => {
      const payload = JSON.parse(String(options!.body));
      if (mode === 'invalid-session')
        return new Response(body, {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'bad session' },
        });
      if (payload.method === 'initialize')
        return Response.json({ jsonrpc: '2.0', id: payload.id, result: initializeResult });
      if (payload.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const result = await mcp.request(
      request,
      { signal: new AbortController().signal },
      'en',
      transport,
    );
    assert.equal(
      result.outcome.result.error?.code,
      mode === 'invalid-session' ? 'INVALID_RESPONSE' : 'INTERNAL_ERROR',
    );
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
    assert.equal(result.retry, false);
  }
});

test('Zhipu MCP rejects non-finite error payloads without turning upstream errors into render failures', async (t) => {
  const f = await fixture(t);
  f.initialize((_call, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"value":1e999}}');
  });
  const http = await f.run(['zhipu-mcp', 'search', 'q', '--format=json']);
  assert.equal(http.exit, 3);
  assert.equal(http.json().error.code, 'AUTHENTICATION_ERROR');
  assert.equal(http.json().error.details.reason, 'error_body_invalid');
  f.initialize(undefined);
  f.handle((_call, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"bad","data":{"value":1e999}}}',
    );
  });
  const rpc = await f.run(['zhipu-mcp', 'search', 'q', '--format=json']);
  assert.equal(rpc.exit, 4);
  assert.equal(rpc.json().error.code, 'INVALID_RESPONSE');
  assert.equal(rpc.json().error.details.field, 'error.data');
});
