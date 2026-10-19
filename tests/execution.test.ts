import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { getEventListeners, once } from 'node:events';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { executeRequest, retryAfterSeconds } from '../src/execution.js';
import type { AttemptResult, ExecutionClock } from '../src/execution.js';
import { AppError, failure } from '../src/errors.js';
import { success } from '../src/result.js';
import type { JsonObject } from '../src/result.js';
import { prepareSearch, requestSearch } from '../src/providers/exa.js';
import { createCli } from '../src/cli/program.js';
import { renderExecution } from '../src/output/exa.js';
import { capture, context, temporary } from './helpers.js';

function controlled() {
  let now = 0;
  const waits: number[] = [];
  const deadlines: number[] = [];
  let liveTimers = 0;
  const clock: ExecutionClock = {
    now: () => now,
    wallNow: () => Date.UTC(2026, 8, 30) + now,
    async sleep(ms, signal) {
      signal.throwIfAborted();
      waits.push(ms);
      now += ms;
    },
    schedule(ms) {
      deadlines.push(ms);
      liveTimers++;
      return () => {
        liveTimers--;
      };
    },
  };
  return {
    clock,
    waits,
    deadlines,
    advance: (ms: number) => {
      now += ms;
    },
    liveTimers: () => liveTimers,
  };
}

const unavailable = (): AttemptResult<JsonObject> => ({
  outcome: failure(
    new AppError('UPSTREAM_ERROR', 'exaUpstream', { provider: 'exa', http_status: 503 }),
    'en',
  ),
  retry: true,
});

test('Retry counts, capped exponential waits and one compact attempt history match the shared budget', async () => {
  for (const retries of [0, 2, 7]) {
    const time = controlled();
    const record: JsonObject = {};
    let calls = 0;
    const outcome = await executeRequest(
      async (context) => {
        calls++;
        context.httpStatus = 503;
        context.requestId = `id-${calls}`;
        time.advance(100);
        const result = unavailable();
        result.outcome.result.error!.details!.request_id = context.requestId;
        return result;
      },
      {
        provider: 'exa',
        requestLimit: 30,
        timeout: 300,
        retries,
        signal: new AbortController().signal,
        language: 'en',
        record,
        clock: time.clock,
      },
    );
    assert.equal(calls, retries + 1);
    assert.deepEqual(time.waits, [1000, 2000, 4000, 8000, 10000, 10000, 10000].slice(0, retries));
    assert.equal(outcome.exitCode, 4);
    const attempts = record.attempts as JsonObject[];
    assert.equal(attempts.at(-1)?.request_id, undefined);
    if (retries) assert.equal(attempts[0].request_id, 'id-1');
    assert.ok(
      attempts.every(
        (entry) => !('attempt' in entry) && !('status' in entry) && !('provider' in entry),
      ),
    );
    assert.equal(record.elapsed_ms, calls * 100 + time.waits.reduce((a, b) => a + b, 0));
    assert.equal(time.liveTimers(), 0);
  }
});

test('Retry-After accepts integer seconds and HTTP dates, rejecting non-HTTP syntax', () => {
  const now = Date.UTC(2026, 8, 30);
  for (const [value, expected] of [
    ['0', 0],
    ['60', 60],
    ['Wed, 30 Sep 2026 00:00:05 GMT', 5],
    ['Tuesday, 29-Sep-26 00:00:00 GMT', 0],
    ['Wed Sep 30 00:00:05 2026', 5],
  ] as const)
    assert.equal(retryAfterSeconds(value, now), expected);
  for (const value of [
    '-1',
    '1.2',
    'tomorrow',
    '2026-09-30',
    '1, 2',
    '',
    'Infinity',
    'Wed, 30 Sep 2026 25:00:00 GMT',
  ]) {
    assert.equal(retryAfterSeconds(value, now), undefined, value);
  }
});

test('Retry-After replaces backoff, invalid headers are explicit, and unfit waits preserve the service error', async () => {
  for (const [header, expected] of [
    [undefined, 1000],
    ['0', 0],
    ['3', 3000],
    ['Wed, 30 Sep 2026 00:00:02 GMT', 2000],
    ['-1', 1000],
  ] as const) {
    const time = controlled();
    const record: JsonObject = {};
    let calls = 0;
    const outcome = await executeRequest(
      async () =>
        ++calls === 1
          ? { ...unavailable(), retryAfter: header }
          : { outcome: success({}), retry: false },
      {
        provider: 'exa',
        requestLimit: 30,
        timeout: 10,
        retries: 2,
        signal: new AbortController().signal,
        language: 'en',
        record,
        clock: time.clock,
      },
    );
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(time.waits, [expected]);
    const entry = (record.attempts as JsonObject[])[0];
    assert.equal(entry.retry_after_invalid, header === '-1' ? true : undefined);
    assert.equal(entry.wait_ms, expected);
  }
  for (const header of ['5', '60']) {
    const time = controlled();
    const record: JsonObject = {};
    const outcome = await executeRequest(async () => ({ ...unavailable(), retryAfter: header }), {
      provider: 'exa',
      requestLimit: 30,
      timeout: 5,
      retries: 2,
      signal: new AbortController().signal,
      language: 'en',
      record,
      clock: time.clock,
    });
    assert.equal(outcome.result.error?.code, 'UPSTREAM_ERROR');
    assert.equal(outcome.result.error?.details?.reason, 'retry_wait_exceeds_budget');
    assert.equal(outcome.result.error?.details?.retry_after_seconds, Number(header));
    assert.deepEqual(time.waits, []);
    assert.equal((record.attempts as JsonObject[]).length, 1);
  }
});

test('Single attempts cap at 30 seconds and retries consume the remaining total budget', async () => {
  const time = controlled();
  const record: JsonObject = {};
  const outcome = await executeRequest(
    async () => {
      time.advance(30_000);
      return { outcome: success({}), retry: false };
    },
    {
      provider: 'exa',
      requestLimit: 30,
      timeout: 35,
      retries: 2,
      signal: new AbortController().signal,
      language: 'en',
      record,
      clock: time.clock,
    },
  );
  assert.deepEqual(time.deadlines, [30_000, 4000]);
  assert.deepEqual(time.waits, [1000]);
  assert.equal(outcome.result.error?.details?.timeout_scope, 'total');
  assert.equal(time.liveTimers(), 0);
  const shorter = controlled();
  const result = await executeRequest(
    async () => {
      shorter.advance(500);
      return { outcome: success({}), retry: false };
    },
    {
      provider: 'exa',
      requestLimit: 30,
      timeout: 0.5,
      retries: 2,
      signal: new AbortController().signal,
      language: 'en',
      record: {},
      clock: shorter.clock,
    },
  );
  assert.equal(result.result.error?.details?.timeout_scope, 'total');
  assert.deepEqual(shorter.deadlines, [500]);
});

test('Stream progress replaces the total deadline with a resettable idle window', async () => {
  const time = controlled();
  const result = await executeRequest(
    async (context) => {
      time.advance(900);
      context.markStreamProgress!();
      time.advance(900);
      context.markStreamProgress!();
      time.advance(900);
      return { outcome: success({}), retry: false };
    },
    {
      provider: 'model',
      requestLimit: Infinity,
      timeout: 1,
      retries: 0,
      signal: new AbortController().signal,
      language: 'en',
      record: {},
      clock: time.clock,
    },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(time.deadlines, [1000, 1000, 1000]);
  assert.equal(time.liveTimers(), 0);
});

test('Late stream content and completion cannot escape expired deadlines before the timer callback', async () => {
  for (const phase of ['first', 'progress', 'completion']) {
    const time = controlled();
    let calls = 0;
    const result = await executeRequest(
      async (context) => {
        calls++;
        if (phase !== 'first') {
          time.advance(500);
          context.markStreamProgress!();
        }
        time.advance(1000);
        if (phase !== 'completion') context.markStreamProgress!();
        return { outcome: success({}), retry: false };
      },
      {
        provider: 'model',
        requestLimit: Infinity,
        timeout: 1,
        retries: 2,
        signal: new AbortController().signal,
        language: 'en',
        record: {},
        clock: time.clock,
      },
    );
    assert.equal(result.result.error?.code, 'TIMEOUT');
    assert.equal(
      result.result.error?.details?.timeout_scope,
      phase === 'first' ? 'total' : 'stream_idle',
    );
    assert.equal(calls, 1);
    assert.equal(result.result.data, undefined);
    assert.equal(time.liveTimers(), 0);
  }
});

test('A late wait callback cannot start another request and cancellation records the actual wait', async () => {
  for (const cancel of [false, true]) {
    const time = controlled();
    const abort = new AbortController();
    const record: JsonObject = {};
    let calls = 0;
    time.clock.sleep = async () => {
      time.advance(cancel ? 250 : 5000);
      if (cancel) abort.abort();
    };
    const result = await executeRequest(
      async () => {
        calls++;
        return unavailable();
      },
      {
        provider: 'exa',
        requestLimit: 30,
        timeout: 5,
        retries: 2,
        signal: abort.signal,
        language: 'en',
        record,
        clock: time.clock,
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.result.error?.code, cancel ? 'CANCELLED' : 'TIMEOUT');
    assert.equal((record.attempts as JsonObject[])[0].wait_ms, cancel ? 250 : 5000);
  }
});

test('Fatal failures and programming exceptions terminate attempts immediately', async () => {
  for (const throws of [false, true]) {
    const time = controlled();
    let calls = 0;
    const result = await executeRequest(
      async () => {
        calls++;
        if (throws) throw new TypeError('private');
        return {
          outcome: failure(new AppError('AUTHENTICATION_ERROR', 'exaAuth'), 'en'),
          retry: false,
        };
      },
      {
        provider: 'exa',
        requestLimit: 30,
        timeout: 300,
        retries: 10,
        signal: new AbortController().signal,
        language: 'en',
        record: {},
        clock: time.clock,
      },
    );
    assert.equal(result.exitCode, throws ? 5 : 3);
    assert.equal(calls, 1);
    assert.deepEqual(time.waits, []);
    assert.equal(time.liveTimers(), 0);
  }
});

test('Attempt observer failures release the request timer and abort listener', async () => {
  const time = controlled();
  const abort = new AbortController();
  let calls = 0;
  const result = await executeRequest(
    async () => {
      calls++;
      return { outcome: success({}), retry: false };
    },
    {
      provider: 'model',
      timeout: 10,
      requestLimit: 10,
      retries: 2,
      signal: abort.signal,
      language: 'en',
      record: {},
      clock: time.clock,
      onAttempt() {
        throw new Error('observer failure');
      },
    },
  );
  assert.equal(result.exitCode, 5);
  assert.equal(calls, 0);
  assert.equal(time.liveTimers(), 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('Verbose retry success has no duplicate provider, count or final request ID', async () => {
  const time = controlled();
  const record: JsonObject = {};
  let calls = 0;
  const result = await executeRequest(
    async (context) => {
      calls++;
      context.httpStatus = calls === 1 ? 503 : 200;
      if (calls === 2) context.requestId = 'req-example-success';
      time.advance(calls === 1 ? 100 : 150);
      return calls === 1
        ? unavailable()
        : { outcome: success({ provider: 'exa', results: [] }), retry: false };
    },
    {
      provider: 'exa',
      requestLimit: 30,
      timeout: 300,
      retries: 2,
      signal: new AbortController().signal,
      language: 'zh',
      record,
      clock: time.clock,
    },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(record, {
    elapsed_ms: 1250,
    attempts: [
      {
        duration_ms: 100,
        http_status: 503,
        code: 'UPSTREAM_ERROR',
        wait_ms: 1000,
        wait_source: 'backoff',
      },
      { duration_ms: 150, http_status: 200, request_id: 'req-example-success' },
    ],
  });
  assert.match(
    renderExecution(record, 'zh'),
    /尝试 2：HTTP 200，150 ms，成功，请求 ID：req-example-success/,
  );
});

test('Native fetch aborts both pending headers and a stalled body within a fractional total budget', async (t) => {
  let sendHeaders = false;
  let calls = 0;
  const instance = createServer((_req, res) => {
    calls++;
    if (sendHeaders) {
      res.writeHead(200);
      res.write('{"results":[');
    }
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => {
    instance.closeAllConnections();
    instance.close();
  });
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  const request = prepareSearch(
    'q',
    {},
    {},
    {
      UNISEARCH_EXA_API_KEY: 'fixture',
      UNISEARCH_EXA_BASE_URL: `http://127.0.0.1:${address.port}`,
    },
    'en',
  );
  for (sendHeaders of [false, true]) {
    const start = performance.now();
    const record: JsonObject = {};
    const result = await executeRequest((context) => requestSearch(request, context, 'en'), {
      provider: 'exa',
      requestLimit: 30,
      timeout: 0.15,
      retries: 2,
      signal: new AbortController().signal,
      language: 'en',
      record,
    });
    assert.equal(result.result.error?.code, 'TIMEOUT');
    assert.equal(result.result.error?.details?.timeout_scope, 'total');
    assert.equal((record.attempts as JsonObject[]).length, 1);
    assert.ok(performance.now() - start < 2000);
  }
  assert.equal(calls, 2);
});

test('A known non-retryable HTTP error cannot become retryable because its body times out', async () => {
  const time = controlled();
  let calls = 0;
  const result = await executeRequest(
    async (context) => {
      calls++;
      context.httpStatus = 401;
      context.retryAllowed = false;
      time.advance(30_000);
      throw new DOMException('aborted', 'AbortError');
    },
    {
      provider: 'exa',
      requestLimit: 30,
      timeout: 300,
      retries: 2,
      signal: new AbortController().signal,
      language: 'en',
      record: {},
      clock: time.clock,
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.result.error?.code, 'TIMEOUT');
  assert.equal(result.result.error?.details?.http_status, 401);
});

test('Huge finite budgets do not overflow timers or turn into immediate cancellation', async () => {
  const result = await executeRequest(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { outcome: success({}), retry: false };
    },
    {
      provider: 'model',
      requestLimit: Infinity,
      timeout: Number.MAX_VALUE,
      retries: 0,
      signal: new AbortController().signal,
      language: 'en',
      record: {},
    },
  );
  assert.equal(result.exitCode, 0);
});

test(
  'SIGINT in request, body or retry wait returns 130, preserves old files and removes listeners',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = temporary(t);
    const path = join(root, 'config.json');
    const output = join(root, 'old.json');
    writeFileSync(path, '{}');
    for (const mode of ['request', 'body', 'wait']) {
      writeFileSync(output, 'old');
      let requests = 0;
      let child: ReturnType<typeof spawn>;
      let timer: NodeJS.Timeout;
      const instance = createServer((_req, res) => {
        requests++;
        if (mode === 'body') {
          res.writeHead(200);
          res.write('{"results":[');
        }
        if (mode === 'wait') {
          res.writeHead(503, { 'Retry-After': '10' });
          res.end('{}');
        }
        timer = setTimeout(() => child.kill('SIGINT'), 100);
      });
      instance.listen(0, '127.0.0.1');
      await once(instance, 'listening');
      const address = instance.address();
      assert.ok(address && typeof address !== 'string');
      const environment: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(environment))
        if (key.startsWith('UNISEARCH_')) delete environment[key];
      Object.assign(environment, {
        UNISEARCH_CONFIG_PATH: path,
        UNISEARCH_EXA_API_KEY: 'fixture',
        UNISEARCH_EXA_BASE_URL: `http://127.0.0.1:${address.port}`,
        UNISEARCH_LANG: 'en',
      });
      child = spawn(
        process.execPath,
        [
          resolve('dist/cli.js'),
          'exa',
          'search',
          'q',
          '--format=json',
          '--verbose',
          '--output',
          output,
        ],
        { env: environment },
      );
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (value) => {
        stdout += value;
      });
      child.stderr!.on('data', (value) => {
        stderr += value;
      });
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        const [code, signal] = await once(child, 'close');
        assert.equal(code, 130, stderr);
        assert.equal(signal, null);
        assert.equal(JSON.parse(stdout).error.code, 'CANCELLED');
        assert.equal(JSON.parse(stdout).data, undefined);
        if (mode === 'wait') assert.ok(JSON.parse(stdout).meta.attempts[0].wait_ms > 0);
        assert.equal(requests, 1);
        assert.equal(readFileSync(output, 'utf8'), 'old');
        assert.deepEqual(readdirSync(root).sort(), ['config.json', 'old.json']);
      } finally {
        clearTimeout(watchdog);
        clearTimeout(timer!);
        instance.closeAllConnections();
        await new Promise<void>((resolve) => instance.close(() => resolve()));
      }
    }
    const count = process.listenerCount('SIGINT');
    const config = context(root, {
      UNISEARCH_CONFIG_PATH: path,
      UNISEARCH_EXA_API_KEY: 'fixture',
      UNISEARCH_EXA_BASE_URL: 'http://127.0.0.1:1',
      UNISEARCH_LANG: 'en',
      UNISEARCH_RETRIES: '0',
    });
    await createCli('test', { config, channels: capture() }).run(['exa', 'search', 'q']);
    assert.equal(process.listenerCount('SIGINT'), count);
  },
);
