import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { SetupDraft, promptSetup, applySetup, setupFields } from '../src/setup.js';
import { renderSetup, renderSetupPreview } from '../src/output/setup.js';
import { display } from '../src/output/index.js';
import { AppError } from '../src/errors.js';
import { providers, fieldAt } from '../src/config/fields.js';
import { capture, context, temporary } from './helpers.js';
import { createCli } from '../src/cli/program.js';
import type { Prompts } from '../src/cli/prompts.js';
import { operationName } from '../src/i18n/providers.js';

test('setup saved configuration and Codex Skill are usable by new CLI processes', async (t) => {
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
  const selections = ['en', 'save'];
  const multiple = [['exa'], ['codex']];
  const prompts: Prompts = {
    async select(_message, choices) {
      if (choices.some((choice) => choice.value === 'custom')) return 'custom';
      return selections.shift()!;
    },
    async multi() {
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
    async (current) => {
      const preview = stripVTControlCharacters(renderSetupPreview(current));
      assert.doesNotMatch(
        preview,
        /fixture-setup-key|local configuration|missing configuration|^- /m,
      );
      assert.match(preview, /Skills installation locations/);
      assert.ok(preview.includes(`Codex: ${join(root, '.codex', 'skills', 'unisearch')}`));
    },
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
  ]);
  assert.doesNotMatch(JSON.stringify(saved), /fixture-setup-key/);
  const output = capture();
  assert.equal(
    await display(saved, { format: 'text', language: 'en', renderText: renderSetup }, output),
    0,
  );
  assert.equal(output.err, '');
  assert.doesNotMatch(output.out, /providers\.|Skill:|local configuration/);
  assert.match(stripVTControlCharacters(output.out), /\n└  Skills installed\n$/);

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
  const skills = await execFileAsync(
    process.execPath,
    [cli, 'skills', 'status', '--targets', 'codex'],
    { cwd: root, env },
  );
  assert.match(skills.stdout, /Codex: current/);
  assert.ok(skills.stdout.includes(join(root, '.codex', 'skills', 'unisearch')));
  assert.deepEqual(calls, []);
  assert.deepEqual(await runCli(['exa', 'search', 'setup integration', '--limit', '1']), {
    provider: 'exa',
    results,
  });
  assert.deepEqual(calls, [
    {
      path: '/setup/search',
      key: 'fixture-setup-key',
      body: {
        query: 'setup integration',
        numResults: 1,
        type: 'auto',
        contents: { text: false, highlights: false },
      },
    },
  ]);
});

test('setup preserves existing defaults and environment credentials; service selection enables only selected saved false values', async (t) => {
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
  const preview = renderSetupPreview(draft);
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

test('prompt edit restarts at language, retains pending values, discards deselected edits, and never writes before save', async (t) => {
  const root = temporary(t),
    path = join(root, 'config.json');
  const draft = new SetupDraft(
    { path, source: 'default', exists: false, values: {} },
    context(root),
    'en',
  );
  const choices = ['zh', 'edit', 'en', 'save'];
  const multiple = [['exa'], ['codex'], [], []];
  let inputs = 0,
    previews = 0;
  const messages: string[] = [];
  const prompts: Prompts = {
    async select(message, options) {
      messages.push(message);
      if (options.some((option) => option.value === 'custom')) return 'custom';
      return choices.shift()!;
    },
    async multi() {
      return multiple.shift()!;
    },
    async input(message, secret, validate) {
      messages.push(message);
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
      assert.doesNotMatch(renderSetupPreview(current), /fixture-new-secret/);
      await assert.rejects(fs.stat(path));
    },
    (language) => assert.ok(['en', 'zh'].includes(language)),
  );
  assert.equal(previews, 2);
  assert.equal(inputs, 2);
  assert.ok(messages.includes('Interface language'));
  assert.ok(messages.includes('界面语言'));
  assert.deepEqual(draft.values, { language: 'en' });
  assert.deepEqual(draft.skills, []);
});

test('all service connection fields use common definitions; explicit default selections persist and keys stay redacted', async (t) => {
  const root = temporary(t),
    path = join(root, 'config.json');
  const draft = new SetupDraft(
    { path, source: 'default', exists: false, values: {} },
    context(root),
    'en',
  );
  for (const provider of providers)
    for (const suffix of setupFields[provider])
      assert.ok(fieldAt(`providers.${provider}.${suffix}`));
  draft.selectServices(['model', 'jina']);
  draft.set('language', 'en');
  draft.set('providers.model.protocol', 'responses');
  draft.set('providers.model.api_key', 'fixture-key');
  assert.match(draft.preview('providers.model.api_key'), /pending/);
  assert.doesNotMatch(draft.preview('providers.model.api_key'), /fixture-key/);
  assert.throws(() => draft.set('providers.model.api_key', '   '));
  const saved = await applySetup(draft, path, new AbortController().signal);
  assert.equal(saved.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(saved), /fixture-key/);
  assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')).providers.model, {
    protocol: 'responses',
    api_key: 'fixture-key',
  });
  assert.equal(saved.result.data?.services, undefined);
});

test('model setup defaults new tools to xAI and preserves existing and edited choices', async (t) => {
  const root = temporary(t);
  const path = join(root, 'config.json');
  for (const [choice, original, expected, useShortcut = false] of [
    ['none', {}, undefined],
    ['xai', {}, ['web_search', 'x_search']],
    ['none', {}, ['web_search', 'x_search'], true],
    [
      'keep',
      { tools: [{ type: 'custom_search', limit: 3 }] },
      [{ type: 'custom_search', limit: 3 }],
    ],
    ['none', { tools: ['web_search'] }, []],
  ] as const) {
    const draft = new SetupDraft(
      { path, source: 'default', exists: false, values: { providers: { model: original } } },
      context(root),
      'en',
    );
    const selections = useShortcut
      ? ['en', choice, 'edit', 'en', 'edit', 'en', 'xai', 'save']
      : ['en', choice, 'edit', 'en', choice, 'save'];
    const multiple = useShortcut
      ? [['model'], [], ['model'], [], ['model'], []]
      : [['model'], [], ['model'], []];
    const urls = useShortcut ? ['custom', 'xai', 'custom'] : ['custom', 'custom'];
    let toolsPrompts = 0;
    const prompts: Prompts = {
      async select(message, options, initial) {
        if (message === 'Model search tools') {
          const hasCurrentTools = 'tools' in original || toolsPrompts > 0;
          assert.deepEqual(
            options.map((option) => option.value),
            [...(hasCurrentTools ? ['keep'] : []), 'xai', 'none'],
          );
          let expectedInitial = hasCurrentTools ? 'keep' : 'xai';
          if (toolsPrompts > 0) expectedInitial = useShortcut ? 'xai' : choice;
          assert.equal(initial, expectedInitial);
          toolsPrompts++;
          assert.deepEqual(
            options.find((option) => option.value === 'xai'),
            { value: 'xai', label: 'Enable xAI search tools' },
          );
          return selections.shift()!;
        }
        if (message.startsWith('Select Model search API URL')) return urls.shift()!;
        if (message.startsWith('Select Model search protocol')) return initial;
        return selections.shift()!;
      },
      async multi() {
        return multiple.shift()!;
      },
      async input() {
        return '';
      },
    };
    await promptSetup(
      draft,
      prompts,
      async () => {},
      () => {},
    );
    assert.equal((await applySetup(draft, path, new AbortController().signal)).exitCode, 0);
    const saved = JSON.parse(await fs.readFile(path, 'utf8'));
    assert.deepEqual(saved.providers.model.tools, expected);
    assert.equal(saved.providers.model.protocol, undefined);
  }
});

test('setup preselects effective choices and preserves existing sources when confirmed', async (t) => {
  const root = temporary(t),
    path = join(root, 'config.json');
  for (const language of ['zh', 'en'] as const) {
    for (const source of ['default', 'config', 'environment'] as const) {
      const original = {
        providers: {
          model: {
            api_key: 'fixture-existing-model-key',
            base_url: 'https://example.org/v1',
            model: { id: 'fixture-model' },
            ...(source === 'config' ? { protocol: 'chat-completions' } : {}),
          },
          zhipu: source === 'config' ? { platform: 'zai' } : {},
          'zhipu-mcp': source === 'config' ? { platform: 'zai' } : {},
        },
      };
      const env =
        source === 'environment'
          ? {
              UNISEARCH_MODEL_PROTOCOL: 'chat-completions',
              UNISEARCH_ZHIPU_PLATFORM: 'zai',
              UNISEARCH_ZHIPU_MCP_PLATFORM: 'zai',
            }
          : {};
      const draft = new SetupDraft(
        { path, source: 'default', exists: true, values: original },
        context(root, env),
        language,
      );
      let services = false;
      const selections: string[] = [];
      const inputs: string[] = [];
      const prompts: Prompts = {
        async select(message, choices, initial) {
          if (choices.some((choice) => choice.value === 'zh')) return language;
          if (choices.some((choice) => choice.value === 'save')) return 'save';
          if (choices.some((choice) => choice.value === 'keep')) return 'keep';
          if (choices.some((choice) => choice.value === 'custom')) return initial;
          assert.ok(choices.every((choice) => choice.value !== ''));
          assert.doesNotMatch(message, /providers\.|内置默认|Keep current|保持当前/);
          const protocol = choices[0].value === 'responses';
          let expected = protocol ? 'chat-completions' : 'zai';
          if (source === 'default') expected = protocol ? 'responses' : 'bigmodel';
          assert.equal(initial, expected);
          assert.deepEqual(
            choices.map((choice) => choice.label),
            protocol ? ['Responses', 'Chat Completions'] : ['BigModel', 'Z.AI'],
          );
          if (protocol)
            assert.ok(
              message.startsWith(
                language === 'zh' ? '请选择模型搜索协议' : 'Select Model search protocol',
              ),
            );
          selections.push(initial);
          return initial;
        },
        async multi(_message, choices) {
          if (services) return [];
          services = true;
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
            ],
          );
          assert.equal(choices[0].label, language === 'zh' ? '模型搜索' : 'Model search');
          assert.equal(choices[1].label, 'Exa');
          const cli = createCli('test', { config: context(root) });
          for (const choice of choices.slice(1)) {
            const command = cli.program.commands.find(
              (command) => command.name() === choice.value,
            )!;
            assert.equal(
              choice.description,
              command.commands
                .map((operation) => operationName(operation.name(), language))
                .join(language === 'zh' ? '、' : ', '),
            );
          }
          return ['zhipu-mcp', 'model', 'zhipu'];
        },
        async input(message, _secret, validate, label, placeholder) {
          assert.equal(validate(''), undefined);
          assert.equal(label, language === 'zh' ? '请输入：' : 'Enter: ');
          assert.doesNotMatch(
            message,
            /providers\.|未设置|unset|\n|明文|plaintext|fixture-existing-model-key/,
          );
          assert.doesNotMatch(placeholder ?? '', /fixture-existing-model-key/);
          if (message.includes('fixt•••-key')) assert.equal(placeholder, 'fixt•••-key');
          if (message.includes('fixture-model')) assert.equal(placeholder, 'fixture-model');
          inputs.push(message);
          return '';
        },
      };
      await promptSetup(
        draft,
        prompts,
        async () => {},
        () => {},
      );
      assert.equal(selections.length, 3);
      assert.equal(
        inputs[0],
        language === 'zh'
          ? '配置模型搜索 API Key（已配置：fixt•••-key）'
          : 'Configure Model search API Key (configured: fixt•••-key)',
      );
      assert.ok(inputs.some((message) => message.includes('fixture-model')));
      assert.ok(
        inputs.some((message) =>
          message.startsWith(
            language === 'zh' ? '配置模型搜索的模型 ID' : 'Configure Model search model ID',
          ),
        ),
      );
      assert.deepEqual(draft.values, { ...original, language });
      assert.deepEqual(
        draft.changes().map((change) => change.key),
        ['language'],
      );
    }
  }
});

test('xAI setup saves the official URL and tools and retains model, effort and choices when editing', async (t) => {
  const root = temporary(t);
  const draft = new SetupDraft(
    { path: join(root, 'config.json'), source: 'default', exists: false, values: {} },
    context(root, { UNISEARCH_MODEL_ID: 'environment-model' }),
    'en',
  );
  let previews = 0;
  let services = false;
  const prompts: Prompts = {
    async select(message, choices, initial) {
      if (choices.some((choice) => choice.value === 'zh')) return 'en';
      if (choices.some((choice) => choice.value === 'save'))
        return previews === 1 ? 'edit' : 'save';
      if (choices.some((choice) => choice.value === 'keep'))
        assert.fail('The xAI shortcut must skip tool selection');
      if (choices.some((choice) => choice.value === 'custom')) {
        if (message.startsWith('Select Model search API URL')) {
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
      services = !services;
      return services ? ['model', 'zhipu', 'zhipu-mcp'] : [];
    },
    async input(message, _secret, validate) {
      let value = '';
      if (previews === 0) {
        if (message.startsWith('Configure Model search model ID')) value = 'fixture-model';
        else if (message.includes('reasoning effort')) value = 'high';
      }
      assert.equal(validate(value), undefined);
      if (previews > 0 && message.startsWith('Configure Model search model ID'))
        assert.match(message, /fixture-model/);
      if (previews > 0 && message.includes('reasoning effort')) assert.match(message, /high/);
      return value;
    },
  };
  await promptSetup(
    draft,
    prompts,
    async (current) => {
      const preview = stripVTControlCharacters(renderSetupPreview(current));
      assert.match(
        preview
          .split('\n')
          .map((line) => line.replace(/^│  /, ''))
          .join(''),
        /overridden by environment variable UNISEARCH_MODEL_ID/,
      );
      previews++;
    },
    () => {},
  );
  assert.equal(previews, 2);
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

test('setup credential previews mask short keys and never show invalid values', async (t) => {
  const root = temporary(t);
  for (const [key, expected] of [
    ['shortkey', 'configured: ••••••••'],
    ['short-key', 'configured: sh•••ey'],
    ['fixture-key1', 'configured: fi•••y1'],
    ['fixture-key12', 'configured: fixt•••ey12'],
    ['fixture-long-secret-key', 'configured: fixt•••-key'],
    ['invalid credential', 'invalid configuration'],
  ]) {
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
    assert.equal(draft.preview('providers.exa.api_key'), expected);
    assert.equal(draft.preview('providers.model.api_key'), '');
    draft.selectServices(['exa']);
    assert.doesNotMatch(renderSetupPreview(draft), new RegExp(key));
  }
});

test('custom URL inputs preserve defaults on Enter and save only the edited Jina Reader URL', async (t) => {
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
  const inputs: string[] = [];
  let selected = false;
  const prompts: Prompts = {
    async select(message, choices, initial) {
      if (choices.some((choice) => choice.value === 'custom')) {
        assert.equal(initial, 'current');
        if (message.includes('Firecrawl')) {
          assert.equal(choices[0].label, '默认');
          return 'custom';
        }
        assert.equal(choices[0].label, '当前地址');
        urls.push(message);
        return urls.length === 1 ? 'current' : 'custom';
      }
      return initial;
    },
    async multi() {
      if (selected) return [];
      selected = true;
      return ['jina', 'firecrawl'];
    },
    async input(message, secret, validate, label, placeholder) {
      assert.equal(label, '请输入：');
      inputs.push(message);
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
    async () => {},
    () => {},
  );
  assert.deepEqual(
    urls.map((message) => message.split('（')[0]),
    ['请选择 Jina 搜索地址', '请选择 Jina 网页读取地址'],
  );
  assert.equal(inputs.filter((message) => message.includes('地址')).length, 2);
  assert.match(urls[0], /UNISEARCH_JINA_SEARCH_URL/);
  assert.match(urls[1], /已配置/);
  assert.deepEqual(draft.values, {
    language: 'zh',
    providers: { jina: { reader_url: customUrl } },
  });
  assert.deepEqual(
    draft.changes().map((change) => change.key),
    ['language', 'providers.jina.reader_url'],
  );
});

test('save failure prevents Skill writes; successful config and failed installation is partial; cancellation preserves saved state', async (t) => {
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
  assert.equal(
    stripVTControlCharacters(cancellationOutput.err),
    '│\n└  The operation was cancelled\n',
  );
  const abort = new AbortController();
  const failure = await applySetup(draft, root, abort.signal, source);
  assert.equal(failure.exitCode, 5);
  assert.equal(failure.result.data?.config.state, 'not_saved');
  await assert.rejects(fs.stat(draft.targets()[0].path));
  await fs.mkdir(join(root, '.codex', 'skills'), { recursive: true });
  await fs.writeFile(draft.targets()[0].path, 'not a directory');
  const partial = await applySetup(draft, path, abort.signal, source);
  assert.equal(partial.exitCode, 6);
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
  assert.match(output.err, /配置已保存/);
  assert.ok(!output.err.includes(root));
});

test('setup no-op preserves mtime and non-TTY returns usage error', async (t) => {
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
  assert.match(cliChannels.err, /requires stdin and stderr terminals/);
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
      async () => {},
      () => {},
    ),
    (e: unknown) => e instanceof AppError && e.code === 'CANCELLED',
  );
});
