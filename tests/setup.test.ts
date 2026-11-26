import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { SetupDraft, promptSetup, applySetup } from '../src/setup.js';
import { renderSetup, setupPreviewLines } from '../src/output/setup.js';
import { display } from '../src/output/index.js';
import { AppError } from '../src/errors.js';
import { providers } from '../src/config/fields.js';
import { capture, context, temporary } from './helpers.js';
import { createCli } from '../src/cli/program.js';
import { PromptBack } from '../src/cli/prompts.js';
import type { Choice, Prompts } from '../src/cli/prompts.js';
import { text } from '../src/i18n/messages.js';
import { prepareCombinedSearch } from '../src/search.js';

const isSearchSourcesPrompt = (message: string) =>
  (['en', 'zh'] as const).some(
    (language) => message === text(language, 'setupSelectSearchSources'),
  );
const escape = Symbol('Escape');
function navigateSetup(...steps: (string | typeof escape)[]) {
  return (message: string, choices: Choice[]) => {
    const menus = ['setupTitle', 'setupSearch', 'setupReview', 'setupLanguage'] as const;
    if (!menus.some((key) => message === text('en', key) || message === text('zh', key))) return;
    const next = steps.shift();
    if (next === escape) throw new PromptBack();
    assert.ok(
      choices.some((choice) => choice.value === next),
      `${message}: ${next}`,
    );
    return next;
  };
}

test('Setup saved configuration and Codex Skill are usable by new CLI processes', async (t) => {
  const root = temporary(t),
    path = join(root, 'config.json');
  const calls: { path: string; key: string | string[] | undefined; body: unknown }[] = [];
  const results = [{ title: 'Setup guide', url: 'https://example.org/setup' }];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      path: req.url!,
      key: req.headers['x-api-key'],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/setup`;
  const values = {
    providers: Object.fromEntries(providers.map((provider) => [provider, { enabled: false }])),
    execution: { retries: 0 },
  };
  await fs.writeFile(path, JSON.stringify(values));
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('UNISEARCH_')),
    ),
    UNISEARCH_CONFIG_PATH: path,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, '.config'),
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
    npm_config_prefix: join(root, 'npm-prefix'),
  };
  const draft = new SetupDraft(
    { path, source: 'environment', exists: true, values },
    context(root, env),
    'en',
  );
  const navigate = navigateSetup(
    'services',
    'search',
    'sources',
    escape,
    'skills',
    'review',
    'save',
  );
  const multiple = [['exa'], ['codex']];
  const prompts: Prompts = {
    async select(message, choices) {
      const section = navigate(message, choices);
      if (section) return section;
      assert.ok(choices.some((choice) => choice.value === 'custom'));
      return 'custom';
    },
    async multi(message, _choices, initial, _language, validate) {
      if (isSearchSourcesPrompt(message)) {
        assert.deepEqual(initial, ['model']);
        assert.equal(validate!([]), text('en', 'setupSearchSourcesRequired'));
        return ['exa'];
      }
      return multiple.shift()!;
    },
    async input(_message, secret, validate) {
      const value = secret ? 'fixture-setup-key' : base;
      assert.equal(validate(value), undefined);
      return value;
    },
  };
  await promptSetup(
    draft,
    prompts,
    (current) => {
      const lines = setupPreviewLines(current);
      const preview = lines.join('\n');
      assert.doesNotMatch(preview, /fixture-setup-key/);
      assert.ok(preview.includes(join(root, '.codex', 'skills', 'unisearch')));
      return lines;
    },
    () => {},
    () => {},
  );
  const saved = await applySetup(draft, path, new AbortController().signal);
  assert.equal(saved.exitCode, 0);
  assert.equal(saved.result.data?.config.state, 'saved');
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path, 'utf8')).providers), [
    'model',
    'exa',
    'tavily',
    'firecrawl',
    'ctx7',
    'jina',
    'zhipu',
    'zhipu-mcp',
    'anysearch',
    'tinyfish',
    'deepseek',
  ]);
  assert.doesNotMatch(JSON.stringify(saved), /fixture-setup-key/);
  const output = capture();
  assert.equal(
    await display(saved, { format: 'text', language: 'en', renderText: renderSetup }, output),
    0,
  );
  assert.equal(output.err, '');
  assert.doesNotMatch(output.out, /fixture-setup-key/);

  const cli = resolve('dist/cli.js');
  const execFileAsync = promisify(execFile);
  const runCli = async (args: string[]) => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cli, ...args, ...(args[0] === 'status' || args[0] === 'config' ? [] : ['--format=json'])],
      {
        cwd: root,
        env,
      },
    );
    assert.equal(stderr, '');
    assert.doesNotMatch(stdout, /fixture-setup-key/);
    const json = JSON.parse(stdout);
    assert.equal(json.status, 'success');
    return json.data;
  };
  const status = await runCli(['status', '--json']);
  assert.deepEqual(
    status.services.map((service: { provider: string; state: string }) => ({
      provider: service.provider,
      state: service.state,
    })),
    providers.map((provider) => ({ provider, state: provider === 'exa' ? 'ready' : 'disabled' })),
  );
  const [target] = draft.targets();
  const installedSkill = await fs.readFile(join(target.path, 'SKILL.md'), 'utf8');
  assert.equal(installedSkill, await fs.readFile(resolve('skills/unisearch/SKILL.md'), 'utf8'));
  assert.deepEqual(calls, []);
  assert.deepEqual(await runCli(['search', 'setup integration']), {
    sources: [
      {
        provider: 'exa',
        data: { results },
      },
    ],
  });
  assert.deepEqual(calls, [
    {
      path: '/setup/search',
      key: 'fixture-setup-key',
      body: {
        query: 'setup integration',
        numResults: 5,
        type: 'auto',
        contents: { text: false, highlights: true },
      },
    },
  ]);
});

test('Setup preserves existing defaults and environment credentials; service selection enables only selected saved false values', async (t) => {
  const root = temporary(t),
    path = join(root, 'config.json');
  const original = {
    providers: {
      exa: { enabled: false },
      tavily: { enabled: false },
      model: { tools: ['web_search'] },
    },
    execution: { retries: 0 },
    fetch: { providers: ['jina'] },
  };
  const draft = new SetupDraft(
    { path, source: 'default', exists: true, values: original },
    context(root, { UNISEARCH_EXA_API_KEY: 'fixture-env-key' }),
    'en',
  );
  draft.set('language', 'zh');
  draft.selectServices(['exa']);
  draft.set('providers.exa.base_url', 'https://example.org/exa');
  const preview = setupPreviewLines(draft).join('\n');
  assert.doesNotMatch(preview, /fixture-env-key/);
  assert.deepEqual(draft.values.providers, {
    ...original.providers,
    exa: { enabled: true, base_url: 'https://example.org/exa' },
  });
  assert.equal((await applySetup(draft, path, new AbortController().signal)).exitCode, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), {
    ...original,
    language: 'zh',
    providers: {
      ...original.providers,
      exa: { enabled: true, base_url: 'https://example.org/exa' },
    },
  });
});

test('Setup returns to the previous menu item and retains draft edits until save', async (t) => {
  const root = temporary(t),
    path = join(root, 'config.json');
  const draft = new SetupDraft(
    { path, source: 'default', exists: false, values: {} },
    context(root),
    'en',
  );
  const navigate = navigateSetup(
    'language',
    'zh',
    'services',
    'search',
    'sources',
    escape,
    'skills',
    'review',
    'back',
    'language',
    'en',
    'services',
    'skills',
    'review',
    'save',
  );
  const multiple = [['exa'], ['codex'], [], []];
  let page = 0,
    inputs = 0,
    previews = 0;
  const mainFocus: string[] = [];
  const languages: string[] = [];
  const servicePages: number[] = [];
  const prompts: Prompts = {
    async select(message, options, initial, language) {
      if (message === text(language, 'setupTitle')) {
        if (!mainFocus.length) assert.equal(page, 0);
        mainFocus.push(initial);
        assert.deepEqual(
          options.map((option) => option.value),
          ['services', 'search', 'language', 'skills', 'review', 'cancel'],
        );
      }
      const section = navigate(message, options);
      if (section) return section;
      if (options.some((option) => option.value === 'custom')) {
        servicePages.push(page);
        return 'custom';
      }
      assert.fail(message);
    },
    async multi(message, _choices, initial) {
      if (isSearchSourcesPrompt(message)) {
        assert.equal(previews, 0);
        assert.deepEqual(initial, ['model']);
        return ['exa'];
      }
      const selected = multiple.shift()!;
      if (selected.includes('exa')) servicePages.push(page);
      return selected;
    },
    async input(_message, secret, validate) {
      servicePages.push(page);
      const value = secret ? 'fixture-new-secret' : '';
      assert.equal(validate(value), undefined);
      inputs++;
      return value;
    },
  };
  await promptSetup(
    draft,
    prompts,
    async (current) => {
      previews++;
      const lines = setupPreviewLines(current);
      assert.doesNotMatch(lines.join('\n'), /fixture-new-secret/);
      assert.equal(current.skills.length, previews === 1 ? 1 : 0);
      await assert.rejects(fs.stat(path), { code: 'ENOENT' });
      return lines;
    },
    (language) => languages.push(language),
    () => page++,
  );
  assert.equal(previews, 2);
  assert.equal(inputs, 2);
  assert.equal(servicePages.length, 4);
  assert.equal(new Set(servicePages).size, 1);
  assert.deepEqual(languages, ['zh', 'en']);
  assert.deepEqual(mainFocus, [
    'services',
    'language',
    'services',
    'search',
    'skills',
    'review',
    'language',
    'services',
    'skills',
  ]);
  assert.deepEqual(draft.values, { language: 'en', search: { providers: ['exa'] } });
  assert.deepEqual(draft.skills, []);
});

test('Setup persists explicitly chosen defaults and redacts credentials', async (t) => {
  const root = temporary(t),
    path = join(root, 'config.json');
  const draft = new SetupDraft(
    { path, source: 'default', exists: false, values: {} },
    context(root),
    'en',
  );
  draft.selectServices(['model', 'jina']);
  draft.set('language', 'en');
  draft.set('providers.model.protocol', 'responses');
  draft.set('providers.model.api_key', 'fixture-key');
  assert.doesNotMatch(draft.preview('providers.model.api_key'), /fixture-key/);
  assert.throws(() => draft.set('providers.model.api_key', '   '), { code: 'INVALID_ARGUMENT' });
  const saved = await applySetup(draft, path, new AbortController().signal);
  assert.equal(saved.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(saved), /fixture-key/);
  assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')).providers.model, {
    protocol: 'responses',
    api_key: 'fixture-key',
  });
  assert.equal(saved.result.data?.services, undefined);
});

test('Setup checks the effective classifier configuration before enabling automatic selection', async (t) => {
  const root = temporary(t);
  const path = join(root, 'config.json');
  const classifierUrl = 'https://classifier.example.org/v1';
  const env = { UNISEARCH_CLASSIFIER_BASE_URL: classifierUrl };
  const draft = new SetupDraft(
    {
      path,
      source: 'default',
      exists: false,
      values: {
        providers: { exa: { api_key: 'fixture-exa' }, tavily: { api_key: 'fixture-tavily' } },
        search: { providers: ['exa'] },
      },
    },
    context(root, env),
    'en',
  );
  const navigate = navigateSetup(
    'search',
    'routing',
    'classifier',
    'routing',
    escape,
    'review',
    'save',
  );
  const classifierInputs = [
    { secret: false, value: '' },
    { secret: true, value: 'fixture-classifier-key' },
    { secret: false, value: 'fixture-model' },
  ];
  let attempts = 0;
  const prompts: Prompts = {
    async select(message, choices, initial, _language, options) {
      const section = navigate(message, choices);
      if (section) return section;
      assert.equal(initial, 'false');
      assert.ok(options?.validate);
      const error = options.validate('true');
      if (attempts++ === 0) {
        assert.ok(error);
        throw new PromptBack();
      }
      assert.equal(error, undefined);
      return 'true';
    },
    async multi() {
      assert.fail('Other sections are skipped when configuring automatic selection');
    },
    async input(_message, secret, validate) {
      const next = classifierInputs.shift();
      assert.ok(next);
      assert.equal(secret, next.secret);
      assert.equal(validate(next.value), undefined);
      return next.value;
    },
  };

  await promptSetup(
    draft,
    prompts,
    (current) => {
      const lines = setupPreviewLines(current);
      assert.doesNotMatch(lines.join('\n'), /fixture-classifier-key/);
      return lines;
    },
    () => {},
    () => {},
  );
  assert.equal((await applySetup(draft, path, new AbortController().signal)).exitCode, 0);
  const saved = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.deepEqual(saved.search, {
    providers: ['exa'],
    routing: {
      enabled: true,
      classifier: { api_key: 'fixture-classifier-key', model: 'fixture-model' },
    },
  });
  const automatic = prepareCombinedSearch('fixture query', {}, saved, env, 'en');
  assert.ok(automatic.sources.some((source) => source.provider === 'tavily'));
  assert.equal(automatic.routing?.baseUrl, classifierUrl);
  assert.equal(automatic.routing.model, 'fixture-model');
});

test('Custom model setup preselects xAI for new tools and keeps saved or pending tools', async (t) => {
  const root = temporary(t);
  const path = join(root, 'config.json');
  for (const [choice, original, expected, useShortcut = false] of [
    ['none', {}, []],
    ['xai', {}, ['web_search', 'x_search']],
    ['none', {}, ['web_search', 'x_search'], true],
    [
      'keep',
      { tools: [{ type: 'custom_search', limit: 3 }] },
      [{ type: 'custom_search', limit: 3 }],
    ],
    ['none', { tools: ['web_search', 'x_search'] }, []],
  ] as const) {
    const draft = new SetupDraft(
      { path, source: 'default', exists: false, values: { providers: { model: original } } },
      context(root),
      'en',
    );
    const navigate = navigateSetup(
      'language',
      'en',
      'services',
      ...(useShortcut ? ['services'] : []),
      'services',
      'review',
      'save',
    );
    const urls = useShortcut ? ['custom', 'xai', 'custom'] : ['custom', 'custom'];
    let toolsPrompts = 0;
    const prompts: Prompts = {
      async select(message, options, initial) {
        const section = navigate(message, options);
        if (section) return section;
        if (options.some((option) => option.value === 'none')) {
          const hasCurrentTools = 'tools' in original || toolsPrompts > 0;
          assert.deepEqual(
            options.map((option) => option.value),
            [...(hasCurrentTools ? ['keep'] : []), 'xai', 'none'],
          );
          assert.equal(initial, hasCurrentTools ? 'keep' : 'xai');
          toolsPrompts++;
          return toolsPrompts === 1 ? choice : initial;
        }
        if (options.some((option) => option.value === 'custom')) return urls.shift()!;
        if (options.some((option) => option.value === 'responses')) return initial;
        assert.fail(message);
      },
      async multi() {
        return ['model'];
      },
      async input() {
        return '';
      },
    };
    await promptSetup(
      draft,
      prompts,
      setupPreviewLines,
      () => {},
      () => {},
    );
    assert.equal((await applySetup(draft, path, new AbortController().signal)).exitCode, 0);
    const saved = JSON.parse(await fs.readFile(path, 'utf8'));
    assert.deepEqual(saved.providers.model.tools, expected);
    assert.equal(saved.providers.model.protocol, undefined);
  }
});

test('Setup preselects effective choices and preserves existing sources when confirmed', async (t) => {
  const root = temporary(t),
    path = join(root, 'config.json');
  for (const [source, language, expectedProtocol, expectedRestPlatform, expectedMcpPlatform] of [
    ['default', 'zh', 'responses', 'bigmodel', 'bigmodel'],
    ['config', 'en', 'chat-completions', 'zai', 'zai'],
    ['environment', 'en', 'chat-completions', 'bigmodel', 'zai'],
  ] as const) {
    const original = {
      search: { providers: ['tavily', 'model'] },
      providers: {
        model: {
          api_key: 'fixture-existing-model-key',
          base_url: source === 'config' ? 'https://api.x.ai/v1' : 'https://example.org/v1',
          model: { id: 'fixture-model' },
          ...(source === 'config' ? { protocol: 'chat-completions' } : {}),
        },
        zhipu: source === 'default' ? {} : { platform: 'zai' },
        'zhipu-mcp': source === 'config' ? { platform: 'zai' } : {},
      },
    };
    const env =
      source === 'environment'
        ? {
            UNISEARCH_MODEL_PROTOCOL: 'chat-completions',
            UNISEARCH_ZHIPU_PLATFORM: 'bigmodel',
            UNISEARCH_ZHIPU_MCP_PLATFORM: 'zai',
          }
        : {};
    const draft = new SetupDraft(
      { path, source: 'default', exists: true, values: original },
      context(root, env),
      language,
    );
    const navigate = navigateSetup(
      'services',
      'search',
      'sources',
      escape,
      'language',
      language,
      'review',
      'save',
    );
    const selections: string[] = [];
    const inputs: string[] = [];
    const prompts: Prompts = {
      async select(message, choices, initial) {
        const section = navigate(message, choices);
        if (section) return section;
        if (choices.some((choice) => choice.value === 'keep')) return 'keep';
        if (choices.some((choice) => choice.value === 'custom')) return initial;
        const protocol = choices[0].value === 'responses';
        assert.deepEqual(
          choices.map((choice) => choice.value),
          protocol ? ['responses', 'chat-completions'] : ['bigmodel', 'zai'],
        );
        selections.push(initial);
        return initial;
      },
      async multi(message, choices, initial) {
        if (isSearchSourcesPrompt(message)) {
          assert.deepEqual(initial, ['tavily', 'model']);
          return initial;
        }
        assert.deepEqual(
          choices.map((choice) => choice.value),
          [
            'model',
            'exa',
            'tavily',
            'firecrawl',
            'ctx7',
            'jina',
            'zhipu',
            'zhipu-mcp',
            'anysearch',
            'tinyfish',
            'deepseek',
          ],
        );
        return ['zhipu-mcp', 'model', 'zhipu'];
      },
      async input(message, _secret, validate, _language, placeholder) {
        assert.equal(validate(''), undefined);
        assert.doesNotMatch(message, /fixture-existing-model-key/);
        assert.doesNotMatch(placeholder ?? '', /fixture-existing-model-key/);
        if (placeholder) inputs.push(placeholder);
        return '';
      },
    };
    await promptSetup(
      draft,
      prompts,
      setupPreviewLines,
      () => {},
      () => {},
    );
    assert.deepEqual(
      selections,
      [expectedProtocol, expectedRestPlatform, expectedMcpPlatform],
      source,
    );
    assert.ok(inputs.includes('fixt•••-key'));
    assert.ok(inputs.includes('fixture-model'));
    assert.deepEqual(draft.values, { ...original, language });
    assert.deepEqual(
      draft.changes().map((change) => change.key),
      ['language'],
    );
  }
});

test('XAI setup saves the official URL and tools and retains model, effort and choices when editing', async (t) => {
  const root = temporary(t);
  const draft = new SetupDraft(
    { path: join(root, 'config.json'), source: 'default', exists: false, values: {} },
    context(root, { UNISEARCH_MODEL_ID: 'environment-model' }),
    'en',
  );
  let previews = 0;
  const modelInputs = ['fixture-model', 'high'];
  const modelPlaceholders: (string | undefined)[] = [];
  const navigate = navigateSetup(
    'language',
    'en',
    'services',
    'review',
    'back',
    'services',
    'review',
    'save',
  );
  const prompts: Prompts = {
    async select(message, choices, initial) {
      const section = navigate(message, choices);
      if (section) return section;
      if (choices.some((choice) => choice.value === 'keep'))
        assert.fail('The xAI shortcut must skip tool selection');
      if (choices.some((choice) => choice.value === 'responses')) return initial;
      if (choices.some((choice) => choice.value === 'custom')) {
        if (choices.some((choice) => choice.value === 'xai')) {
          assert.equal(initial, 'xai');
          return previews === 0 ? 'xai' : 'current';
        }
        return initial;
      }
      const selected = choices[1].value;
      assert.equal(initial, previews === 0 ? choices[0].value : selected);
      return selected;
    },
    async multi() {
      return ['model', 'zhipu', 'zhipu-mcp'];
    },
    async input(_message, secret, validate, _language, placeholder) {
      if (secret) return '';
      const value = previews === 0 ? modelInputs.shift() : '';
      assert.ok(value !== undefined);
      assert.equal(validate(value), undefined);
      if (previews > 0) modelPlaceholders.push(placeholder);
      return value;
    },
  };
  await promptSetup(
    draft,
    prompts,
    (current) => {
      const lines = setupPreviewLines(current);
      assert.ok(
        lines.some(
          (line) =>
            line.includes('providers.model.model.id') && line.includes('UNISEARCH_MODEL_ID'),
        ),
      );
      previews++;
      return lines;
    },
    () => {},
    () => {},
  );
  assert.equal(previews, 2);
  assert.deepEqual(modelPlaceholders, ['fixture-model', 'high']);
  assert.deepEqual(draft.values, {
    language: 'en',
    providers: {
      model: {
        base_url: 'https://api.x.ai/v1',
        tools: ['web_search', 'x_search'],
        model: { id: 'fixture-model', effort: 'high' },
      },
      zhipu: { platform: 'zai' },
      'zhipu-mcp': { platform: 'zai' },
    },
  });
});

test('Setup credential previews mask valid keys and hide invalid values', (t) => {
  const root = temporary(t);
  for (const [key, mask] of [
    ['shortkey', '••••••••'],
    ['short-key', 'sh•••ey'],
    ['fixture-key1', 'fi•••y1'],
    ['fixture-key12', 'fixt•••ey12'],
    ['invalid credential', undefined],
  ] as const) {
    const draft = new SetupDraft(
      {
        path: join(root, 'config.json'),
        source: 'default',
        exists: true,
        values: { providers: { exa: { api_key: key } } },
      },
      context(root),
      'en',
    );
    const preview = draft.preview('providers.exa.api_key');
    if (mask) assert.ok(preview.endsWith(mask));
    else assert.ok(draft.current('providers.exa.api_key').problems.length);
    assert.ok(!preview.includes(key));
    draft.selectServices(['exa']);
    assert.ok(!setupPreviewLines(draft).join('\n').includes(key));
  }
});

test('Custom URL inputs preserve defaults on Enter and save only the edited Jina Reader URL', async (t) => {
  const root = temporary(t);
  const original = { providers: { jina: { reader_url: 'https://example.org/saved-reader' } } };
  const env = { UNISEARCH_JINA_SEARCH_URL: 'https://example.org/environment-search' };
  const customUrl = 'https://example.org/custom-reader';
  const draft = new SetupDraft(
    { path: join(root, 'config.json'), source: 'default', exists: true, values: original },
    context(root, env),
    'zh',
  );
  const urls: string[] = [];
  const navigate = navigateSetup('services', 'review', 'save');
  const prompts: Prompts = {
    async select(message, choices, initial) {
      const section = navigate(message, choices);
      if (section) return section;
      if (choices.some((choice) => choice.value === 'custom')) {
        assert.equal(initial, 'current');
        if (message.includes('Firecrawl')) {
          return 'custom';
        }
        urls.push(message);
        return urls.length === 1 ? 'current' : 'custom';
      }
      assert.fail(message);
    },
    async multi() {
      return ['jina', 'firecrawl'];
    },
    async input(message, secret, validate, _language, placeholder) {
      if (message.includes('Firecrawl') && !secret) {
        assert.equal(placeholder, 'https://api.firecrawl.dev/v2');
        assert.equal(validate(''), undefined);
        return '';
      }
      assert.equal(validate(secret ? '' : customUrl), undefined);
      return secret ? '' : customUrl;
    },
  };
  await promptSetup(
    draft,
    prompts,
    setupPreviewLines,
    () => {},
    () => {},
  );
  assert.equal(urls.length, 2);
  assert.match(urls[0], /UNISEARCH_JINA_SEARCH_URL/);
  assert.match(urls[1], /saved-reader/);
  assert.deepEqual(draft.values, {
    providers: { jina: { reader_url: customUrl } },
  });
  assert.equal(draft.current('search.providers').source, 'default');
  assert.deepEqual(draft.current('search.providers').value, ['model']);
  assert.deepEqual(
    draft.changes().map((change) => change.key),
    ['providers.jina.reader_url'],
  );
});

test('Save failure prevents Skill writes; successful config and failed installation is partial; cancellation preserves saved state', async (t) => {
  const root = temporary(t),
    path = join(root, 'config.json'),
    source = join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(join(source, 'SKILL.md'), 'skill');
  const draft = new SetupDraft(
    { path, source: 'default', exists: false, values: {} },
    context(root),
    'en',
  );
  draft.set('language', 'en');
  draft.skills = ['codex'];
  const beforeSave = new AbortController();
  beforeSave.abort();
  const cancelledBeforeSave = await applySetup(draft, path, beforeSave.signal, source);
  const cancellationOutput = capture();
  assert.equal(
    await display(
      cancelledBeforeSave,
      { format: 'text', language: 'en', renderText: renderSetup },
      cancellationOutput,
    ),
    130,
  );
  assert.equal(cancellationOutput.out, '');
  assert.ok(cancellationOutput.err.trim());
  const abort = new AbortController();
  const failure = await applySetup(draft, root, abort.signal, source);
  assert.equal(failure.exitCode, 5);
  assert.equal(failure.result.data?.config.state, 'not_saved');
  await assert.rejects(fs.stat(draft.targets()[0].path), { code: 'ENOENT' });
  await fs.mkdir(join(root, '.codex', 'skills'), { recursive: true });
  await fs.writeFile(draft.targets()[0].path, 'not a directory');
  const partial = await applySetup(draft, path, abort.signal, source);
  assert.equal(partial.exitCode, 6);
  assert.equal(partial.result.error?.code, 'PARTIAL_FAILURE');
  assert.equal(partial.result.data?.config.state, 'saved');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args);
    abort.abort();
  });
  draft.set('language', 'zh');
  const cancelled = await applySetup(draft, path, abort.signal, source);
  assert.equal(cancelled.exitCode, 130);
  assert.equal(cancelled.result.data?.config.state, 'saved');
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).language, 'zh');
  const output = capture();
  assert.equal(
    await display(cancelled, { format: 'text', language: 'zh', renderText: renderSetup }, output),
    130,
  );
  assert.equal(output.out, '');
  const ending = stripVTControlCharacters(output.err).trimEnd().split('\n');
  assert.ok(ending.every((line) => /^[│▲└]/.test(line)));
  assert.ok(ending.at(-1)!.startsWith('└'));
  assert.ok(!output.err.includes(root));
});

test('Setup no-op preserves mtime and non-TTY returns usage error', async (t) => {
  const root = temporary(t),
    path = join(root, 'config.json');
  await fs.writeFile(path, '{"language":"en"}');
  const draft = new SetupDraft(
    { path, source: 'default', exists: true, values: { language: 'en' } },
    context(root),
    'en',
  );
  draft.set('language', 'en');
  const before = await fs.stat(path);
  const result = await applySetup(draft, path, new AbortController().signal);
  assert.deepEqual(result.result.data, { config: { path, state: 'unchanged' } });
  assert.equal((await fs.stat(path)).mtimeMs, before.mtimeMs);
  const cliChannels = capture();
  assert.equal(
    await createCli('test', {
      config: context(root, { UNISEARCH_LANG: 'en' }),
      channels: cliChannels,
    }).run(['setup']),
    2,
  );
  assert.equal(cliChannels.out, '');
  assert.ok(cliChannels.err.trim());
  const prompts: Prompts = {
    async select() {
      throw new AppError('CANCELLED', 'cancelled');
    },
    async multi() {
      return [];
    },
    async input() {
      return '';
    },
  };
  await assert.rejects(
    promptSetup(
      draft,
      prompts,
      setupPreviewLines,
      () => {},
      () => {},
    ),
    (e: unknown) => e instanceof AppError && e.code === 'CANCELLED',
  );
});
