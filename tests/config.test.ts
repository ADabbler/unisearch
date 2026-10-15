import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectConfigPath } from '../src/config/path.js';
import { readConfig } from '../src/config/read.js';
import { AppError } from '../src/errors.js';
import { resolveLanguage, systemLanguage } from '../src/i18n/index.js';
import { context, temporary } from './helpers.js';

test('Platform paths and explicit relative paths use their documented roots', () => {
  const base = { cwd: '/work', home: () => '/home/alice', env: {} };
  assert.equal(
    selectConfigPath({ ...base, platform: 'linux' }).path,
    '/home/alice/.config/unisearch/config.json',
  );
  assert.equal(
    selectConfigPath({ ...base, platform: 'linux', env: { XDG_CONFIG_HOME: '/settings' } }).path,
    '/settings/unisearch/config.json',
  );
  assert.equal(
    selectConfigPath({ ...base, platform: 'linux', env: { XDG_CONFIG_HOME: 'relative' } }).path,
    '/home/alice/.config/unisearch/config.json',
  );
  assert.equal(
    selectConfigPath({ ...base, platform: 'darwin' }).path,
    '/home/alice/Library/Application Support/unisearch/config.json',
  );
  const windows = {
    platform: 'win32' as const,
    cwd: 'C:\\work',
    home: () => 'C:\\Users\\alice',
    env: {},
  };
  assert.equal(
    selectConfigPath(windows).path,
    'C:\\Users\\alice\\AppData\\Local\\unisearch\\config.json',
  );
  assert.equal(
    selectConfigPath({ ...windows, env: { LOCALAPPDATA: 'D:\\App Data' } }).path,
    'D:\\App Data\\unisearch\\config.json',
  );
  assert.equal(
    selectConfigPath({
      ...base,
      platform: 'linux',
      env: { UNISEARCH_CONFIG_PATH: './my config.json' },
      home: () => {
        throw new Error('Unused home');
      },
    }).path,
    '/work/my config.json',
  );
  assert.throws(
    () => selectConfigPath({ ...base, platform: 'linux', env: { UNISEARCH_CONFIG_PATH: '' } }),
    { code: 'CONFIG_PATH_ERROR' },
  );
});

test('Missing default configuration is empty without creating directories', (t) => {
  const root = temporary(t);
  const selected = selectConfigPath(context(root));
  assert.deepEqual(readConfig(selected), { ...selected, exists: false, values: {} });
  assert.deepEqual(readdirSync(root), []);
  assert.throws(() => readConfig({ path: selected.path, source: 'environment' }), {
    code: 'CONFIG_NOT_FOUND',
  });
});

test('Configuration reads preserve contents and ignore unrelated fields for help', (t) => {
  const root = temporary(t);
  const path = join(root, '设置.json');
  const contents = '\uFEFF' + JSON.stringify({ language: 'zh', providers: { model: 'invalid' } });
  writeFileSync(path, contents);
  assert.equal(resolveLanguage(context(root, { UNISEARCH_CONFIG_PATH: path })), 'zh');
  assert.equal(readFileSync(path, 'utf8'), contents);
  assert.deepEqual(readdirSync(root), ['设置.json']);
});

test('Bad configuration fails explicitly without exposing its text', (t) => {
  const root = temporary(t);
  const path = join(root, 'config.json');
  for (const contents of ['{"api_key":"fake-secret",', '[]', 'null', 'true', Buffer.from([0xff])]) {
    writeFileSync(path, contents);
    assert.throws(
      () => readConfig({ path, source: 'environment' }),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'CONFIG_PARSE_ERROR');
        assert.doesNotMatch(JSON.stringify(error.public('en')), /fake-secret/);
        return true;
      },
    );
  }
  const directory = join(root, 'directory');
  mkdirSync(directory);
  assert.throws(() => readConfig({ path: directory, source: 'environment' }), {
    code: 'CONFIG_READ_ERROR',
  });
});

test('Language overrides bypass configuration and saved auto uses the system locale', (t) => {
  const root = temporary(t);
  const path = join(root, 'config.json');
  writeFileSync(path, '{broken');
  for (const language of ['zh', 'en', 'auto']) {
    const env = { UNISEARCH_LANG: language, UNISEARCH_CONFIG_PATH: path, LC_ALL: 'zh_CN.UTF-8' };
    assert.equal(resolveLanguage(context(root, env)), language === 'en' ? 'en' : 'zh');
  }
  writeFileSync(path, '{"language":"auto"}');
  assert.equal(
    resolveLanguage(
      context(root, { UNISEARCH_CONFIG_PATH: path, LC_ALL: 'C', LANG: 'zh_CN.UTF-8' }),
    ),
    'en',
  );
  for (const value of ['', 'ZH', 'fr']) {
    assert.throws(() => resolveLanguage(context(root, { UNISEARCH_LANG: value })), {
      code: 'INVALID_CONFIG',
    });
  }
  writeFileSync(path, '{"language":42}');
  assert.throws(() => resolveLanguage(context(root, { UNISEARCH_CONFIG_PATH: path })), {
    code: 'INVALID_CONFIG',
  });
});

test('Locale precedence and Chinese variants are deterministic', () => {
  assert.equal(systemLanguage({ LC_ALL: 'C', LC_MESSAGES: 'zh_TW', LANG: 'zh_CN' }), 'en');
  assert.equal(systemLanguage({ LC_MESSAGES: 'zh-TW', LANG: 'en_US.UTF-8' }), 'zh');
  for (const locale of ['zh', 'zh_CN.UTF-8', 'zh-TW', 'zh-Hans-CN'])
    assert.equal(systemLanguage({ LANG: locale }), 'zh');
  for (const locale of ['', 'en-US', 'POSIX', 'fr_FR', 'unknown'])
    assert.equal(
      systemLanguage({}, () => locale),
      'en',
    );
  assert.equal(
    systemLanguage({}, () => 'zh-Hant-TW'),
    'zh',
  );
});
