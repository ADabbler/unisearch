import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { AppError } from '../src/errors.js';
import { fieldAt, parseInput } from '../src/config/fields.js';
import { localStatus } from '../src/config/status.js';
import { modelSearch, prepareModel } from '../src/providers/model-config.js';
import { chatAnswer, responseAnswer, streamAnswer } from '../src/providers/model-response.js';
import { modelBody, requestModel, searchInstructions } from '../src/providers/model.js';
import { combinedSearch, prepareCombinedSearch } from '../src/search.js';
import type { ExecutionClock } from '../src/execution.js';
import type { JsonObject } from '../src/result.js';

const modelEnv: NodeJS.ProcessEnv = {
  UNISEARCH_MODEL_BASE_URL: 'https://fixture.example/prefix/',
  UNISEARCH_MODEL_API_KEY: 'fixture-model-key',
  UNISEARCH_MODEL_ID: 'primary',
};
const response = (text = 'Complete answer.'): JsonObject => ({
  model: 'reported-model',
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    },
  ],
});
const chat = (content = 'Complete answer.'): JsonObject => ({
  model: 'reported-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
});
const prepare = (values = {}, options = {}, env = modelEnv) =>
  prepareModel(' q ', options, values, env, 'en');
const rejects = (fn: () => unknown, code = 'INVALID_CONFIG') =>
  assert.throws(fn, (error) => error instanceof AppError && error.code === code);

test('model connection requires explicit ID, address and key, supports independent environment fields and both protocols', () => {
  for (const field of [
    'UNISEARCH_MODEL_ID',
    'UNISEARCH_MODEL_BASE_URL',
    'UNISEARCH_MODEL_API_KEY',
  ]) {
    const env = { ...modelEnv };
    delete env[field];
    rejects(() => prepare({}, {}, env), 'MISSING_CONFIG');
  }
  const initial = prepare();
  assert.equal(initial.url, 'https://fixture.example/prefix/responses');
  assert.deepEqual(initial.tools, []);
  assert.equal(modelBody(initial, initial.candidates[0], searchInstructions).tools, undefined);
  assert.equal(initial.stream, false);
  assert.equal(initial.timeout, 300);
  assert.equal(initial.retries, 2);
  assert.deepEqual(initial.candidates, [{ id: 'primary' }]);
  const request = prepareModel(
    'q',
    {},
    { providers: { model: { model: { id: 'saved', effort: 'high' } } } },
    { ...modelEnv, UNISEARCH_MODEL_PROTOCOL: 'chat-completions', UNISEARCH_MODEL_STREAM: 'true' },
    'en',
  );
  assert.equal(request.url, 'https://fixture.example/prefix/chat/completions');
  assert.deepEqual(request.candidates, [{ id: 'primary', effort: 'high' }]);
  assert.equal(request.stream, true);
  rejects(() => prepare({ providers: { model: { protocol: 'guess' } } }));
});

test('tools mechanically expand strings, preserve objects and order, replace defaults and reject complete duplicates', () => {
  const tools = [
    'arbitrary_hosted',
    { type: 'code_interpreter', container: { type: 'auto' } },
    { type: 'web_search', filters: { allowed_domains: ['example.org'] } },
  ];
  assert.deepEqual(prepare({ providers: { model: { tools } } }).tools, [
    { type: 'arbitrary_hosted' },
    ...tools.slice(1),
  ]);
  assert.deepEqual(prepare({ providers: { model: { tools: [] } } }).tools, []);
  for (const tools of [
    null,
    {},
    [''],
    ['two words'],
    [{ name: 'web_search' }],
    [false],
    ['x_search', { type: 'x_search' }],
    [
      { type: 't', a: 1 },
      { a: 1, type: 't' },
    ],
  ])
    rejects(() => prepare({ providers: { model: { tools } } }));
  assert.deepEqual(parseInput(fieldAt('providers.model.tools'), '["web_search"]'), ['web_search']);
  assert.equal(parseInput(fieldAt('providers.model.model.effort'), 'none'), 'none');
});

test('candidate identity includes each effort and forbids saved duplicates including omitted/default', () => {
  const values = {
    providers: {
      model: {
        model: { id: 'same', effort: 'high' },
        fallback_models: [{ id: 'same', effort: 'low' }, { id: 'other' }],
      },
    },
  };
  const env = {
    UNISEARCH_MODEL_API_KEY: 'fixture',
    UNISEARCH_MODEL_BASE_URL: 'https://fixture.example',
  };
  assert.deepEqual(prepare(values, {}, env).candidates, [
    { id: 'same', effort: 'high' },
    { id: 'same', effort: 'low' },
    { id: 'other' },
  ]);
  for (const fallback_models of [
    [{ id: 'same', effort: 'high' }],
    [{ id: 'x' }, { id: 'x', effort: 'default' }],
  ])
    rejects(() =>
      prepare({ providers: { model: { ...values.providers.model, fallback_models } } }),
    );
  rejects(() =>
    prepare({
      providers: {
        model: { model: { id: 'x' }, fallback_models: [{ id: 'x', effort: 'default' }] },
      },
    }),
  );
  for (const fallback_models of [
    [{ id: 'x', reasoning_effort: 'high' }],
    ['x'],
    [{ id: '' }],
    [{ id: 'x', effort: ' ' }],
  ])
    rejects(() => prepare({ providers: { model: { fallback_models } } }));
  assert.deepEqual(
    prepare({
      providers: { model: { model: { id: 'saved' }, fallback_models: [{ id: 'primary' }] } },
    }).candidates,
    [{ id: 'primary' }],
  );
});

test('CLI selection uses first matching saved effort, independent backups and explicit overrides without parsing parentheses', () => {
  const values = {
    providers: {
      model: {
        model: { id: 'primary', effort: 'high' },
        fallback_models: [
          { id: 'backup', effort: 'low' },
          { id: 'backup', effort: 'high' },
        ],
      },
    },
  };
  assert.deepEqual(prepare(values, { model: 'backup' }).candidates, [
    { id: 'backup', effort: 'low' },
  ]);
  assert.deepEqual(prepare(values, { model: 'backup', effort: 'none' }).candidates, [
    { id: 'backup', effort: 'none' },
  ]);
  assert.deepEqual(prepare(values, { model: 'new(high)' }).candidates, [{ id: 'new(high)' }]);
  assert.deepEqual(prepare(values, { effort: 'default' }).candidates, [
    { id: 'primary' },
    ...values.providers.model.fallback_models,
  ]);
  assert.deepEqual(prepare(values, { fallback: false }).candidates, [
    { id: 'primary', effort: 'high' },
  ]);
  rejects(() => prepare(values, { effort: ' ' }), 'INVALID_ARGUMENT');
  rejects(() => prepare(values, { model: '' }), 'INVALID_ARGUMENT');
});

test('selection validates only visited IDs and selected effort, but never skips malformed visited structures', () => {
  const make = (fallback_models: unknown) => ({
    providers: { model: { model: { id: 'primary', effort: 42 }, fallback_models } },
  });
  const saved = make([{ id: 'unmatched', effort: false }, { id: 'chosen', effort: 'high' }, null]);
  assert.deepEqual(prepare(saved, { model: 'chosen' }).candidates, [
    { id: 'chosen', effort: 'high' },
  ]);
  rejects(() => prepare(make([null, { id: 'chosen' }]), { model: 'chosen' }));
  rejects(() => prepare(make(null), { model: 'chosen' }));
  rejects(() => prepare(make([{ id: 42 }, { id: 'chosen' }]), { model: 'chosen' }));
  rejects(() => prepare(make([{ id: 'chosen', effort: false }]), { model: 'chosen' }));
  assert.deepEqual(
    prepare(
      { providers: { model: { model: 42, fallback_models: false } } },
      { model: 'chosen', effort: 'low' },
    ).candidates,
    [{ id: 'chosen', effort: 'low' }],
  );
  assert.deepEqual(prepare(make(false), { effort: 'none', fallback: false }).candidates, [
    { id: 'primary', effort: 'none' },
  ]);
  rejects(() => prepare({ providers: { model: { model: { id: 'primary', unknown: true } } } }));
});

test('model status validates all candidates and optional effort, exposing four local states without keys', () => {
  for (const [values, env, state] of [
    [{}, {}, 'missing'],
    [{}, modelEnv, 'ready'],
    [{ providers: { model: { enabled: false } } }, {}, 'disabled'],
    [{ providers: { model: { model: { effort: 42 } } } }, modelEnv, 'invalid'],
    [{ providers: { model: { fallback_models: [{ id: '' }] } } }, modelEnv, 'invalid'],
  ] as const) {
    const result = localStatus(values, env, 'en', [modelSearch]);
    assert.equal(result.services[0].state, state);
    assert.doesNotMatch(JSON.stringify(result), /fixture-model-key/);
  }
});

test('request bodies match protocol fixtures and the exact search prompt', () => {
  const instructions = readFileSync('tests/fixtures/contracts/model-prompt.txt', 'utf8').trimEnd();
  assert.equal(searchInstructions, instructions);
  const prompt = `${instructions}\n\nCurrent UTC time: 2026-09-30T00:00:00.000Z`;
  const examples = JSON.parse(readFileSync('tests/fixtures/contracts/model-requests.json', 'utf8'));
  assert.equal(examples.length, 3);
  for (const example of examples) {
    const protocol = example.messages ? 'chat-completions' : 'responses';
    const candidate = {
      id: example.model,
      ...(example.reasoning ? { effort: example.reasoning.effort } : {}),
    };
    const request = {
      ...prepare(),
      protocol: protocol as 'responses' | 'chat-completions',
      tools: example.tools ?? [],
      query: 'UniSearch documentation',
    };
    assert.deepEqual(modelBody(request, candidate, prompt), example);
  }
  for (const protocol of ['responses', 'chat-completions'] as const) {
    const request = { ...prepare(), protocol, stream: true };
    const body = modelBody(request, { id: 'primary(high)', effort: 'none' }, prompt);
    assert.equal(body.model, 'primary(high)');
    assert.equal(body.stream, true);
    assert.deepEqual(
      protocol === 'responses' ? body.reasoning : body.reasoning_effort,
      protocol === 'responses' ? { effort: 'none' } : 'none',
    );
  }
});

test('both response protocols preserve complete text, actual model and structured citations only', () => {
  const content = '  # Heading\n```ts\nconst x = 1;\n```\n[link](https://example.org/plain) ';
  assert.deepEqual(responseAnswer(response(content)), { model: 'reported-model', text: content });
  assert.deepEqual(chatAnswer(chat(content)), { model: 'reported-model', text: content });
  const annotations = [
    { type: 'url_citation', url: 'https://example.org/a', title: 'A' },
    { type: 'url_citation', url: 'https://example.org/a', title: 'duplicate' },
    { type: 'url_citation', url: 'https://example.org/a#part', title: null },
    { type: 'file_citation', file_id: 'f' },
  ];
  const body = response() as any;
  body.output[0].content[0].annotations = annotations;
  body.output.push({ type: 'reasoning' }, { type: 'web_search_call' });
  body.output[0].content.push({ type: 'output_text', text: 'Second part' });
  assert.deepEqual(responseAnswer(body), {
    model: 'reported-model',
    text: 'Complete answer.\n\nSecond part',
    sources: [{ url: 'https://example.org/a', title: 'A' }, { url: 'https://example.org/a#part' }],
  });
  const chatBody = chat() as any;
  chatBody.choices[0].message.annotations = annotations.map((annotation) => ({
    type: annotation.type,
    url_citation: annotation,
  }));
  assert.deepEqual(chatAnswer(chatBody).sources, responseAnswer(body).sources);
  for (const citation of [
    { url: 'ftp://example.org' },
    { url: 'https://example.org', title: 42 },
    { title: 'missing' },
  ]) {
    body.output[0].content[0].annotations = [{ type: 'url_citation', ...citation }];
    rejects(() => responseAnswer(body), 'INVALID_RESPONSE');
  }
});

test('malformed, incomplete, refused and client-tool responses never return partial text', () => {
  for (const body of [
    {},
    { ...response(), model: '' },
    { ...response(), output: [] },
    { ...response(), output_text: 'SDK shortcut', output: [] },
    {
      ...response(),
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 42 }] },
      ],
    },
  ])
    rejects(() => responseAnswer(body), 'INVALID_RESPONSE');
  for (const status of ['incomplete', 'failed', 'in_progress'])
    rejects(() => responseAnswer({ ...response(), status }), 'UPSTREAM_ERROR');
  for (const type of ['function_call', 'custom_tool_call', 'computer_call', 'mcp_approval_request'])
    rejects(
      () =>
        responseAnswer({
          ...response(),
          output: [...(response().output as JsonObject[]), { type }],
        }),
      'UPSTREAM_ERROR',
    );
  for (const reason of ['length', 'content_filter', 'tool_calls']) {
    const body = chat() as any;
    body.choices[0].finish_reason = reason;
    rejects(() => chatAnswer(body), 'UPSTREAM_ERROR');
  }
  const refused = chat() as any;
  refused.choices[0].message = { content: null, refusal: 'No.' };
  rejects(() => chatAnswer(refused), 'UPSTREAM_ERROR');
  refused.choices[0].message.content = 'I cannot verify this.';
  assert.equal(chatAnswer(refused).text, 'I cannot verify this.');
  const duplicated = chat() as any;
  duplicated.choices.push(duplicated.choices[0]);
  rejects(() => chatAnswer(duplicated), 'INVALID_RESPONSE');
});

function byteStream(content: string | Uint8Array, chunkSize = 1, close = true) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize));
      if (close) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
test('Responses SSE decodes fragmented UTF-8, CRLF, multiline data and ignores deltas in favor of final response', async () => {
  const stream = byteStream(
    ': heartbeat\r\n\r\n' +
      event({ type: 'response.output_text.delta', delta: 'must not repeat' }) +
      `event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":${JSON.stringify(response('中文🙂'))}}\r\n\r\n`,
    1,
    false,
  );
  assert.deepEqual(await streamAnswer(stream.stream, 'responses'), {
    model: 'reported-model',
    text: '中文🙂',
  });
  assert.equal(stream.cancelled(), true);
});
test('Chat SSE requires stop plus DONE, closes without EOF and uses only index zero', async () => {
  const chunk = (delta: unknown, finish_reason: unknown = null) => ({
    model: 'actual',
    choices: [{ index: 0, delta, finish_reason }],
  });
  const source =
    event(chunk({ content: '中文' })) +
    event(chunk({ content: ' answer' }, 'stop')) +
    event({ choices: [], usage: {} }) +
    'data: [DONE]\n\n';
  const stream = byteStream(source, 7, false);
  assert.deepEqual(await streamAnswer(stream.stream, 'chat-completions'), {
    model: 'actual',
    text: '中文 answer',
  });
  assert.equal(stream.cancelled(), true);
  for (const text of [
    'data: [DONE]\n\n',
    event(chunk({ content: 'partial' })),
    event(chunk({ content: 'partial' }, 'stop')),
    'data: nope\n\n',
    event({ choices: 'bad' }),
  ])
    await assert.rejects(streamAnswer(byteStream(text).stream, 'chat-completions'), {
      code: 'INVALID_RESPONSE',
    });
  await assert.rejects(
    streamAnswer(
      byteStream(event(chunk({ content: 'partial' }, 'length'))).stream,
      'chat-completions',
    ),
    { code: 'UPSTREAM_ERROR' },
  );
});
test('SSE malformed encoding, reserved fields and error terminals are explicit failures', async () => {
  for (const source of [
    'data: {bad}\n\n',
    event({ type: 'response.output_text.delta', delta: 42 }),
    event({ type: 'response.completed', response: {} }),
    event({ type: 42 }),
    new Uint8Array([100, 97, 116, 97, 58, 32, 0xff, 10, 10]),
  ])
    await assert.rejects(streamAnswer(byteStream(source).stream, 'responses'), {
      code: 'INVALID_RESPONSE',
    });
  for (const type of ['response.failed', 'response.incomplete', 'error'])
    await assert.rejects(streamAnswer(byteStream(event({ type })).stream, 'responses'), {
      code: 'UPSTREAM_ERROR',
    });
});

test('HTTP error classification uses structured facts, never infers model scope from generic status or prose', async () => {
  const cases = [
    [401, {}, 'AUTHENTICATION_ERROR', false, undefined],
    [403, {}, 'ACCESS_DENIED', false, undefined],
    [429, { code: 'insufficient_quota' }, 'QUOTA_EXCEEDED', false, undefined],
    [404, { code: 'model_not_found' }, 'MODEL_UNAVAILABLE', false, 'model'],
    [404, { message: 'model not found' }, 'UPSTREAM_ERROR', false, undefined],
    [429, {}, 'RATE_LIMITED', true, undefined],
    [429, { param: 'model' }, 'RATE_LIMITED', true, 'model'],
    [503, {}, 'UPSTREAM_ERROR', true, undefined],
    [503, { param: 'model' }, 'UPSTREAM_ERROR', true, 'model'],
    [400, {}, 'INVALID_ARGUMENT', false, undefined],
    [
      422,
      { code: 'unsupported_value', param: 'reasoning.effort' },
      'INVALID_ARGUMENT',
      false,
      'candidate',
    ],
    [408, {}, 'TIMEOUT', true, undefined],
    [504, {}, 'TIMEOUT', true, undefined],
    [302, {}, 'UPSTREAM_ERROR', false, undefined],
  ] as const;
  for (const [status, error, code, retry, fallback] of cases) {
    const result = await requestModel(
      prepare(),
      { id: 'primary' },
      'prompt',
      { signal: new AbortController().signal },
      'en',
      async () => Response.json({ error }, { status }),
    );
    assert.equal(result.outcome.result.error?.code, code, `${status}`);
    assert.equal(result.retry, retry);
    assert.equal(result.fallback, fallback);
  }
});

function controlledClock() {
  let now = 0;
  let live = 0;
  const timers = new Set<{ due: number; callback: () => void }>();
  const caps: number[] = [];
  const waits: number[] = [];
  const clock: ExecutionClock = {
    now: () => now,
    wallNow: () => Date.UTC(2026, 8, 30) + now,
    async sleep(ms, signal) {
      signal.throwIfAborted();
      waits.push(ms);
      now += ms;
    },
    schedule(ms, callback) {
      caps.push(ms);
      live++;
      const timer = { due: now + ms, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
        live--;
      };
    },
  };
  return {
    clock,
    caps,
    waits,
    advance(ms: number) {
      now += ms;
    },
    elapse(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a.due - b.due)[0];
        if (!next || next.due > target) break;
        now = next.due;
        timers.delete(next);
        next.callback();
      }
      now = target;
    },
    live: () => live,
  };
}

function timedModelStream(
  time: ReturnType<typeof controlledClock>,
  signal: AbortSignal,
  frames: [number, string | Error | (() => void)][],
): Response {
  let abort!: () => void;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        abort = () => controller.error(new DOMException('aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
      },
      async pull(controller) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const frame = frames.shift();
        if (!frame) {
          signal.removeEventListener('abort', abort);
          controller.close();
          return;
        }
        time.elapse(frame[0]);
        if (signal.aborted) return;
        if (typeof frame[1] === 'function') frame[1]();
        else if (frame[1] instanceof Error) {
          signal.removeEventListener('abort', abort);
          controller.error(frame[1]);
        } else controller.enqueue(new TextEncoder().encode(frame[1]));
      },
      cancel() {
        signal.removeEventListener('abort', abort);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

function textDelta(protocol: 'responses' | 'chat-completions', text: string): string {
  if (protocol === 'responses') return event({ type: 'response.output_text.delta', delta: text });
  return event({ model: 'reported-model', choices: [{ index: 0, delta: { content: text } }] });
}

function streamComplete(protocol: 'responses' | 'chat-completions'): string {
  if (protocol === 'responses') return event({ type: 'response.completed', response: response() });
  return event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
}

test('both model protocols accept CR and fragmented CRLF and require complete SSE events', async () => {
  for (const protocol of ['responses', 'chat-completions'] as const)
    for (const ending of ['\r', '\r\n']) {
      const source = (
        textDelta(protocol, 'Complete answer.') + streamComplete(protocol)
      ).replaceAll('\n', ending);
      const { stream } = byteStream(source);
      let progress = 0;
      assert.deepEqual(await streamAnswer(stream, protocol, () => progress++), {
        model: 'reported-model',
        text: 'Complete answer.',
      });
      assert.equal(progress, 1);
      assert.equal(stream.locked, false);
      await assert.rejects(
        streamAnswer(byteStream(source.slice(0, -ending.length)).stream, protocol),
        { code: 'INVALID_RESPONSE' },
      );
    }
});

test('streaming models can complete beyond twice the timeout while supplements retain their original deadline', async () => {
  for (const protocol of ['responses', 'chat-completions'] as const)
    for (const supplement of ['completed', 'pending']) {
      const time = controlledClock();
      const abort = new AbortController();
      let modelSignal!: AbortSignal;
      let modelCalls = 0;
      let extraCalls = 0;
      const plan = prepareCombinedSearch(
        'q',
        { stream: true, timeout: 1, extraSources: 'exa' },
        { providers: { model: { protocol } } },
        { ...modelEnv, UNISEARCH_EXA_API_KEY: 'fixture-exa-key' },
        'en',
      );
      const result = await combinedSearch(
        plan,
        abort.signal,
        'en',
        {},
        {
          clock: time.clock,
          transport: async (url, init) => {
            const signal = init!.signal!;
            if (String(url).endsWith('/search')) {
              extraCalls++;
              if (supplement === 'completed') return Response.json({ results: [] });
              return new Promise<Response>((_resolve, reject) => {
                signal.addEventListener(
                  'abort',
                  () => reject(new DOMException('aborted', 'AbortError')),
                  { once: true },
                );
              });
            }
            modelCalls++;
            modelSignal = signal;
            return timedModelStream(time, signal, [
              [900, textDelta(protocol, 'Complete ')],
              [900, textDelta(protocol, 'answer.')],
              [900, streamComplete(protocol)],
            ]);
          },
        },
      );
      assert.equal(time.clock.now(), 2700);
      assert.equal(result.exitCode, supplement === 'completed' ? 0 : 6);
      assert.equal(result.result.data?.answer?.text, 'Complete answer.');
      if (supplement === 'completed') {
        assert.deepEqual(result.result.data?.extra_sources, [
          { provider: 'exa', data: { results: [] } },
        ]);
      } else {
        const failures = result.result.error?.details?.failures as JsonObject[];
        assert.equal(failures.length, 1);
        assert.equal(failures[0].provider, 'exa');
        assert.equal(failures[0].code, 'TIMEOUT');
        assert.equal((failures[0].details as JsonObject).timeout_scope, 'total');
      }
      assert.equal(modelCalls, 1);
      assert.equal(extraCalls, 1);
      assert.equal(time.live(), 0);
      assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
      assert.equal(getEventListeners(modelSignal, 'abort').length, 0);
    }
});

test('heartbeats and empty model deltas never extend the initial or stream idle timeout', async () => {
  for (const protocol of ['responses', 'chat-completions'] as const)
    for (const started of [false, true]) {
      const time = controlledClock();
      const record: JsonObject = {};
      let calls = 0;
      const plan = prepareCombinedSearch(
        'q',
        { stream: true, timeout: 1 },
        { providers: { model: { protocol, fallback_models: [{ id: 'backup' }] } } },
        modelEnv,
        'en',
      );
      const frames: [number, string][] = started ? [[500, textDelta(protocol, 'partial')]] : [];
      frames.push(
        [400, ': heartbeat\n\n'],
        [
          100,
          protocol === 'responses'
            ? event({ type: 'response.web_search_call.in_progress' })
            : event({
                model: 'reported-model',
                choices: [{ index: 0, delta: { role: 'assistant' } }],
              }),
        ],
        [300, textDelta(protocol, '')],
        [200, streamComplete(protocol)],
      );
      const result = await combinedSearch(plan, new AbortController().signal, 'en', record, {
        clock: time.clock,
        transport: async (_url, init) => {
          calls++;
          return timedModelStream(time, init!.signal!, frames);
        },
      });
      const failures = result.result.error?.details?.failures as JsonObject[];
      assert.equal(failures[0].code, 'TIMEOUT');
      assert.equal(
        (failures[0].details as JsonObject).timeout_scope,
        started ? 'stream_idle' : 'total',
      );
      assert.equal(result.result.data, undefined);
      assert.equal(calls, 1);
      assert.equal(time.live(), 0);
    }
});

test('errors and incomplete streams after model text never retry or fall back', async () => {
  for (const protocol of ['responses', 'chat-completions'] as const)
    for (const fault of [
      'data: {bad}\n\n',
      event({ error: { code: 'model_not_found' } }),
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      }),
      undefined,
    ]) {
      const time = controlledClock();
      let calls = 0;
      const plan = prepareCombinedSearch(
        'q',
        { stream: true },
        { providers: { model: { protocol, fallback_models: [{ id: 'backup' }] } } },
        modelEnv,
        'en',
      );
      const frames: [number, string | Error][] = [[100, textDelta(protocol, 'partial')]];
      if (fault !== undefined) frames.push([100, fault]);
      const result = await combinedSearch(
        plan,
        new AbortController().signal,
        'en',
        {},
        {
          clock: time.clock,
          transport: async (_url, init) => {
            calls++;
            return timedModelStream(time, init!.signal!, frames);
          },
        },
      );
      assert.equal(result.exitCode, 4);
      assert.equal(calls, 1);
      assert.equal(result.result.data, undefined);
      assert.equal(time.live(), 0);
    }
});

test('user cancellation still stops a model stream after its original deadline', async () => {
  const time = controlledClock();
  const abort = new AbortController();
  const plan = prepareCombinedSearch('q', { stream: true, timeout: 1 }, {}, modelEnv, 'en');
  const result = await combinedSearch(
    plan,
    abort.signal,
    'en',
    {},
    {
      clock: time.clock,
      transport: async (_url, init) =>
        timedModelStream(time, init!.signal!, [
          [900, textDelta('responses', 'partial')],
          [200, () => abort.abort()],
        ]),
    },
  );
  assert.equal(time.clock.now(), 1100);
  assert.equal(result.exitCode, 130);
  assert.equal(result.result.error?.code, 'CANCELLED');
  assert.equal(result.result.data, undefined);
  assert.equal(time.live(), 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('same-ID effort fallback uses independent settings, shared prompt/time, no text fragments and concise summaries', async () => {
  const plan = prepareCombinedSearch(
    ' q ',
    {},
    {
      providers: {
        model: {
          model: { id: 'primary', effort: 'high' },
          fallback_models: [
            { id: 'primary', effort: 'low' },
            { id: 'backup', effort: 'medium' },
          ],
        },
      },
    },
    modelEnv,
    'en',
  );
  const bodies: any[] = [];
  const time = controlledClock();
  const record: JsonObject = {};
  const outcome = await combinedSearch(plan, new AbortController().signal, 'en', record, {
    clock: time.clock,
    transport: async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      time.advance(10_000);
      let body = response();
      if (bodies.length === 1) body = response(' ');
      else if (bodies.length === 2) body = { ...response(), status: 'incomplete' };
      return Response.json(body, { headers: { 'x-request-id': `request-${bodies.length}` } });
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(
    bodies.map((body) => [body.model, body.reasoning.effort]),
    [
      ['primary', 'high'],
      ['primary', 'low'],
      ['backup', 'medium'],
    ],
  );
  assert.equal(new Set(bodies.map((body) => body.instructions)).size, 1);
  assert.equal(
    bodies[0].instructions,
    `${searchInstructions}\n\nCurrent UTC time: 2026-09-30T00:00:00.000Z`,
  );
  assert.equal(bodies[0].input[0].content, ' q ');
  assert.deepEqual(time.caps, [300000, 290000, 280000]);
  assert.deepEqual(
    (outcome.result.meta!.model_fallbacks as JsonObject[]).map(({ from, to }) => [from, to]),
    [
      ['primary(high)', 'primary(low)'],
      ['primary(low)', 'backup(medium)'],
    ],
  );
  assert.deepEqual(
    (record.attempts as JsonObject[]).map((entry) => entry.request_id),
    ['request-1', 'request-2', 'request-3'],
  );
  assert.equal(time.live(), 0);
});

test('model-wide unavailability skips other effort for the ID, Retry-After cannot be bypassed through fallback', async () => {
  for (const limited of [false, true])
    for (const retries of [0, 2]) {
      const plan = prepareCombinedSearch(
        'q',
        {},
        {
          execution: { retries },
          providers: {
            model: {
              model: { id: 'primary', effort: 'high' },
              fallback_models: [{ id: 'primary', effort: 'low' }, { id: 'backup' }],
            },
          },
        },
        modelEnv,
        'en',
      );
      const ids: string[] = [];
      const time = controlledClock();
      const result = await combinedSearch(
        plan,
        new AbortController().signal,
        'en',
        {},
        {
          clock: time.clock,
          transport: async (_url, init) => {
            ids.push(JSON.parse(init!.body as string).model);
            if (limited)
              return Response.json(
                { error: { param: 'model' } },
                { status: 429, headers: { 'retry-after': '300' } },
              );
            return ids.length === 1
              ? Response.json({ error: { code: 'model_not_found' } }, { status: 404 })
              : Response.json(response());
          },
        },
      );
      assert.deepEqual(ids, limited ? ['primary'] : ['primary', 'backup']);
      assert.equal(result.exitCode, limited ? 4 : 0);
      if (limited)
        assert.equal(
          result.result.error?.details?.failures?.[0].details?.reason,
          'retry_wait_exceeds_budget',
        );
    }
});

test('model retries preserve settings, per-candidate counts and Exa is never restarted by fallback', async () => {
  for (const retries of [0, 2]) {
    const plan = prepareCombinedSearch(
      'q',
      { extraSources: 'exa' },
      {
        execution: { retries },
        providers: {
          model: {
            model: { id: 'primary', effort: 'high' },
            fallback_models: [{ id: 'backup', effort: 'low' }],
          },
        },
      },
      { ...modelEnv, UNISEARCH_EXA_API_KEY: 'fixture-exa' },
      'en',
    );
    const time = controlledClock();
    const record: JsonObject = {};
    const bodies: any[] = [];
    let exaCalls = 0;
    const outcome = await combinedSearch(plan, new AbortController().signal, 'en', record, {
      clock: time.clock,
      transport: async (url, init) => {
        if (String(url).endsWith('/search')) {
          exaCalls++;
          return Response.json({ results: [] });
        }
        const body = JSON.parse(init!.body as string);
        bodies.push(body);
        return body.model === 'primary'
          ? Response.json(
              { error: { param: 'model', message: 'temporarily unavailable' } },
              { status: 503 },
            )
          : Response.json(response());
      },
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(exaCalls, 1);
    assert.equal(bodies.length, retries + 2);
    for (const body of bodies.slice(0, -1)) assert.deepEqual(body, bodies[0]);
    assert.equal(bodies.at(-1).reasoning.effort, 'low');
    assert.deepEqual(time.waits, retries ? [1000, 2000] : []);
    assert.equal((record.attempts as JsonObject[]).length, retries + 3);
  }
});

test('generic connection failures, policy refusals and unsupported client workflows never cause model fallback', async () => {
  const plan = prepareCombinedSearch(
    'q',
    {},
    { execution: { retries: 0 }, providers: { model: { fallback_models: [{ id: 'backup' }] } } },
    modelEnv,
    'en',
  );
  for (const body of [
    { ...response(), status: 'failed' },
    { ...response(), status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
    { ...response(), output: [{ type: 'function_call' }, ...(response().output as JsonObject[])] },
    { ...response(), error: { code: 'insufficient_quota', message: 'quota' } },
  ]) {
    let calls = 0;
    const outcome = await combinedSearch(
      plan,
      new AbortController().signal,
      'en',
      {},
      {
        transport: async () => {
          calls++;
          return Response.json(body);
        },
      },
    );
    assert.equal(outcome.exitCode, 4);
    assert.equal(calls, 1);
    assert.equal(outcome.result.meta, undefined);
  }
  for (const code of ['ENOTFOUND', 'ECONNRESET']) {
    let calls = 0;
    const outcome = await combinedSearch(
      plan,
      new AbortController().signal,
      'en',
      {},
      {
        transport: async () => {
          calls++;
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('private'), { code }),
          });
        },
      },
    );
    assert.equal(outcome.result.error?.code, 'NETWORK_ERROR');
    assert.equal(calls, 1);
  }
});

test('structured SSE errors retain safe upstream evidence and completed hosted shell output does not demand a local executor', async () => {
  const request = prepare({}, { stream: true });
  for (const [code, expected] of [
    ['model_not_found', 'MODEL_UNAVAILABLE'],
    ['insufficient_quota', 'QUOTA_EXCEEDED'],
    ['unknown', 'UPSTREAM_ERROR'],
  ]) {
    const result = await requestModel(
      request,
      request.candidates[0],
      'prompt',
      { signal: new AbortController().signal },
      'en',
      async () =>
        new Response(
          event({
            type: 'response.failed',
            response: { error: { code, message: 'fixture-model-key details' } },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    assert.equal(result.outcome.result.error?.code, expected);
    assert.doesNotMatch(JSON.stringify(result), /fixture-model-key/);
  }
  const output = [...(response().output as JsonObject[]), { type: 'shell_call', call_id: 'c' }];
  rejects(() => responseAnswer({ ...response(), output }), 'UPSTREAM_ERROR');
  assert.equal(
    responseAnswer({
      ...response(),
      output: [...output, { type: 'shell_call_output', call_id: 'c' }],
    }).text,
    'Complete answer.',
  );
});

test('model attempts can exceed 30 seconds, explicit 600-second budgets remain shared and exhaustion prevents fallback', async () => {
  for (const elapsed of [31000, 599000, 600000]) {
    const time = controlledClock();
    const record: JsonObject = {};
    let calls = 0;
    const plan = prepareCombinedSearch(
      'q',
      { timeout: 600 },
      { providers: { model: { fallback_models: [{ id: 'backup' }] } } },
      modelEnv,
      'en',
    );
    const outcome = await combinedSearch(plan, new AbortController().signal, 'en', record, {
      clock: time.clock,
      transport: async () => {
        calls++;
        time.advance(elapsed);
        return Response.json(response());
      },
    });
    assert.equal(outcome.exitCode, elapsed === 600000 ? 4 : 0);
    assert.deepEqual(time.caps, [600000]);
    assert.equal(calls, 1);
    assert.equal(time.live(), 0);
  }
});

test('invalid model options are reported before missing connection settings', () => {
  for (const options of [{ model: '' }, { model: 'two words' }, { effort: ' ' }]) {
    assert.throws(
      () => prepareModel('q', options, {}, {}, 'en'),
      (error) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGUMENT' &&
        error.details?.option === ('model' in options ? '--model' : '--effort'),
    );
  }
});

test('null Chat tool calls mean no client action, while malformed declarations remain invalid', async () => {
  const body = chat() as any;
  body.choices[0].message.tool_calls = null;
  assert.deepEqual(chatAnswer(body), { model: 'reported-model', text: 'Complete answer.' });
  const source =
    event({
      model: 'reported-model',
      choices: [
        {
          index: 0,
          delta: { content: 'Complete answer.', tool_calls: null },
          finish_reason: 'stop',
        },
      ],
    }) + 'data: [DONE]\n\n';
  assert.deepEqual(await streamAnswer(byteStream(source).stream, 'chat-completions'), {
    model: 'reported-model',
    text: 'Complete answer.',
  });
  body.choices[0].message.tool_calls = {};
  rejects(() => chatAnswer(body), 'INVALID_RESPONSE');
  body.choices[0].message.tool_calls = [{ type: 'function' }];
  rejects(() => chatAnswer(body), 'UPSTREAM_ERROR');
});

test('nonfinite nested tool parameters fail locally instead of being sent as null', () => {
  const tools = '[{"type":"hosted","options":{"limits":[1e400]}}]';
  rejects(() => parseInput(fieldAt('providers.model.tools'), tools), 'INVALID_ARGUMENT');
  rejects(() => prepare({ providers: { model: { tools: JSON.parse(tools) } } }));
  const valid = [{ type: 'hosted', options: { limits: [1e300, null, 0] } }];
  assert.deepEqual(prepare({ providers: { model: { tools: valid } } }).tools, valid);
});
