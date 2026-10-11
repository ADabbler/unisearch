import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { providers, fieldAt, isObject } from '../src/config/fields.js';
import type { Provider } from '../src/config/fields.js';
import { fixture, envelope } from './anysearch-fixture.js';
import { fixture as mcpFixture, rpc } from './zhipu-mcp-fixture.js';
import { search as tinyfishSearch } from './tinyfish-fixture.js';
import { search as zhipuSearch } from './zhipu-fixture.js';
import { envelope as jinaEnvelope, page as jinaPage } from './jina-helpers.js';
import { diagnoseAll, prepareDoctorBatch } from '../src/doctor.js';
import { renderDoctor } from '../src/output/doctor.js';
import { setImmediate } from 'node:timers/promises';
import { success } from '../src/result.js';

function serviceConfig(...enabled: Provider[]) {
  return {
    providers: Object.fromEntries(
      providers.map((provider) => [provider, { enabled: enabled.includes(provider) }]),
    ),
  };
}

test('bare doctor reports every service and diagnoses ready anonymous and authenticated services', async (t) => {
  const f = await fixture(t);
  const responses: Record<string, unknown> = {
    '/model/models': { data: [{ id: 'fixture-model' }] },
    '/ctx7/v2/libs/search': { results: [], searchFilterApplied: false },
    '/anysearch/v1/sub-domains': envelope({ domains: [] }),
    '/jina/': jinaEnvelope(jinaPage),
  };
  f.handle((call, res) => {
    assert.ok(call.path in responses, call.path);
    res.end(JSON.stringify(responses[call.path]));
  });
  const env = {
    UNISEARCH_MODEL_API_KEY: 'fixture-doctor-key',
    UNISEARCH_CTX7_BASE_URL: `${f.base}/ctx7`,
    UNISEARCH_ANYSEARCH_BASE_URL: `${f.base}/anysearch`,
    UNISEARCH_JINA_READER_URL: `${f.base}/jina`,
    UNISEARCH_TAVILY_BASE_URL: 'invalid-url',
    UNISEARCH_FIRECRAWL_API_KEY: '',
    UNISEARCH_RETRIES: 'invalid',
    UNISEARCH_FALLBACK: 'invalid',
  };
  f.save(serviceConfig('model', 'exa', 'ctx7', 'anysearch', 'jina', 'tavily'));
  const result = await f.run(['doctor', '--json', '--verbose'], env);
  assert.equal(result.exit, 6, result.channels.out);
  const data = result.json();
  assert.equal(data.status, 'partial');
  assert.deepEqual(
    data.data.services.map((service: { provider: string }) => service.provider),
    providers,
  );
  assert.deepEqual(
    Object.fromEntries(
      data.data.services.map((service: { provider: string; state: string }) => [
        service.provider,
        service.state,
      ]),
    ),
    {
      model: 'passed',
      exa: 'missing',
      tavily: 'invalid',
      firecrawl: 'disabled',
      ctx7: 'passed',
      jina: 'passed',
      zhipu: 'disabled',
      'zhipu-mcp': 'disabled',
      anysearch: 'passed',
      tinyfish: 'disabled',
    },
  );
  assert.equal(data.data.services[0].model, 'fixture-model');
  assert.equal(data.data.services[1].error.code, 'MISSING_CONFIG');
  assert.equal(data.data.services[2].error.code, 'INVALID_CONFIG');
  assert.equal(f.calls.length, 4);
  assert.deepEqual(
    data.meta.services.map((service: { provider: string }) => service.provider),
    ['model', 'ctx7', 'jina', 'anysearch'],
  );
  assert.ok(
    data.meta.services.every((service: { attempts: unknown[] }) => service.attempts.length === 1),
  );
  assert.doesNotMatch(result.channels.out, /fixture-doctor-key|results|example page/);
  for (const call of f.calls.filter((call) => call.path !== '/model/models'))
    assert.equal(call.headers.authorization, undefined);

  const plain = await f.run(['doctor'], env);
  assert.equal(plain.exit, 6);
  assert.match(
    plain.channels.out,
    /check passed|Missing configuration|Invalid configuration|Disabled/,
  );
  assert.match(
    plain.channels.out,
    /Model \(model\): check passed, Configured model: fixture-model/,
  );
  assert.doesNotMatch(plain.channels.out, /endpoint|attempts/);
  assert.doesNotMatch(plain.channels.out, /\[MISSING_CONFIG\]|\[INVALID_CONFIG\]|[。.]$/m);
  const plainLines = plain.channels.out.split('\n');
  assert.match(plainLines[0]!, /^Partial completion:/);
  const firstService = plainLines.findIndex((line) => line.startsWith('Model (model):'));
  assert.ok(firstService > 0);
  assert.equal(plainLines[firstService - 1], '');
  assert.equal(plain.channels.err, '');
  assert.match(
    plain.channels.out,
    /Jina \(jina\):\n  fetch: check passed \(anonymous\)\n  search: missing configuration \(not checked\)/,
  );
  const configured = await f.run(['doctor'], {
    ...env,
    UNISEARCH_CTX7_API_KEY: 'fixture-ctx7-key',
    UNISEARCH_ANYSEARCH_API_KEY: 'fixture-anysearch-key',
    UNISEARCH_JINA_API_KEY: 'fixture-jina-key',
  });
  assert.match(configured.channels.out, /Context7 \(ctx7\): check passed/);
  assert.match(configured.channels.out, /AnySearch \(anysearch\): check passed/);
  const configuredJina = configured.channels.out.slice(
    configured.channels.out.indexOf('Jina (jina):'),
    configured.channels.out.indexOf('Zhipu (zhipu):'),
  );
  assert.match(configuredJina, /Jina \(jina\): check passed/);
  assert.doesNotMatch(configuredJina, /anonymous|\n  fetch:|\n  search:/);
  const namedAnonymous = await f.run(['doctor', 'ctx7'], env);
  assert.match(namedAnonymous.channels.out, /Context7 \(ctx7\): check passed \(anonymous\)/);
  const namedJina = await f.run(['doctor', 'jina'], env);
  assert.match(
    namedJina.channels.out,
    /Jina \(jina\):\n  fetch: check passed \(anonymous\)\n  search: missing configuration \(not checked\)/,
  );
  for (const state of ['disabled', 'invalid', 'not_started']) {
    const skipped = renderDoctor({ services: [{ provider: 'jina', state }] }, 'en', {
      anonymous: new Set(['jina']),
    });
    assert.match(skipped, /^Jina \(jina\): \S/);
    assert.doesNotMatch(skipped, /anonymous|\n  fetch:|\n  search:/);
  }
  const verbose = await f.run(['doctor', '--verbose'], env);
  assert.equal(verbose.channels.out, plain.channels.out);
  assert.match(verbose.channels.err, /^\nDiagnostic details:\n\nModel \(model\):\n  Operation:/);
  assert.match(verbose.channels.err, /\nContext7 \(ctx7\):\n  Operation:/);
  assert.doesNotMatch(verbose.channels.err, /^model$/m);
  assert.doesNotMatch(verbose.channels.err, /\n\nContext7 \(ctx7\):/);
  assert.doesNotMatch(verbose.channels.out, /endpoint:|Execution time/);
  const namedVerbose = await f.run(['doctor', 'model', '--verbose'], env);
  assert.match(namedVerbose.channels.err, /^\nDiagnostic details:\n\nModel \(model\):/);
  f.reply({}, 401);
  const namedFailure = await f.run(['doctor', 'ctx7'], env);
  assert.equal(namedFailure.exit, 3);
  assert.equal(namedFailure.channels.out, '');
  assert.match(namedFailure.channels.err, /^Error:/);
});

test('bare doctor with no ready services reports skipped states without network checks', async (t) => {
  const f = await fixture(t);
  f.save(serviceConfig('exa'));
  const result = await f.run(['doctor', '--json']);
  assert.equal(result.exit, 0, result.channels.out);
  assert.equal(f.calls.length, 0);
  assert.equal(
    result.json().data.services.find((service: { provider: string }) => service.provider === 'exa')
      .state,
    'missing',
  );
  assert.ok(
    result.json().data.services.every((service: { state: string }) => service.state !== 'passed'),
  );
});

test('batch doctor retains independent failures and applies aggregate exit codes without retries', async (t) => {
  const f = await fixture(t);
  const env = {
    UNISEARCH_MODEL_API_KEY: 'fixture-model-key',
    UNISEARCH_TAVILY_API_KEY: 'fixture-tavily-key',
    UNISEARCH_TAVILY_BASE_URL: `${f.base}/tavily`,
    UNISEARCH_RETRIES: '5',
  };
  f.save(serviceConfig('model', 'tavily'));
  for (const [modelStatus, tavilyStatus, exit] of [
    [200, 200, 0],
    [200, 500, 6],
    [500, 500, 4],
    [401, 401, 3],
    [401, 500, 4],
  ]) {
    f.handle((call, res) => {
      const model = call.path === '/model/models';
      const status = model ? modelStatus : tavilyStatus;
      res.writeHead(status);
      let body: Record<string, unknown>;
      if (status !== 200) body = { error: { message: 'Refused' } };
      else if (model) body = { data: [{ id: 'fixture-model' }] };
      else body = { key: { usage: 0, limit: null }, account: {} };
      res.end(JSON.stringify(body));
    });
    const before = f.calls.length;
    const result = await f.run(['doctor', '--json'], env);
    assert.equal(result.exit, exit, result.channels.out);
    assert.equal(f.calls.length, before + 2);
    assert.equal(
      result.json().data.services.filter((service: { state: string }) => service.state === 'failed')
        .length,
      Number(modelStatus !== 200) + Number(tavilyStatus !== 200),
    );
    assert.equal(result.json().meta, undefined);
  }
});

test('batch doctor runs ready services in parallel within one timeout and returns a JSON report', async (t) => {
  const f = await fixture(t);
  f.handle((_call, res) => {
    res.writeHead(200);
    res.write('{');
  });
  f.save(serviceConfig('model', 'tavily'));
  const result = await f.run(['doctor', '--json', '--verbose', '--timeout', '0.15'], {
    UNISEARCH_MODEL_API_KEY: 'fixture-model-key',
    UNISEARCH_TAVILY_API_KEY: 'fixture-tavily-key',
    UNISEARCH_TAVILY_BASE_URL: `${f.base}/tavily`,
  });
  assert.equal(result.exit, 4, result.channels.out);
  assert.equal(f.calls.length, 2);
  assert.equal(result.channels.err, '');
  const saved = result.json();
  for (const service of saved.data.services.filter(
    (service: { state: string }) => service.state === 'failed',
  )) {
    assert.equal(service.error.code, 'TIMEOUT');
    assert.equal(service.error.details.timeout_scope, 'total');
  }
  assert.equal(saved.meta.services.length, 2);
});

test('batch doctor exposes cancellation and invalid global timeout before any requests', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    throw new Error('No request expected');
  };
  const values = serviceConfig('ctx7');
  const env = {};
  const plan = prepareDoctorBatch(undefined, values, env, 'en', transport);
  const abort = new AbortController();
  abort.abort();
  const result = await diagnoseAll(plan, abort.signal, 'en', {});
  assert.equal(result.exitCode, 130);
  assert.equal(result.result.error?.code, 'CANCELLED');
  assert.equal(
    result.result.data?.services.find((service) => service.provider === 'ctx7')?.state,
    'not_started',
  );
  assert.equal(calls, 0);
  assert.throws(
    () =>
      prepareDoctorBatch(
        undefined,
        values,
        { ...env, UNISEARCH_TIMEOUT_SECONDS: 'bad' },
        'en',
        transport,
      ),
    { code: 'INVALID_CONFIG' },
  );
  assert.equal(
    prepareDoctorBatch(1, values, { ...env, UNISEARCH_TIMEOUT_SECONDS: 'bad' }, 'en', transport)
      .timeout,
    1,
  );
});

test('batch doctor preserves completed checks when cancellation or an internal error stops pending work', async () => {
  for (const internal of [false, true]) {
    let pending!: () => void;
    const entered = new Promise<void>((resolve) => {
      pending = resolve;
    });
    const abort = new AbortController();
    const checks = providers.slice(0, 3).map((provider, index) => ({
      provider,
      timeout: 1,
      retries: 0,
      requestLimit: 1,
      check: { operation: 'fixture' },
      async request({ signal }: { signal: AbortSignal }) {
        if (index === 0) return { outcome: success({ provider }), retry: false };
        if (index === 2 && internal) {
          await entered;
          await setImmediate();
          throw new Error('Unexpected implementation error');
        }
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          pending();
        });
      },
    }));
    const promise = diagnoseAll(
      {
        timeout: 1,
        checks,
        services: checks.map(({ provider }) => ({ provider, state: 'not_started' })),
      },
      abort.signal,
      'en',
      {},
    );
    await entered;
    if (!internal) {
      await setImmediate();
      abort.abort();
    }
    const outcome = await promise;
    assert.equal(outcome.exitCode, internal ? 5 : 130);
    assert.equal(outcome.result.error?.code, internal ? 'INTERNAL_ERROR' : 'CANCELLED');
    assert.equal(outcome.result.data?.services[0].state, 'passed');
    assert.equal(outcome.result.data?.services[1].state, 'failed');
    assert.equal(outcome.result.status, 'error');
  }
});

test('each doctor check uses its fixed endpoint, method, auth and minimum input with compact results', async (t) => {
  const f = await fixture(t);
  const bodies: Record<string, unknown> = {
    model: { data: [{ id: 'fixture-model' }] },
    exa: { results: [] },
    ctx7: { results: [], searchFilterApplied: false },
    anysearch: envelope({ domains: [] }),
    tavily: { key: { usage: 0, limit: null }, account: {} },
    firecrawl: { success: true, data: { remainingCredits: 3 } },
    jina: jinaEnvelope(jinaPage),
    zhipu: zhipuSearch,
    tinyfish: tinyfishSearch,
  };
  const paths: Record<string, string> = {
    model: '/model/models',
    exa: '/exa/search',
    ctx7: '/ctx7/v2/libs/search',
    anysearch: '/anysearch/v1/sub-domains',
    tavily: '/tavily/usage',
    firecrawl: '/firecrawl/team/credit-usage',
    jina: '/jina/',
    zhipu: '/zhipu/web_search',
    tinyfish: '/tinyfish/',
  };
  for (const provider of providers.filter((p) => p !== 'zhipu-mcp')) {
    const key = fieldAt(`providers.${provider}.api_key`).environment!;
    const url = fieldAt(
      `providers.${provider}.${provider === 'jina' ? 'reader_url' : provider === 'tinyfish' ? 'search_url' : 'base_url'}`,
    ).environment!;
    f.save(serviceConfig(provider));
    const overrides = {
      [key]: 'fixture-doctor-key',
      [url]: `${f.base}/${provider}`,
      UNISEARCH_RETRIES: 'bad',
      UNISEARCH_FALLBACK: 'bad',
    };
    f.reply(bodies[provider]);
    const before = f.calls.length;
    const result = await f.run(['doctor', provider, '--json', '--verbose'], overrides);
    assert.equal(result.exit, 0, `${provider}: ${result.channels.out}`);
    assert.equal(f.calls.length, before + 1);
    const call = f.calls.at(-1)!;
    assert.equal(call.path, paths[provider]);
    assert.equal(call.method, ['exa', 'jina', 'zhipu'].includes(provider) ? 'POST' : 'GET');
    assert.equal(
      call.headers[['exa', 'tinyfish'].includes(provider) ? 'x-api-key' : 'authorization'],
      ['exa', 'tinyfish'].includes(provider) ? 'fixture-doctor-key' : 'Bearer fixture-doctor-key',
      provider,
    );
    assert.deepEqual(result.json().data, {
      provider,
      ...(provider === 'model' ? { model: 'fixture-model' } : {}),
    });
    assert.equal(result.json().meta.attempts.length, 1);
    assert.ok(result.json().meta.check.endpoint);
    if (provider === 'exa')
      assert.deepEqual(call.body, { query: 'UniSearch', numResults: 1, type: 'fast' });
    if (provider === 'ctx7')
      assert.equal(call.url.search, '?libraryName=react&query=hooks&fast=false');
    if (provider === 'anysearch') assert.equal(call.url.search, '?domain=general');
    if (provider === 'jina')
      assert.deepEqual(call.body, { respondWith: 'content', url: 'https://example.com' });
    if (provider === 'zhipu') assert.equal(call.body?.count, 1);
    if (provider === 'tinyfish')
      assert.equal(call.url.search, '?query=UniSearch&domain_type=web&page=0');
  }
});

test('model listing ignores generation settings and never falls back; malformed and missing models fail', async (t) => {
  const f = await fixture(t);
  f.save({
    providers: {
      model: {
        protocol: false,
        tools: false,
        stream: false,
        model: { effort: false },
        fallback_models: false,
      },
    },
    execution: { retries: false, fallback: false },
  });
  const env = { UNISEARCH_MODEL_API_KEY: 'fixture-key' };
  for (const [body, code] of [
    [{ data: [{ id: 'fixture-model' }] }, 0],
    [{ data: [] }, 4],
    [{ data: [{ id: '' }] }, 4],
    [{ data: [{ id: 'fixture-model' }, {}] }, 4],
  ] as const) {
    f.reply(body);
    const result = await f.run(['doctor', 'model', '--json'], env);
    assert.equal(result.exit, code, result.channels.out);
    assert.equal(result.json().meta, undefined);
    if (code) assert.equal(result.json().data, undefined);
  }
  for (const status of [401, 403, 404, 405, 429, 500]) {
    f.reply({ error: { message: 'List refused' } }, status);
    const count = f.calls.length;
    const result = await f.run(['doctor', 'model', '--json'], {
      ...env,
      UNISEARCH_RETRIES: '5',
    });
    assert.notEqual(result.exit, 0);
    assert.equal(f.calls.length, count + 1);
  }
  assert.ok(f.calls.every((call) => call.method === 'GET' && call.path === '/model/models'));
});

test('quota checks preserve null limits, reject known exhaustion and validate retained metadata regardless of verbose', async (t) => {
  const f = await fixture(t);
  const cases: [string, unknown, number][] = [
    [
      'tavily',
      {
        key: { usage: 10, limit: null },
        account: { plan_usage: 10, plan_limit: 1000, paygo_usage: 0, paygo_limit: null },
      },
      0,
    ],
    ['tavily', { key: { usage: 10, limit: 10 }, account: {} }, 4],
    [
      'tavily',
      {
        key: { usage: 0, limit: null },
        account: { plan_usage: 2, plan_limit: 2, paygo_usage: 0, paygo_limit: 0 },
      },
      4,
    ],
    ['tavily', { key: { usage: 0, limit: null }, account: { plan_usage: 2, plan_limit: 2 } }, 0],
    [
      'tavily',
      {
        key: { usage: 0, limit: null },
        account: { plan_usage: 2, plan_limit: 2, paygo_usage: 0, paygo_limit: null },
      },
      4,
    ],
    ['tavily', { key: { usage: 0, limit: null }, account: { plan_limit: null } }, 4],
    ['tavily', { key: { usage: 0, limit: null }, account: { current_plan: 1 } }, 4],
    ['firecrawl', { success: true, data: { remainingCredits: 1 } }, 0],
    ['firecrawl', { success: true, data: { remainingCredits: 0 } }, 4],
    ['firecrawl', { success: true, data: { remainingCredits: -1 } }, 4],
    ['firecrawl', { success: true, data: { remainingCredits: 1, planCredits: 'bad' } }, 4],
    ['firecrawl', { success: false, error: 'Insufficient credits' }, 4],
  ];
  for (const [provider, body, code] of cases)
    for (const verbose of [false, true]) {
      f.reply(body);
      const result = await f.run(
        ['doctor', provider, '--json', ...(verbose ? ['--verbose'] : [])],
        {
          [`UNISEARCH_${provider.toUpperCase()}_API_KEY`]: 'fixture-key',
          [`UNISEARCH_${provider.toUpperCase()}_BASE_URL`]: f.base,
        },
      );
      assert.equal(result.exit, code, result.channels.out);
      if (code === 0) assert.equal(result.json().data.provider, provider);
      assert.equal(result.json().data?.quota, undefined);
    }
});

test('MCP doctor discovers tools through paginated JSON/SSE without tool calls', async (t) => {
  const f = await mcpFixture(t);
  f.handle((call, res) => {
    assert.equal(call.body.method, 'tools/list');
    assert.equal(call.headers['mcp-session-id'], 'fixture-session');
    if (call.body.id === 2) rpc(res, 2, { tools: [{ name: 'other' }], nextCursor: 'page-2' });
    else {
      assert.deepEqual(call.body.params, { cursor: 'page-2' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: call.body.id, result: { tools: [{ name: 'webSearchPrime' }] } })}\n\n`,
      );
    }
  });
  const result = await f.run(['doctor', 'zhipu-mcp', '--json']);
  assert.equal(result.exit, 0, result.channels.out);
  assert.deepEqual(result.json().data, { provider: 'zhipu-mcp' });
  assert.deepEqual(
    f.calls.map((call) => call.body.method),
    ['initialize', 'notifications/initialized', 'tools/list', 'tools/list'],
  );
  f.handle((call, res) => rpc(res, call.body.id, { tools: [{ name: 'web_search_prime' }] }));
  const missing = await f.run(['doctor', 'zhipu-mcp', '--json']);
  assert.equal(missing.exit, 4);
  assert.equal(missing.json().error.details.reason, 'tool_not_listed');
});

test('MCP doctor rejects cyclic pagination without requesting a visited cursor again', async (t) => {
  const f = await mcpFixture(t);
  const cursors: unknown[] = [];
  f.handle((call, res) => {
    assert.equal(call.body.method, 'tools/list');
    const cursor = isObject(call.body.params) ? call.body.params.cursor : undefined;
    cursors.push(cursor);
    rpc(res, call.body.id, {
      tools: [],
      nextCursor: cursor === 'page-a' ? 'page-b' : 'page-a',
    });
  });
  const result = await f.run(['doctor', 'zhipu-mcp', '--json', '--timeout', '1']);
  assert.equal(result.exit, 4);
  assert.equal(result.json().error.code, 'INVALID_RESPONSE');
  assert.equal(result.json().error.details.field, 'result.nextCursor');
  assert.deepEqual(cursors, [undefined, 'page-a', 'page-b']);
});

test('doctor rejects arguments and unsupported output before requests and enforces total budget', async (t) => {
  const f = await fixture(t),
    output = join(f.root, 'result.json');
  writeFileSync(output, 'old');
  for (const args of [
    ['doctor', 'unknown'],
    ['doctor', 'exa', 'ctx7'],
    ['doctor', 'exa'],
  ])
    assert.notEqual((await f.run([...args, '--json'])).exit, 0);
  assert.equal(f.calls.length, 0);
  const env = { UNISEARCH_MODEL_API_KEY: 'fixture-key' };
  f.reply({ data: [] });
  assert.equal((await f.run(['doctor', 'model', '--json', '--output', output], env)).exit, 2);
  assert.equal(readFileSync(output, 'utf8'), 'old');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.run(['doctor', 'model', '--json'], env)).exit, 4);
  f.handle((_call, res) => {
    res.writeHead(200);
    res.write('{');
  });
  assert.equal((await f.run(['doctor', 'model', '--json', '--timeout', '0.03'], env)).exit, 4);
  f.reply({ data: [{ id: 'fixture-model' }] });
  const plain = await f.run(['doctor', 'model'], env);
  assert.match(plain.channels.out, /check passed/);
  assert.doesNotMatch(plain.channels.out, /models|endpoint|\|/);
});

test('Zhipu doctor keeps platform and engine, uses the minimum legal count and ignores unused count on Quark', async (t) => {
  const f = await fixture(t);
  f.reply(zhipuSearch);
  for (const [platform, engine, count] of [
    ['bigmodel', 'search_std', 1],
    ['bigmodel', 'search_pro', 1],
    ['bigmodel', 'search_pro_sogou', 10],
    ['bigmodel', 'search_pro_quark', undefined],
    ['zai', 'search-prime', 1],
  ] as const) {
    f.save({ providers: { zhipu: { platform, search: { engine, limit: 50 } } } });
    const result = await f.run(['doctor', 'zhipu', '--json'], {
      UNISEARCH_ZHIPU_API_KEY: 'fixture-key',
      UNISEARCH_ZHIPU_BASE_URL: f.base,
    });
    assert.equal(result.exit, 0, result.channels.out);
    const body = f.calls.at(-1)!.body!;
    assert.equal(body.search_engine, engine);
    assert.equal(body.count, count);
  }
});

test('doctor rejects malformed business responses and partial business results without exposing diagnostic content', async (t) => {
  const f = await fixture(t);
  const env = { UNISEARCH_EXA_API_KEY: 'fixture-key' };
  f.handle((_call, res) => res.end('<html>not json</html>'));
  assert.equal(
    (await f.run(['doctor', 'exa', '--json'], env)).json().error.code,
    'INVALID_RESPONSE',
  );
  f.reply({
    search_result: [{ link: 'https://example.org', title: 'valid' }, { title: 'missing link' }],
  });
  const partial = await f.run(['doctor', 'zhipu', '--json'], {
    UNISEARCH_ZHIPU_API_KEY: 'fixture-key',
    UNISEARCH_ZHIPU_BASE_URL: f.base,
  });
  assert.equal(partial.exit, 4);
  assert.equal(partial.json().data, undefined);
  assert.equal(partial.json().status, 'error');
});
