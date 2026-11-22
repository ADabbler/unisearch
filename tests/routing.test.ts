import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fieldAt, searchProviders } from '../src/config/fields.js';
import { localStatus } from '../src/config/status.js';
import { resolveField } from '../src/config/resolve.js';
import { operations } from '../src/providers/operations.js';
import { renderStatus } from '../src/output/config.js';
import { prepareCombinedSearch, combinedSearch } from '../src/search.js';
import { createCli } from '../src/cli/program.js';
import type { JsonObject } from '../src/result.js';
import type { ExecutionClock } from '../src/execution.js';
import { capture, context, temporary } from './helpers.js';

function config(enabled = ['exa', 'tavily']): JsonObject {
  return {
    providers: Object.fromEntries(
      searchProviders.map((id) => [
        id,
        {
          enabled: enabled.includes(id),
          api_key: `${id}-secret`,
          ...(id === 'model'
            ? {
                base_url: 'https://model.example',
                model: { id: 'search-model' },
                tools: ['web_search'],
              }
            : {}),
        },
      ]),
    ),
    search: {
      providers: ['exa'],
      routing: {
        enabled: true,
        classifier: { api_key: 'classifier-secret', model: 'pinned-classifier' },
      },
    },
    execution: { retries: 0 },
  };
}

function classified(scores: readonly number[], countChoice?: string) {
  const answers: JsonObject = Object.fromEntries(
    scores.map((noul, index) => [`source_${index}`, { type: 'noul', noul }]),
  );
  if (countChoice !== undefined) answers.source_count = { type: 'choice', choice: countChoice };
  return { model: 'pinned-classifier', answers };
}

function chosen(choices: Record<string, string>) {
  return {
    model: 'pinned-classifier',
    answers: Object.fromEntries(
      Object.entries(choices).map(([id, choice]) => [id, { type: 'choice', choice }]),
    ),
  };
}

const signal = () => new AbortController().signal;

test('Auto selection uses the recommended count, score threshold and source order on ties', async () => {
  for (const [scores, cap, countChoice, expected] of [
    [[0.9, 0.8], 3, '1_source', ['exa']],
    [[0.8, 0.9], 3, '2_sources', ['tavily', 'exa']],
    [[0.7, 0.95], 1, undefined, ['tavily']],
    [[0.9, 0.2], 3, '2_sources', ['exa']],
    [[0.7, 0.7], 3, '2_sources', ['exa', 'tavily']],
  ] as const) {
    const values = config();
    (values.search as JsonObject).routing = {
      enabled: true,
      max_sources: cap,
      classifier: { api_key: 'classifier-secret', model: 'pinned-classifier' },
    };
    const calls: string[] = [];
    const transport: typeof fetch = async (url, init) => {
      calls.push(String(url));
      if (calls.length === 1) {
        assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer classifier-secret');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.state.query, '最新 API 文档');
        assert.equal(body.state.max_sources, cap);
        assert.deepEqual(
          body.state.candidates.map((item: { id: string }) => item.id),
          ['exa', 'tavily'],
        );
        assert.match(body.state.candidates[0].description, /excerpts/);
        const { source_count: countQuestion, ...sourceQuestions } = body.questions;
        assert.deepEqual(Object.keys(sourceQuestions), ['source_0', 'source_1']);
        if (cap === 1) assert.equal(countQuestion, undefined);
        else {
          assert.equal(countQuestion.type, 'choice');
          assert.deepEqual(countQuestion.criteria, { '1_source': null, '2_sources': null });
        }
        return Response.json(classified(scores, countChoice));
      }
      if (calls.length === 2) {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(
          body.state.services.map((service: { id: string }) => service.id),
          expected,
        );
        const choices: Record<string, string> = {};
        if (expected.some((provider) => provider === 'exa'))
          Object.assign(choices, { exa_search_type: 'auto', exa_category: 'none' });
        if (expected.some((provider) => provider === 'tavily'))
          Object.assign(choices, { tavily_search_depth: 'basic', tavily_topic: 'general' });
        return Response.json(chosen(choices));
      }
      return Response.json({ results: [] });
    };
    const record: JsonObject = {};
    const result = await combinedSearch(
      prepareCombinedSearch('最新 API 文档', {}, values, {}, 'en'),
      signal(),
      'en',
      record,
      { transport },
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      result.result.data?.sources.map((source) => source.provider),
      expected,
    );
    assert.equal(calls.length, expected.length + 2);
    assert.equal((record.attempts as JsonObject[])[0].provider, 'classifier');
  }
});

test('Direct source selection and no-auto bypass classifier configuration; auto rejects explicit model options', () => {
  const values = config(['model', 'exa']);
  (values.search as JsonObject).routing = { enabled: true, classifier: { protocol: 'invalid' } };
  const direct = prepareCombinedSearch(
    'q',
    { sources: 'model', auto: true, effort: 'low' },
    values,
    {},
    'en',
  );
  assert.equal(direct.routing, undefined);
  assert.equal(direct.sources[0].provider, 'model');
  assert.equal(prepareCombinedSearch('q', { auto: false }, values, {}, 'en').routing, undefined);
  for (const options of [
    { model: 'm' },
    { effort: 'low' },
    { stream: true },
    { stream: false },
    { fallback: false },
  ]) {
    assert.throws(() => prepareCombinedSearch('q', options, values, {}, 'en'), {
      code: 'INVALID_ARGUMENT',
      key: 'autoModelOptions',
    });
  }
  assert.equal(
    prepareCombinedSearch(
      'q',
      { sources: 'exa' },
      values,
      { UNISEARCH_ROUTING_ENABLED: 'bad' },
      'en',
    ).routing,
    undefined,
  );
});

test('Candidates use actual preparation constraints, skip missing/disabled sources and never hide invalid configuration', () => {
  const values = config(['deepseek', 'firecrawl', 'zhipu', 'exa']);
  const plan = prepareCombinedSearch('字'.repeat(501), {}, values, {}, 'en');
  assert.deepEqual(
    plan.sources.map((source) => source.provider),
    ['exa'],
  );
  assert.equal(plan.routing?.parameters[0].provider, 'exa');
  const providers = values.providers as JsonObject;
  (providers.deepseek as JsonObject).search = { limit: 0 };
  assert.throws(() => prepareCombinedSearch('字'.repeat(501), {}, values, {}, 'en'), {
    code: 'INVALID_CONFIG',
  });
  delete (providers.deepseek as JsonObject).search;
  (providers.exa as JsonObject).api_key = '';
  assert.throws(() => prepareCombinedSearch('q', {}, values, {}, 'en'), { code: 'INVALID_CONFIG' });
  const missing = config(['exa']);
  delete ((missing.providers as JsonObject).exa as JsonObject).api_key;
  assert.throws(() => prepareCombinedSearch('q', {}, missing, {}, 'en'), {
    code: 'MISSING_CONFIG',
    key: 'routingNoCandidates',
  });
  assert.throws(
    () =>
      prepareCombinedSearch('q', {}, config(['exa']), { UNISEARCH_ROUTING_MAX_SOURCES: '0' }, 'en'),
    { code: 'INVALID_CONFIG' },
  );
});

test('Search rejects unknown settings in the active configuration scope', () => {
  const values = config(['model', 'exa']);
  values.search = { provider: ['exa'] };
  assert.throws(() => prepareCombinedSearch('q', {}, values, {}, 'en'), {
    code: 'INVALID_CONFIG',
    key: 'unknownField',
  });
  values.search = { routing: { enabled: true, max_source: 1 } };
  assert.throws(() => prepareCombinedSearch('q', {}, values, {}, 'en'), {
    code: 'INVALID_CONFIG',
    key: 'unknownField',
  });
  assert.equal(prepareCombinedSearch('q', { sources: 'exa' }, values, {}, 'en').routing, undefined);
  assert.equal(prepareCombinedSearch('q', { auto: false }, values, {}, 'en').routing, undefined);
});

test('Invalid or empty classification fails without starting searches', async () => {
  const values = config(['exa', 'tavily', 'firecrawl']);
  const env = { UNISEARCH_ROUTING_MAX_SOURCES: '2' };
  const scores = [0.8, 0.9, 0.7];
  const valid = classified(scores, '1_source');
  for (const [body, code] of [
    [classified([0.1, 0.2, 0.3], '1_source'), 'CONTENT_UNAVAILABLE'],
    [classified(scores), 'INVALID_RESPONSE'],
    [classified(scores, '3_sources'), 'INVALID_RESPONSE'],
    [
      { ...valid, answers: { ...valid.answers, source_count: { type: 'choice', choice: 2 } } },
      'INVALID_RESPONSE',
    ],
    [classified([0.8, 0.9], '1_source'), 'INVALID_RESPONSE'],
    [classified([1.1, 0.9, 0.8], '1_source'), 'INVALID_RESPONSE'],
    [classified([0.8, 0.9, 0.7, 0.8], '1_source'), 'INVALID_RESPONSE'],
    [{ answers: valid.answers }, 'INVALID_RESPONSE'],
    [
      { ...valid, answers: { ...valid.answers, source_0: { type: 'noul', noul: '0.9' } } },
      'INVALID_RESPONSE',
    ],
  ] as const) {
    let calls = 0;
    const result = await combinedSearch(
      prepareCombinedSearch('q', {}, values, env, 'en'),
      signal(),
      'en',
      {},
      {
        transport: async () => {
          calls++;
          return Response.json(body);
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.exitCode, 4);
    assert.equal(result.result.error?.code, code);
    assert.equal(result.result.data, undefined);
  }
});

test('Classifier HTTP failures retain redacted diagnostics', async () => {
  const record: JsonObject = {};
  const result = await combinedSearch(
    prepareCombinedSearch('q', {}, config(), {}, 'en'),
    signal(),
    'en',
    record,
    {
      transport: async () =>
        Response.json(
          { error: { message: 'bad classifier-secret exa-secret' } },
          { status: 401, headers: { 'x-request-id': 'classifier-secret' } },
        ),
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.result.error?.code, 'AUTHENTICATION_ERROR');
  assert.doesNotMatch(JSON.stringify([result, record]), /classifier-secret|exa-secret/);
});

test('Automatically selected model uses saved settings and Exa failures retain their data', async () => {
  const values = config(['model', 'exa']);
  ((values.providers as JsonObject).model as JsonObject).model = {
    id: 'saved-model',
    effort: 'low',
  };
  const calls: string[] = [];
  const result = await combinedSearch(
    prepareCombinedSearch('q', {}, values, {}, 'en'),
    signal(),
    'en',
    {},
    {
      transport: async (url, init) => {
        calls.push(String(url));
        if (calls.length === 1) return Response.json(classified([0.9, 0.8], '2_sources'));
        if (calls.length === 2) {
          assert.deepEqual(JSON.parse(String(init?.body)).state.services, [
            { id: 'exa', current: { search_type: 'auto', category: 'none' } },
          ]);
          return Response.json(chosen({ exa_search_type: 'auto', exa_category: 'none' }));
        }
        if (String(url).includes('model.example')) {
          const body = JSON.parse(String(init?.body));
          assert.equal(body.model, 'saved-model');
          assert.equal(body.reasoning.effort, 'low');
          assert.deepEqual(body.tools, [{ type: 'web_search' }]);
          return Response.json({
            model: 'saved-model',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Search findings.' }],
              },
            ],
          });
        }
        return Response.json({
          results: [],
          notices: [
            { code: 'RESTRICTIONS_RELAXED', path: '/query', message: 'Query restrictions relaxed' },
          ],
        });
      },
    },
  );
  assert.equal(result.exitCode, 6);
  assert.equal(calls.length, 4);
  assert.deepEqual(
    result.result.data?.sources.map((source) => source.provider),
    ['model', 'exa'],
  );
  const failed = result.result.error?.details?.failures?.[0];
  assert.ok(failed && 'provider' in failed);
  assert.equal(failed.provider, 'exa');
  assert.match(JSON.stringify(result.result.data), /RESTRICTIONS_RELAXED/);
});

test('Cancellation interrupts either classification stage before searches start', async () => {
  for (const stage of [1, 2]) {
    const abort = new AbortController();
    let calls = 0;
    const pending = combinedSearch(
      prepareCombinedSearch('q', {}, config(), {}, 'en'),
      abort.signal,
      'en',
      {},
      {
        transport: async (_url, init) => {
          calls++;
          if (calls < stage) return Response.json(classified([0.9, 0.8], '2_sources'));
          return new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
            abort.abort();
          });
        },
      },
    );
    assert.equal((await pending).exitCode, 130);
    assert.equal(calls, stage);
  }
});

test('One batched parameter classification applies each selected service setting without changing configuration', async () => {
  const ids = ['exa', 'tavily', 'firecrawl', 'jina', 'zhipu', 'tinyfish'];
  const values = config(ids);
  ((values.search as JsonObject).routing as JsonObject).max_sources = 6;
  const providers = values.providers as JsonObject;
  (providers.exa as JsonObject).search = { limit: 7, search_type: 'lite' };
  (providers.tavily as JsonObject).search = { limit: 8, search_depth: 'fast' };
  const saved = JSON.stringify(values);
  const query = 'Rust 异步运行时论文与架构图';
  const plan = prepareCombinedSearch(query, {}, values, {}, 'en');
  let calls = 0;
  const result = await combinedSearch(
    plan,
    signal(),
    'en',
    {},
    {
      transport: async (url, init) => {
        calls++;
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (calls === 1) {
          const scores = ids.map(() => 0.9);
          return Response.json(classified(scores, '6_sources'));
        }
        if (calls === 2) {
          assert.deepEqual(body.state.services, [
            { id: 'exa', current: { search_type: 'lite', category: 'none' } },
            { id: 'tavily', current: { search_depth: 'fast', topic: 'general' } },
            { id: 'firecrawl', current: { categories: 'none' } },
            { id: 'jina', current: { search_type: 'web' } },
            { id: 'zhipu', current: { engine: 'search_std' } },
            { id: 'tinyfish', current: { search_type: 'web' } },
          ]);
          assert.equal(Object.keys(body.questions).length, 8);
          assert.match(body.questions.zhipu_engine.instructions, /services\[4\]/);
          assert.match(body.questions.tinyfish_search_type.instructions, /services\[5\]/);
          return Response.json(
            chosen({
              exa_search_type: 'deep-lite',
              exa_category: 'publication',
              tavily_search_depth: 'advanced',
              tavily_topic: 'news',
              firecrawl_categories: 'research,pdf',
              jina_search_type: 'images',
              zhipu_engine: 'search_pro_quark',
              tinyfish_search_type: 'research_paper',
            }),
          );
        }
        const target = new URL(String(url));
        const provider = plan.sources.find(
          (source) =>
            source.provider !== 'model' && new URL(source.request.url).hostname === target.hostname,
        )?.provider;
        switch (provider) {
          case 'exa':
            assert.equal(body.query, query);
            assert.equal(body.type, 'deep-lite');
            assert.equal(body.category, 'publication');
            assert.equal(body.numResults, 7);
            return Response.json({ results: [] });
          case 'tavily':
            assert.equal(body.query, query);
            assert.equal(body.search_depth, 'advanced');
            assert.equal(body.topic, 'news');
            assert.equal(body.max_results, 8);
            return Response.json({ results: [] });
          case 'firecrawl':
            assert.equal(body.query, query);
            assert.deepEqual(body.categories, ['research', 'pdf']);
            return Response.json({ success: true, data: { web: [] } });
          case 'jina':
            assert.equal(body.q, query);
            assert.equal(body.type, 'images');
            return Response.json({ code: 200, status: 20000, data: [] });
          case 'zhipu':
            assert.equal(body.search_query, query);
            assert.equal(body.search_engine, 'search_pro_quark');
            assert.equal(body.count, undefined);
            return Response.json({ search_result: [] });
          case 'tinyfish':
            assert.equal(target.searchParams.get('query'), query);
            assert.equal(target.searchParams.get('domain_type'), 'research_paper');
            return Response.json({ page: 0, results: [] });
          default:
            assert.fail(`Unexpected request: ${url}`);
        }
      },
    },
  );
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(calls, 8);
  assert.deepEqual(
    result.result.data?.sources.map((source) => source.provider),
    ids,
  );
  assert.equal(JSON.stringify(values), saved);
});

test('A single parameterized source skips source selection and still classifies its settings', async () => {
  let calls = 0;
  const result = await combinedSearch(
    prepareCombinedSearch('q', {}, config(['exa']), {}, 'en'),
    signal(),
    'en',
    {},
    {
      transport: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        if (calls === 1) {
          assert.deepEqual(Object.keys(body.questions), ['exa_search_type', 'exa_category']);
          return Response.json(chosen({ exa_search_type: 'lite', exa_category: 'none' }));
        }
        assert.equal(body.type, 'lite');
        assert.equal(body.category, undefined);
        return Response.json({ results: [] });
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(calls, 2);
});

test('Zhipu offers only engines compatible with saved count and skips parameter classification on Z.AI', async () => {
  for (const [limit, expected] of [
    [undefined, ['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark']],
    [5, ['search_std', 'search_pro']],
    [20, ['search_std', 'search_pro', 'search_pro_sogou']],
  ] as const) {
    const values = config(['zhipu']);
    const provider = (values.providers as JsonObject).zhipu as JsonObject;
    if (limit !== undefined) provider.search = { limit };
    const plan = prepareCombinedSearch('q', {}, values, {}, 'en');
    const parameter = plan.routing!.parameters[0];
    assert.deepEqual(Object.keys(parameter.questions.engine.criteria), expected);
    const selected = parameter.prepare({ engine: 'search_pro' });
    assert.ok(selected.provider === 'zhipu');
    assert.equal(selected.request.body.count, limit ?? 10);
  }
  const values = config(['exa', 'zhipu']);
  ((values.providers as JsonObject).zhipu as JsonObject).platform = 'zai';
  let calls = 0;
  const result = await combinedSearch(
    prepareCombinedSearch('q', {}, values, {}, 'en'),
    signal(),
    'en',
    {},
    {
      transport: async (_url, init) => {
        calls++;
        if (calls === 1) return Response.json(classified([0.1, 0.9], '1_source'));
        assert.equal(JSON.parse(String(init?.body)).search_engine, 'search-prime');
        return Response.json({ search_result: [] });
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(calls, 2);
  ((values.providers as JsonObject).exa as JsonObject).enabled = false;
  delete ((values.search as JsonObject).routing as JsonObject).classifier;
  assert.equal(prepareCombinedSearch('q', {}, values, {}, 'en').routing, undefined);
});

test('Invalid parameter choices fail before searches instead of reverting to defaults', async () => {
  for (const answer of [
    { type: 'choice', choice: 'unknown' },
    { type: 'noul', noul: 0.9 },
  ]) {
    let calls = 0;
    const result = await combinedSearch(
      prepareCombinedSearch('q', {}, config(['firecrawl']), {}, 'en'),
      signal(),
      'en',
      {},
      {
        transport: async () => {
          calls++;
          return Response.json({ model: 'm', answers: { firecrawl_categories: answer } });
        },
      },
    );
    assert.equal(result.result.error?.code, 'INVALID_RESPONSE');
    assert.equal(result.result.data, undefined);
    assert.equal(calls, 1);
  }
});

test('Classification consumes the original deadline and retries reuse the same budget', async () => {
  let now = 0;
  const budgets: number[] = [];
  const clock: ExecutionClock = {
    now: () => now,
    wallNow: () => 0,
    sleep: async (ms) => {
      now += ms;
    },
    schedule: (ms) => {
      budgets.push(ms);
      return () => {};
    },
  };
  let calls = 0;
  const values = config();
  values.execution = { retries: 1 };
  const result = await combinedSearch(
    prepareCombinedSearch('q', { timeout: 2 }, values, {}, 'en'),
    signal(),
    'en',
    {},
    {
      clock,
      transport: async () => {
        calls++;
        if (calls === 1) return Response.json({}, { status: 429, headers: { 'retry-after': '1' } });
        if (calls === 2) {
          now += 500;
          return Response.json(classified([0.9, 0.1], '1_source'));
        }
        if (calls === 3) {
          now += 200;
          return Response.json(chosen({ exa_search_type: 'auto', exa_category: 'none' }));
        }
        now += 600;
        return Response.json({ results: [] });
      },
    },
  );
  assert.equal(result.result.error?.code, 'TIMEOUT');
  assert.deepEqual(budgets, [2000, 1000, 500, 300]);
});

test('Routing environment fields override files and status reports local classifier readiness', () => {
  const values = config();
  const env = { UNISEARCH_ROUTING_MAX_SOURCES: '1', UNISEARCH_CLASSIFIER_MODEL_ID: 'other-model' };
  const plan = prepareCombinedSearch('q', {}, values, env, 'en');
  assert.equal(plan.routing?.maxSources, 1);
  assert.equal(plan.routing?.model, 'other-model');
  const savedClassifier = ((values.search as JsonObject).routing as JsonObject)
    .classifier as JsonObject;
  savedClassifier.protocol = 'bad';
  assert.equal(
    prepareCombinedSearch('q', {}, values, { UNISEARCH_CLASSIFIER_PROTOCOL: 'typesafe' }, 'en')
      .routing?.model,
    'pinned-classifier',
  );
  savedClassifier.protocol = 'typesafe';
  const data = localStatus(values, env, 'zh', operations);
  assert.equal(data.search?.routing.enabled, true);
  assert.equal(data.search?.routing?.classifier.state, 'ready');
  assert.deepEqual(data.search?.providers, ['exa']);
  const manual = localStatus(values, { UNISEARCH_ROUTING_ENABLED: 'false' }, 'zh', operations);
  assert.equal(manual.search?.routing.enabled, false);
  assert.equal(manual.search?.routing.classifier.state, 'ready');
  delete ((values.search as JsonObject).routing as JsonObject).classifier;
  assert.equal(
    localStatus(values, {}, 'en', operations).search?.routing?.classifier.state,
    'missing',
  );
  const missing = localStatus(values, { UNISEARCH_ROUTING_ENABLED: 'false' }, 'en', operations);
  assert.equal(missing.search?.routing.enabled, false);
  assert.equal(missing.search?.routing.classifier.state, 'missing');
  (values.search as JsonObject).providers = [];
  const invalidList = localStatus(values, {}, 'zh', operations);
  assert.equal(invalidList.search?.routing?.classifier.state, 'missing');
  assert.equal(invalidList.search?.routing.enabled, true);
  const invalidSwitch = localStatus(values, { UNISEARCH_ROUTING_ENABLED: 'bad' }, 'zh', operations);
  assert.equal(invalidSwitch.search?.routing.enabled, undefined);
  assert.ok(
    invalidSwitch.issues?.some((issue) => issue.environment === 'UNISEARCH_ROUTING_ENABLED'),
  );
  assert.match(renderStatus(invalidSwitch, 'zh'), /UNISEARCH_ROUTING_ENABLED/);
  for (const [name, field, value] of [
    ['UNISEARCH_CLASSIFIER_PROTOCOL', 'protocol', 'typesafe'],
    ['UNISEARCH_CLASSIFIER_BASE_URL', 'base_url', 'https://classifier.example/v1'],
    ['UNISEARCH_CLASSIFIER_API_KEY', 'api_key', 'override-key'],
  ])
    assert.equal(
      resolveField(values, { [name]: value }, fieldAt(`search.routing.classifier.${field}`)).value,
      value,
    );
});

test('CLI respects configured auto, explicit direct sources, no-auto and dedicated model search', async (t) => {
  const root = temporary(t);
  const path = join(root, 'config.json');
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    calls.push(req.url!);
    if (req.url === '/systemone') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.end(
        JSON.stringify(
          body.state.candidates
            ? classified([0.8, 0.9], '1_source')
            : chosen({ tavily_search_depth: 'basic', tavily_topic: 'general' }),
        ),
      );
    } else res.end(JSON.stringify({ results: [] }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  writeFileSync(path, JSON.stringify(config()));
  const env = {
    UNISEARCH_CONFIG_PATH: path,
    UNISEARCH_LANG: 'en',
    UNISEARCH_CLASSIFIER_BASE_URL: base,
    UNISEARCH_EXA_BASE_URL: `${base}/exa`,
    UNISEARCH_TAVILY_BASE_URL: `${base}/tavily`,
  };
  for (const [args, expected] of [
    [[], ['/systemone', '/systemone', '/tavily/search']],
    [['--no-auto'], ['/exa/search']],
    [['--sources', 'exa', '--auto'], ['/exa/search']],
  ] as const) {
    calls.length = 0;
    const channels = capture();
    assert.equal(
      await createCli('test', { config: context(root, env), channels }).run([
        'search',
        'q',
        ...args,
        '--format=json',
      ]),
      0,
      channels.out,
    );
    assert.deepEqual(calls, expected);
  }
  const channels = capture();
  assert.equal(
    await createCli('test', { config: context(root, env), channels }).run([
      'model',
      'search',
      'q',
      '--format=json',
    ]),
    3,
  );
  assert.match(channels.out, /SERVICE_DISABLED/);
});
