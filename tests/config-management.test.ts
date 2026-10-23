import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createCli } from '../src/cli/program.js';
import { fields, fieldAt } from '../src/config/fields.js';
import { selectConfigPath } from '../src/config/path.js';
import { resolveField } from '../src/config/resolve.js';
import { capture, context, temporary } from './helpers.js';

function fixture(t: TestContext) {
  const root = temporary(t);
  const path = join(root, '设置 config.json');
  const env = { UNISEARCH_LANG: 'en', UNISEARCH_CONFIG_PATH: path };
  return {
    root,
    path,
    env,
    save: (value: unknown) => writeFileSync(path, JSON.stringify(value)),
    saved: () => JSON.parse(readFileSync(path, 'utf8')),
    async run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
      const channels = capture();
      const exit = await createCli('1.2.3', {
        config: context(root, { ...env, ...overrides }),
        channels,
      }).run(args);
      return { ...channels, exit };
    },
    async json(args: string[], overrides: NodeJS.ProcessEnv = {}) {
      const result = await this.run(args, overrides);
      assert.equal(result.err, '');
      return { ...result, body: JSON.parse(result.out) };
    },
  };
}

test('Configuration writes use plain confirmations and queries retain types and sources', async (t) => {
  const f = fixture(t);
  const saved = await f.run(['config', 'set', 'execution.retries', '0']);
  assert.equal(saved.exit, 0);
  assert.equal(saved.out, 'Saved execution.retries = 0\n');
  assert.equal(saved.err, '');
  assert.deepEqual(f.saved(), { execution: { retries: 0 } });
  for (const [key, value] of [
    ['providers.exa.enabled', 'false'],
    ['fetch.providers', '[]'],
    ['map.providers', '["firecrawl","tavily"]'],
  ])
    assert.equal((await f.run(['config', 'set', key, value])).exit, 0);
  const result = await f.json(['config', 'list'], {
    UNISEARCH_EXA_API_KEY: 'fixture-env-credential',
  });
  assert.equal(result.body.data.values.execution.retries, 0);
  assert.deepEqual(result.body.data.values.fetch.providers, []);
  assert.deepEqual(result.body.data.values.map.providers, ['firecrawl', 'tavily']);
  assert.deepEqual(result.body.data.values.providers.exa, {
    enabled: false,
    api_key: '[REDACTED]',
  });
  assert.equal(result.body.data.sources['providers.exa.api_key'], 'UNISEARCH_EXA_API_KEY');
  assert.equal(result.body.data.sources['execution.timeout_seconds'], undefined);
  assert.equal(result.body.data.sources['execution.retries'], 'config');
  assert.equal(Object.keys(result.body.data.values.providers).length, 1);
  const all = await f.json(['config', 'list', '--all'], {
    UNISEARCH_EXA_API_KEY: 'fixture-env-credential',
  });
  assert.equal(all.body.data.values.execution.timeout_seconds, 300);
  assert.equal(all.body.data.sources['execution.timeout_seconds'], 'default');
  assert.equal(all.body.data.values.providers.exa.api_key, '[REDACTED]');
  const duplicateAll = await f.json(['config', 'list', '--all', '--all']);
  assert.equal(duplicateAll.exit, 2);
  assert.equal(duplicateAll.body.error.details.option, '--all');
  assert.deepEqual((await f.json(['config', 'get', 'providers.exa'])).body.data, {
    key: 'providers.exa',
    value: {
      enabled: false,
      base_url: 'https://api.exa.ai',
      search: { limit: 5, search_type: 'auto' },
    },
    sources: {
      enabled: 'config',
      base_url: 'default',
      'search.limit': 'default',
      'search.search_type': 'default',
    },
  });
  assert.deepEqual((await f.json(['config', 'get', 'providers.exa.api_key'])).body.data, {
    key: 'providers.exa.api_key',
    source: 'unset',
  });
  assert.equal(Object.keys(f.saved())[0], 'providers');
  assert.ok(readFileSync(f.path, 'utf8').endsWith('\n'));
});

test('Configuration confirmations preserve dollar substitution sequences literally', async (t) => {
  const f = fixture(t);
  const key = 'providers.model.model.id';
  const value = "model-$&-$$-$`-$'";
  for (const language of ['en', 'zh']) {
    f.save({});
    const result = await f.run(['config', 'set', key, value], { UNISEARCH_LANG: language });
    assert.equal(result.exit, 0);
    assert.equal(
      result.out,
      `${language === 'zh' ? '已保存' : 'Saved'} ${key} = ${JSON.stringify(value)}\n`,
    );
    assert.equal(f.saved().providers.model.model.id, value);
  }
});

test('Service lists and saved providers share display order without reordering settings', async (t) => {
  const f = fixture(t);
  const order = [
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
  ];
  const model = {
    fallback_models: [{ id: 'backup-b' }, { id: 'backup-a' }],
    tools: ['x_search', 'web_search'],
    model: { id: 'primary' },
    enabled: false,
  };
  const original = {
    language: 'zh',
    map: { providers: ['firecrawl', 'tavily'] },
    execution: { retries: 0, timeout_seconds: 8 },
    providers: Object.fromEntries(
      order
        .toReversed()
        .map((provider) => [provider, provider === 'model' ? model : { enabled: false }]),
    ),
    fetch: { providers: ['jina', 'exa'] },
  };
  f.save(original);
  const before = readFileSync(f.path, 'utf8');
  for (const args of [
    ['config', 'list'],
    ['config', 'list', '--all'],
    ['config', 'get', 'providers'],
  ]) {
    const result = await f.json(args);
    assert.equal(result.exit, 0);
    const isProviderSection = args[1] === 'get';
    const { values, value, sources } = result.body.data;
    assert.deepEqual(Object.keys(isProviderSection ? value : values.providers), order);
    const sourceProviders = Object.keys(sources)
      .filter((path) => isProviderSection || path.startsWith('providers.'))
      .map((path) => path.split('.')[isProviderSection ? 0 : 1]);
    const sourceGroups = sourceProviders.filter(
      (provider, index) => provider !== sourceProviders[index - 1],
    );
    assert.deepEqual(sourceGroups, order);
    if (!isProviderSection)
      assert.deepEqual(Object.keys(values), ['providers', 'fetch', 'map', 'execution', 'language']);
  }
  for (const command of ['status', 'doctor']) {
    const result = await f.json([command, '--json']);
    assert.equal(result.exit, 0);
    assert.deepEqual(
      result.body.data.services.map((service: { provider: string }) => service.provider),
      order,
    );
    for (const language of ['en', 'zh']) {
      const plain = await f.run([command], { UNISEARCH_LANG: language });
      assert.equal(plain.exit, 0);
      assert.equal(plain.err, '');
      const pattern = command === 'status' ? /^([a-z0-9-]+)[:：]/gm : /^.*\(([a-z0-9-]+)\)[:：]/gm;
      assert.deepEqual(
        [...plain.out.matchAll(pattern)].map((match) => match[1]),
        order,
      );
    }
  }
  const help = await f.run(['--help']);
  assert.equal(help.exit, 0);
  assert.deepEqual(
    [...help.out.matchAll(/^ {2}([a-z][a-z0-9-]*)\b/gm)]
      .map((match) => match[1])
      .filter((provider) => order.includes(provider)),
    order.filter((provider) => provider !== 'model'),
  );
  assert.equal(readFileSync(f.path, 'utf8'), before);
  assert.equal((await f.run(['config', 'set', 'execution.retries', '0'])).exit, 0);
  assert.equal(readFileSync(f.path, 'utf8'), before);

  assert.equal((await f.run(['config', 'set', 'execution.retries', '1'])).exit, 0);
  const saved = f.saved();
  assert.deepEqual(Object.keys(saved.providers), order);
  assert.deepEqual(Object.keys(saved), ['providers', 'language', 'map', 'execution', 'fetch']);
  assert.deepEqual(Object.keys(saved.providers.model), Object.keys(model));
  assert.deepEqual(saved, { ...original, execution: { retries: 1, timeout_seconds: 8 } });
});

test('Provider sorting preserves unrelated invalid settings during repair', async (t) => {
  const f = fixture(t);
  const original = JSON.parse(
    '{"unknown":{"enabled":true},"exa":"invalid-parent","__proto__":{"enabled":false},"model":{"enabled":false}}',
  );
  f.save({ providers: original });
  assert.equal((await f.run(['config', 'set', 'execution.retries', '0'])).exit, 0);
  const savedProviders = f.saved().providers;
  assert.deepEqual(Object.keys(savedProviders), ['model', 'exa', 'unknown', '__proto__']);
  assert.deepEqual(savedProviders, original);
  assert.equal((await f.json(['config', 'list'])).exit, 3);
  assert.equal(({} as Record<string, unknown>).enabled, undefined);
});

test('Declared credential and stream environment mappings preserve types and redact secrets', async (t) => {
  const f = fixture(t);
  f.save({});
  for (const field of fields.filter(
    (field) =>
      field.path.startsWith('providers.') &&
      (field.kind === 'credential' ||
        (field.kind === 'boolean' && field.environment !== undefined)),
  )) {
    assert.ok(field.environment);
    const value = field.kind === 'credential' ? 'fictional-credential' : 'false';
    const result = await f.json(['config', 'get', field.path], { [field.environment]: value });
    assert.equal(result.exit, 0);
    assert.equal(result.body.data.source, field.environment);
    assert.equal(result.body.data.value, field.kind === 'credential' ? '[REDACTED]' : false);
    assert.doesNotMatch(result.out, /fictional-credential/);
  }
  const ignored = await f.json(['config', 'list'], {
    UNISEARCH_UNKNOWN: 'secret',
  });
  assert.equal(ignored.body.data.values.providers, undefined);
  assert.equal(readFileSync(f.path, 'utf8'), '{}');
});

test('Invalid CLI literals use stderr while query validation uses JSON without leaking values', async (t) => {
  const f = fixture(t);
  f.save({});
  for (const [key, invalid] of [
    ['execution.retries', '-1'],
    ['execution.retries', '01'],
    ['execution.retries', '1e2'],
    ['execution.retries', '+1'],
    ['execution.retries', '1.0'],
    ['execution.retries', ' 1'],
    ['execution.retries', '9007199254740992'],
    ['execution.timeout_seconds', '0'],
    ['execution.fallback', 'FALSE'],
    ['providers.exa.api_key', ''],
    ['providers.exa.api_key', 'secret with spaces'],
    ['fetch.providers', 'broken-secret-json'],
    ['fetch.providers', '["secret-provider"]'],
    ['fetch.providers', '["ctx7"]'],
    ['map.providers', '["tavily","tavily"]'],
    ['language', 'unsupported-secret-language'],
  ]) {
    const result = await f.run(['config', 'set', key, invalid]);
    assert.equal(result.exit, 2, key);
    assert.equal(result.out, '');
    assert.match(result.err, /^Error:/);
    assert.doesNotMatch(result.err, /secret|\[INVALID_ARGUMENT\]/);
    assert.equal(readFileSync(f.path, 'utf8'), '{}');
  }
  for (const [environment, value] of [
    ['UNISEARCH_EXA_API_KEY', ''],
    ['UNISEARCH_MODEL_STREAM', 'yes'],
    ['UNISEARCH_RETRIES', '2.0'],
    ['UNISEARCH_TIMEOUT_SECONDS', ''],
  ]) {
    const result = await f.json(['config', 'list'], { [environment]: value });
    assert.equal(result.exit, 3);
    assert.equal(result.body.error.details.environment, environment);
    assert.equal(result.body.data, undefined);
  }
  f.save({ execution: { retries: '2', timeout_seconds: 1.5 } });
  const bad = await f.json(['config', 'get', 'execution']);
  assert.equal(bad.exit, 3);
  assert.equal(bad.body.error.details.causes.length, 2);
  f.save({ execution: { retries: 2e1 } });
  assert.equal((await f.json(['config', 'get', 'execution.retries'])).body.data.value, 20);
  writeFileSync(f.path, '{"execution":{"retries":1e400}}');
  assert.equal((await f.run(['config', 'set', 'providers.exa.enabled', 'true'])).exit, 3);
  assert.equal(readFileSync(f.path, 'utf8'), '{"execution":{"retries":1e400}}');
  assert.equal((await f.run(['config', 'set', 'execution.retries', '2'])).exit, 0);
});

test('Queries validate shadowed saved settings while operations use effective settings', async (t) => {
  const f = fixture(t);
  f.save({
    providers: { model: 'invalid-secret', exa: { api_key: '' } },
    execution: { retries: 0 },
  });
  assert.equal((await f.json(['config', 'get', 'execution'])).exit, 0);
  const result = await f.json(['config', 'get', 'providers.exa'], {
    UNISEARCH_EXA_API_KEY: 'fixture-valid',
  });
  assert.equal(result.exit, 3);
  assert.equal(result.body.error.details.source, 'config');
  assert.doesNotMatch(result.out, /invalid-secret/);
  const resolved = resolveField(
    f.saved(),
    { UNISEARCH_EXA_API_KEY: 'fixture-valid' },
    fieldAt('providers.exa.api_key'),
  );
  assert.equal(resolved.value, 'fixture-valid');
  assert.deepEqual(resolved.problems, []);
  assert.equal((await f.run(['config', 'set', 'providers.exa.api_key', 'fixture-valid'])).exit, 0);
  assert.equal(f.saved().providers.model, 'invalid-secret');
  assert.equal((await f.json(['config', 'get', 'providers.exa'])).exit, 0);
  assert.equal((await f.json(['config', 'list'])).exit, 3);
});

test('Repairs preserve unrelated fields, reject malformed parents and remove unknown own properties', async (t) => {
  const f = fixture(t);
  f.save({
    providers: { exa: 'bad-parent-secret' },
    secretUnknown: { value: 'secret' },
    execution: {},
  });
  assert.equal((await f.run(['config', 'set', 'providers.exa.enabled', 'true'])).exit, 3);
  assert.equal(f.saved().providers.exa, 'bad-parent-secret');
  assert.equal((await f.run(['config', 'set', 'execution.retries', '0'])).exit, 0);
  assert.equal((await f.run(['config', 'unset', 'providers.exa'])).exit, 0);
  assert.equal(f.saved().providers, undefined);
  const removed = await f.run(['config', 'unset', 'secretUnknown']);
  assert.equal(removed.exit, 0);
  assert.equal(removed.out, 'Removed the specified unrecognized configuration field\n');
  assert.doesNotMatch(removed.out, /secretUnknown|secret/);
  for (const args of [
    ['get', 'secretUnknown'],
    ['set', 'providers.exa.secret-key', 'secret'],
    ['unset', 'constructor'],
    ['unset', ''],
  ]) {
    const result = await f.run(['config', ...args]);
    assert.equal(result.exit, 2);
    assert.doesNotMatch(result.out + result.err, /secretUnknown|secret-key|constructor|"secret"/);
  }
  writeFileSync(f.path, '{"__proto__":{"polluted":"secret"},"execution.retries":"secret"}');
  const invalid = await f.json(['config', 'list']);
  assert.equal(invalid.exit, 3);
  assert.doesNotMatch(invalid.out, /__proto__|polluted|secret|execution.retries/);
  assert.equal((await f.run(['config', 'unset', '__proto__'])).exit, 0);
  assert.equal(Object.hasOwn(f.saved(), '__proto__'), false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('Environment override confirmations report saved facts and invalid effective environment', async (t) => {
  const f = fixture(t);
  const result = await f.run(['config', 'set', 'execution.retries', '2'], {
    UNISEARCH_RETRIES: 'secret-invalid',
  });
  assert.equal(result.exit, 0);
  assert.match(result.out, /^Saved execution.retries = 2\n/);
  assert.match(result.out, /UNISEARCH_RETRIES.*decimal|UNISEARCH_RETRIES.*nonnegative/);
  assert.match(result.out, /Correct or remove this environment variable/);
  assert.doesNotMatch(result.out, /secret-invalid/);
  assert.deepEqual(f.saved(), { execution: { retries: 2 } });
  const unset = await f.run(['config', 'unset', 'execution'], {
    UNISEARCH_RETRIES: '3',
    UNISEARCH_FALLBACK: 'false',
  });
  assert.equal(unset.exit, 0);
  assert.match(unset.out, /Removed execution section/);
  assert.match(unset.out, /UNISEARCH_RETRIES/);
  assert.match(unset.out, /UNISEARCH_FALLBACK/);
  assert.deepEqual(f.saved(), {});
});

test('Default and explicitly missing configurations retain distinct read and create behavior', async (t) => {
  const f = fixture(t);
  const explicit = join(f.root, 'private', 'nested', 'config.json');
  for (const args of [
    ['config', 'list'],
    ['config', 'get', 'language'],
    ['config', 'unset', 'language'],
    ['status', '--json'],
  ]) {
    const result = await f.run(args, { UNISEARCH_CONFIG_PATH: explicit });
    assert.equal(result.exit, 3);
    if (args[1] === 'unset') {
      assert.equal(result.out, '');
      assert.match(result.err, /does not exist/);
    } else assert.equal(JSON.parse(result.out).error.code, 'CONFIG_NOT_FOUND');
  }
  const path = await f.run(['config', 'path'], {
    UNISEARCH_CONFIG_PATH: explicit,
    UNISEARCH_LANG: undefined,
  });
  assert.equal(path.exit, 0);
  assert.equal(path.out, explicit + '\n');
  const set = await f.run(['config', 'set', 'execution.retries', '2'], {
    UNISEARCH_CONFIG_PATH: explicit,
    UNISEARCH_LANG: undefined,
    LC_ALL: 'en_US.UTF-8',
  });
  assert.equal(set.exit, 0);
  assert.deepEqual(JSON.parse(readFileSync(explicit, 'utf8')), { execution: { retries: 2 } });
  if (process.platform !== 'win32') {
    assert.equal(statSync(explicit).mode & 0o777, 0o600);
    for (const path of [join(f.root, 'private'), join(f.root, 'private', 'nested')])
      assert.equal(statSync(path).mode & 0o777, 0o700);
  }
  const defaultPath = selectConfigPath(context(f.root)).path;
  const empty = await f.json(['config', 'list'], {
    UNISEARCH_CONFIG_PATH: undefined,
    UNISEARCH_LANG: undefined,
    LC_ALL: 'en_US.UTF-8',
  });
  assert.equal(empty.exit, 0);
  assert.deepEqual(empty.body, { status: 'success', data: { values: {} } });
  const environmentOnly = await f.json(['config', 'list'], {
    UNISEARCH_CONFIG_PATH: undefined,
    UNISEARCH_LANG: undefined,
    UNISEARCH_EXA_API_KEY: 'fixture-env-key',
    UNISEARCH_RETRIES: '2',
  });
  assert.deepEqual(environmentOnly.body.data, {
    values: { providers: { exa: { api_key: '[REDACTED]' } }, execution: { retries: 2 } },
    sources: {
      'providers.exa.api_key': 'UNISEARCH_EXA_API_KEY',
      'execution.retries': 'UNISEARCH_RETRIES',
    },
  });
  assert.equal(existsSync(defaultPath), false);
  assert.match(
    (await f.run(['config', 'unset', 'execution.retries'], { UNISEARCH_CONFIG_PATH: undefined }))
      .out,
    /no change needed/,
  );
  assert.equal(existsSync(defaultPath), false);
  assert.equal(
    (await f.run(['config', 'set', 'execution.retries', '2'], { UNISEARCH_CONFIG_PATH: undefined }))
      .exit,
    0,
  );
  assert.ok(existsSync(defaultPath));
});

test('No-op mutations preserve files and permissions and final removal saves an empty object', async (t) => {
  const f = fixture(t);
  f.save({ execution: { retries: 2 } });
  const before = statSync(f.path, { bigint: true });
  assert.match((await f.run(['config', 'set', 'execution.retries', '2'])).out, /no change needed/);
  assert.match((await f.run(['config', 'unset', 'providers.exa'])).out, /no change needed/);
  const after = statSync(f.path, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
  assert.deepEqual(readdirSync(f.root), ['设置 config.json']);
  assert.equal((await f.run(['config', 'unset', 'execution.retries'])).exit, 0);
  assert.equal(readFileSync(f.path, 'utf8'), '{}\n');
  const existingMode = statSync(f.root).mode & 0o777;
  await f.run(['config', 'set', 'execution.retries', '2']);
  assert.equal(statSync(f.root).mode & 0o777, existingMode);
});

test('Path bypasses broken files and language repair uses the original call language', async (t) => {
  const f = fixture(t);
  writeFileSync(f.path, '{broken-secret');
  assert.equal((await f.run(['config', 'path'], { UNISEARCH_LANG: undefined })).out, f.path + '\n');
  const broken = await f.run(['config', 'set', 'execution.retries', '2']);
  assert.equal(broken.exit, 3);
  assert.equal(broken.out, '');
  assert.match(broken.err, /UTF-8 JSON object/);
  assert.equal(readFileSync(f.path, 'utf8'), '{broken-secret');
  f.save({ language: 'secret-invalid' });
  assert.equal(
    (await f.run(['config', 'set', 'language', 'zh'], { UNISEARCH_LANG: undefined })).exit,
    3,
  );
  assert.equal((await f.run(['config', 'set', 'language', 'zh'])).exit, 0);
  assert.equal(f.saved().language, 'zh');
  const changed = await f.run(['config', 'set', 'language', 'en'], { UNISEARCH_LANG: undefined });
  assert.match(changed.out, /已保存/);
  assert.equal(f.saved().language, 'en');
  const directory = join(f.root, 'directory');
  mkdirSync(directory);
  assert.equal(
    (await f.run(['config', 'set', 'execution.retries', '2'], { UNISEARCH_CONFIG_PATH: directory }))
      .exit,
    3,
  );
});

test('Credential arguments, queries, confirmations and rejected options never expose secrets', async (t) => {
  const f = fixture(t);
  const secret = 'fixture-secret-never-display';
  const saved = await f.run(['config', 'set', 'providers.exa.api_key', secret]);
  assert.equal(saved.exit, 0);
  assert.match(saved.out, /\[REDACTED\]/);
  assert.equal(f.saved().providers.exa.api_key, secret);
  for (const args of [
    ['config', 'list'],
    ['config', 'get', 'providers.exa'],
    ['config', 'set', 'providers.exa.api_key', secret],
  ]) {
    const result = await f.run(args);
    assert.equal(result.exit, 0);
    assert.doesNotMatch(result.out + result.err, /fixture-secret-never-display/);
    assert.match(result.out, /\[REDACTED\]/);
  }
  for (const tail of [[], ['--stdin'], ['--from-env', secret], [secret, secret]]) {
    const result = await f.run(['config', 'set', 'providers.exa.api_key', ...tail]);
    assert.equal(result.exit, 2);
    assert.equal(result.out, '');
    assert.doesNotMatch(result.err, /fixture-secret-never-display/);
  }
});

test('Fixed JSON queries report parameter and configuration failures as one object', async (t) => {
  const f = fixture(t);
  f.save({ execution: { retries: 0 }, fetch: { providers: [] } });
  for (const args of [
    ['config', 'list', '--format=markdown'],
    ['config', 'get'],
    ['config', 'get', 'not-known'],
  ]) {
    const result = await f.json(args);
    assert.equal(result.exit, 2);
    assert.equal(result.body.error.code, 'INVALID_ARGUMENT');
  }
  f.save({ providers: { exa: { enabled: 'bad' } } });
  const result = await f.json(['config', 'get', 'providers.exa'], { UNISEARCH_LANG: 'zh' });
  assert.equal(result.exit, 3);
  assert.equal(result.body.error.code, 'INVALID_CONFIG');
  assert.equal(result.body.error.details.field, 'providers.exa.enabled');
  assert.doesNotMatch(result.body.error.message, /[。.]$/);
});

test('Unsupported output options fail before modifying configuration or result files', async (t) => {
  const f = fixture(t);
  f.save({ execution: { retries: 1 } });
  const original = readFileSync(f.path, 'utf8');
  for (const output of [f.path, join(f.root, 'absent', 'result.json'), f.root]) {
    const result = await f.run(['config', 'set', 'execution.retries', '2', '--output', output]);
    assert.equal(result.exit, 2);
    assert.equal(result.out, '');
    assert.match(result.err, /Unknown option/);
    assert.equal(readFileSync(f.path, 'utf8'), original);
  }
});

test('Configuration symbolic links preserve links and resolve new files under linked directories', async (t) => {
  const f = fixture(t);
  f.save({ execution: { retries: 1 } });
  const link = join(f.root, 'config-link.json');
  try {
    symlinkSync(f.path, link, 'file');
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('File symlinks require Windows privileges');
      return;
    }
    throw error;
  }
  assert.equal(
    (await f.run(['config', 'set', 'execution.retries', '2'], { UNISEARCH_CONFIG_PATH: link }))
      .exit,
    0,
  );
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(f.saved().execution.retries, 2);
  const dangling = join(f.root, 'dangling');
  symlinkSync(join(f.root, 'absent.json'), dangling, 'file');
  assert.equal(
    (await f.run(['config', 'set', 'execution.retries', '2'], { UNISEARCH_CONFIG_PATH: dangling }))
      .exit,
    3,
  );
  assert.equal(lstatSync(dangling).isSymbolicLink(), true);
  assert.equal(existsSync(join(f.root, 'absent.json')), false);
  const directoryLink = join(f.root, 'directory-link');
  symlinkSync(f.root, directoryLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(
    (
      await f.run(['config', 'set', 'execution.retries', '3'], {
        UNISEARCH_CONFIG_PATH: join(directoryLink, 'new.json'),
      })
    ).exit,
    0,
  );
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'new.json'), 'utf8')), {
    execution: { retries: 3 },
  });
});

test('Unreadable files and unwritable directories fail without modifying old content', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('Requires POSIX permissions and a non-root user');
    return;
  }
  const f = fixture(t);
  f.save({});
  chmodSync(f.path, 0o000);
  try {
    assert.equal((await f.run(['config', 'set', 'execution.retries', '2'])).exit, 3);
  } finally {
    chmodSync(f.path, 0o600);
  }
  chmodSync(f.root, 0o500);
  try {
    const result = await f.run(['config', 'set', 'execution.retries', '2']);
    assert.equal(result.exit, 5);
    assert.match(result.err, /EACCES/);
    assert.equal(readFileSync(f.path, 'utf8'), '{}');
  } finally {
    chmodSync(f.root, 0o700);
  }
});

test('Write and replacement failures preserve old bytes and clean temporary files', async (t) => {
  const f = fixture(t);
  f.save({ execution: { retries: 1 } });
  const original = readFileSync(f.path, 'utf8');
  const open = fs.open;
  for (const stage of ['write', 'rename']) {
    if (stage === 'write')
      t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        t.mock.method(handle, 'writeFile', async () => {
          throw Object.assign(new Error('secret-write-error'), { code: 'ENOSPC' });
        });
        return handle;
      });
    else
      t.mock.method(fs, 'rename', async () => {
        throw Object.assign(new Error('secret-rename-error'), { code: 'EACCES' });
      });
    const result = await f.run(['config', 'set', 'execution.retries', '2']);
    assert.equal(result.exit, 5);
    assert.equal(result.out, '');
    assert.ok(result.err.includes('Operation: ' + stage));
    assert.equal(readFileSync(f.path, 'utf8'), original);
    assert.deepEqual(readdirSync(f.root), ['设置 config.json']);
    assert.doesNotMatch(result.err, /secret/);
    t.mock.restoreAll();
  }
});

test('Configuration cleanup failure retains both causes and the temporary path', async (t) => {
  const f = fixture(t);
  f.save({});
  t.mock.method(fs, 'rename', async () => {
    throw Object.assign(new Error(), { code: 'EACCES' });
  });
  t.mock.method(fs, 'unlink', async () => {
    throw Object.assign(new Error(), { code: 'EPERM' });
  });
  const result = await f.run(['config', 'set', 'execution.retries', '2']);
  assert.equal(result.exit, 5);
  assert.equal(result.out, '');
  assert.match(result.err, /Operation: cleanup/);
  assert.match(result.err.replace(/\s/g, ''), /\.unisearch-config-.*\.tmp/);
  assert.match(result.err, /Operation: rename/);
  assert.equal(readFileSync(f.path, 'utf8'), '{}');
});

test('Stdout failure reports an already completed configuration modification through stderr', async (t) => {
  const f = fixture(t);
  f.save({});
  const channels = capture();
  channels.stdout = async () => {
    throw Object.assign(new Error(), { code: 'EPIPE' });
  };
  assert.equal(
    await createCli('1.2.3', { config: context(f.root, f.env), channels }).run([
      'config',
      'set',
      'execution.retries',
      '3',
    ]),
    5,
  );
  assert.match(channels.err, /Saved execution.retries = 3/);
  assert.match(channels.err, /EPIPE/);
  assert.doesNotMatch(channels.err, /\[FILE_IO_ERROR\]|"changed"/);
  assert.equal(f.saved().execution.retries, 3);
});

test('SIGINT before replacement keeps old configuration and after replacement reports saved data', async (t) => {
  const f = fixture(t);
  f.save({ execution: { retries: 1 } });
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    process.emit('SIGINT');
    return handle;
  });
  const before = await f.run(['config', 'set', 'execution.retries', '2']);
  assert.equal(before.exit, 130);
  assert.equal(before.out, '');
  assert.match(before.err, /cancelled/);
  assert.equal(f.saved().execution.retries, 1);
  assert.deepEqual(readdirSync(f.root), ['设置 config.json']);
  t.mock.restoreAll();
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args);
    process.emit('SIGINT');
  });
  const after = await f.run(['config', 'set', 'execution.retries', '2']);
  assert.equal(after.exit, 130);
  assert.match(after.out, /Saved execution.retries = 2/);
  assert.match(after.err, /cancelled/);
  assert.equal(f.saved().execution.retries, 2);
  assert.equal(process.listenerCount('SIGINT'), 0);
});
