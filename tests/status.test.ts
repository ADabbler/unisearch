import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCli } from '../src/cli/program.js';
import { localStatus } from '../src/config/status.js';
import type { OperationDefinition } from '../src/config/status.js';
import { renderConfig, renderStatus } from '../src/output/config.js';
import { render } from '../src/output/render.js';
import { renderDoctor } from '../src/output/doctor.js';
import stringWidth from 'fast-string-width';
import { failure, AppError } from '../src/errors.js';
import { capture, context, temporary } from './helpers.js';

const definitions: OperationDefinition[] = [
  { provider: 'exa', operation: 'search', required: ['providers.exa.api_key'] },
  { provider: 'exa', operation: 'fetch', required: ['providers.exa.api_key'] },
  { provider: 'tavily', operation: 'search', required: ['providers.tavily.api_key'] },
  { provider: 'firecrawl', operation: 'scrape', required: ['providers.firecrawl.api_key'] },
  { provider: 'jina', operation: 'fetch', required: ['providers.jina.api_key'] },
];

test('status checks four local states, collapses identical operations, and never exposes credentials', () => {
  const result = localStatus(
    {
      providers: {
        exa: { api_key: 'fixture-secret' },
        firecrawl: { enabled: false },
        jina: { api_key: 'invalid secret' },
      },
    },
    {},
    'en',
    definitions,
  );
  assert.deepEqual(
    result.services.map((service) => [service.provider, service.state]),
    [
      ['exa', 'ready'],
      ['tavily', 'missing'],
      ['firecrawl', 'disabled'],
      ['jina', 'invalid'],
    ],
  );
  assert.ok(result.services.every((service) => !service.operations));
  assert.equal(result.services[1].issues?.[0].code, 'MISSING_REQUIRED');
  assert.equal(result.services[2].issues, undefined);
  assert.equal(result.issues, undefined);
  assert.doesNotMatch(
    JSON.stringify(result),
    /fixture-secret|invalid secret|"path"|"source"|selection/,
  );
  const md = renderStatus(result, 'zh');
  assert.doesNotMatch(md, /仅检查本地配置|\|/);
  assert.match(md, /^exa: 就绪/m);
  assert.match(md, /^tavily: 缺少配置/m);
  assert.match(md, /^firecrawl: 已禁用/m);
});

test('different operation states expand the complete list and shared issues are not duplicated', () => {
  const fixture: OperationDefinition[] = [
    { provider: 'exa', operation: 'public-read', required: [] },
    { provider: 'exa', operation: 'authenticated-search', required: ['providers.exa.api_key'] },
  ];
  const result = localStatus({}, {}, 'en', fixture);
  assert.equal(result.services[0].state, 'ready');
  assert.deepEqual(
    result.services[0].operations?.map((operation) => operation.state),
    ['ready', 'missing'],
  );
  assert.equal(result.services[0].issues, undefined);
  assert.equal(result.services[0].operations?.[1].issues?.[0].field, 'providers.exa.api_key');
  const md = renderStatus(result, 'en');
  assert.match(md, /^exa:\n  public-read: Ready/m);
  assert.match(md, /  authenticated-search: Missing configuration/);
  assert.doesNotMatch(md, /\| exa \|/);
  const common = localStatus(
    { providers: { exa: { enabled: 'secret-invalid', api_key: 'invalid secret' } } },
    {},
    'en',
    fixture,
  );
  assert.equal(common.services[0].state, 'invalid');
  assert.equal(common.services[0].operations, undefined);
  assert.equal(common.services[0].issues?.length, 2);
  assert.equal(
    common.services[0].issues?.filter((issue) => issue.field === 'providers.exa.enabled').length,
    1,
  );
  assert.equal(
    common.services[0].issues?.find((issue) => issue.field === 'providers.exa.api_key')?.operation,
    'authenticated-search',
  );
  assert.equal((renderStatus(common, 'en').match(/providers.exa.enabled/g) ?? []).length, 1);
});

test('status and doctor wrap Chinese reasons within terminal columns and retain hierarchy', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.stdout, 'columns', descriptor);
    else Reflect.deleteProperty(process.stdout, 'columns');
  });
  const message = '凭证没有访问当前服务的权限，请检查配置与账户状态后再次执行诊断';
  const report = renderStatus(
    {
      services: [
        {
          provider: 'exa',
          state: 'invalid',
          issues: [{ code: 'INVALID_CONFIG', message, field: 'providers.exa.api_key' }],
        },
      ],
    },
    'zh',
  );
  const doctor = renderDoctor(
    { services: [{ provider: 'exa', state: 'failed', error: { code: 'ACCESS_DENIED', message } }] },
    'zh',
  );
  for (const value of [report, doctor]) {
    const lines = value.split('\n');
    assert.ok(lines.length > 2);
    assert.ok(lines.slice(1).every((line) => line.startsWith('  ')));
    assert.ok(lines.every((line) => stringWidth(line) <= 40));
    assert.doesNotMatch(value, /\[INVALID_CONFIG\]|\[ACCESS_DENIED\]|[。.]$/m);
    assert.ok(value.replace(/\s/g, '').includes(message));
  }
});

test('invalid required settings outrank disabled, while missing settings do not', () => {
  const disabled = localStatus(
    { providers: { exa: { enabled: false } } },
    {},
    'en',
    definitions.slice(0, 2),
  );
  assert.deepEqual(disabled, { services: [{ provider: 'exa', state: 'disabled' }] });
  const invalid = localStatus(
    { providers: { exa: { enabled: false, api_key: '' } } },
    {},
    'en',
    definitions.slice(0, 2),
  );
  assert.equal(invalid.services[0].state, 'invalid');
  assert.equal(invalid.services[0].issues?.length, 1);
  assert.equal(invalid.services[0].issues?.[0].code, 'INVALID_VALUE');
  const independent = localStatus(
    { providers: { exa: null, tavily: { api_key: 'fixture-key' } } },
    {},
    'en',
    definitions,
  );
  assert.equal(
    independent.services.find((service) => service.provider === 'tavily')?.state,
    'ready',
  );
  assert.equal(
    independent.services.find((service) => service.provider === 'exa')?.issues?.length,
    1,
  );
});

test('status readiness uses effective settings while retaining invalid overridden file settings', () => {
  const values = { providers: { exa: { api_key: 42 } } };
  const env = { UNISEARCH_EXA_API_KEY: 'fixture-valid' };
  const result = localStatus(values, env, 'en', definitions.slice(0, 2));
  assert.deepEqual(result.services, [{ provider: 'exa', state: 'ready' }]);
  assert.deepEqual(
    result.issues?.map((issue) => issue.field),
    ['providers.exa.api_key'],
  );
  assert.doesNotMatch(JSON.stringify(result), /fixture-valid|42/);
  const disabled = localStatus(
    { providers: { exa: { ...values.providers.exa, enabled: false } } },
    env,
    'en',
    definitions.slice(0, 2),
  );
  assert.equal(disabled.services[0].state, 'disabled');
  assert.equal(disabled.issues?.length, 1);
  const invalid = localStatus(
    values,
    { ...env, UNISEARCH_EXA_API_KEY: ' ' },
    'en',
    definitions.slice(0, 2),
  );
  assert.equal(invalid.services[0].state, 'invalid');
  assert.equal(invalid.services[0].issues?.length, 1);
  assert.equal(invalid.services[0].issues?.[0].environment, 'UNISEARCH_EXA_API_KEY');
  assert.equal(invalid.issues?.length, 1);
});

test('configuration issues remain at top level when no operation definitions are supplied', () => {
  const result = localStatus(
    {
      providers: { model: { api_key: 'valid-fixture' }, tinyfish: { enabled: 'secret' } },
      fetch: { providers: ['ctx7'] },
      map: { providers: ['unknown-secret'] },
      execution: { retries: -1 },
      secretField: 'secret-value',
    },
    {},
    'zh',
  );
  assert.deepEqual(result.services, []);
  assert.deepEqual(
    result.issues?.map((issue) => issue.code),
    ['INVALID_TYPE', 'UNSUPPORTED_OPERATION', 'UNKNOWN_PROVIDER', 'INVALID_VALUE', 'UNKNOWN_FIELD'],
  );
  assert.doesNotMatch(JSON.stringify(result), /secret|valid-fixture/);
  const md = renderStatus(result, 'zh');
  assert.match(md, /^没有可展示的服务操作\n/);
  assert.match(md, /配置问题:/);
  assert.doesNotMatch(md, /\| 服务|setup|候选|path/);
  assert.deepEqual(
    localStatus({ fetch: { providers: ['exa', 'anysearch'] }, map: { providers: [] } }, {}, 'en'),
    { services: [] },
  );
});

test('actual status commands are read-only and distinguish field issues from unreadable JSON', async (t) => {
  const root = temporary(t);
  const path = join(root, 'config.json');
  const config = context(root, { UNISEARCH_CONFIG_PATH: path, UNISEARCH_LANG: 'en' });
  writeFileSync(path, '{"providers":{"exa":{"enabled":42}}}');
  const original = readFileSync(path, 'utf8');
  const channels = capture();
  assert.equal(await createCli('1.2.3', { config, channels }).run(['status', '--json']), 0);
  const result = JSON.parse(channels.out);
  const exa = result.data.services.find(
    (service: { provider: string }) => service.provider === 'exa',
  );
  assert.equal(exa.state, 'invalid');
  assert.equal(exa.issues[0].field, 'providers.exa.enabled');
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.deepEqual(readdirSync(root), ['config.json']);
  writeFileSync(path, '{broken-secret');
  const bad = capture();
  assert.equal(await createCli('1.2.3', { config, channels: bad }).run(['status', '--json']), 3);
  assert.equal(JSON.parse(bad.out).error.code, 'CONFIG_PARSE_ERROR');
  assert.equal(JSON.parse(bad.out).data, undefined);
  assert.doesNotMatch(bad.out, /broken-secret|"services"/);
});

test('plain configuration confirmations preserve values and localize public errors', () => {
  assert.equal(renderConfig('path', { path: '/tmp/a-b.json' }, 'zh'), '/tmp/a-b.json');
  assert.equal(
    renderConfig('set', { key: 'execution.retries', value: 0, changed: true }, 'zh'),
    '已保存 execution.retries = 0',
  );
  assert.match(
    renderConfig('set', { key: 'execution.retries', value: 0, changed: false }, 'en'),
    /no change needed/,
  );
  assert.equal(renderConfig('unset', { changed: true }, 'zh'), '已删除指定的未识别配置项');
  const value = renderConfig(
    'set',
    { key: 'providers.exa.api_key', value: '[REDACTED]', changed: true },
    'en',
  );
  assert.equal(value, 'Saved providers.exa.api_key = [REDACTED]');
  const result = failure(
    new AppError('FILE_IO_ERROR', 'fileIO', {
      field: 'execution.retries',
      path: '/tmp/test',
      operation: 'rename',
      system_code: 'EACCES',
    }),
    'zh',
  );
  const output = render(result, { format: 'text', language: 'zh' });
  assert.equal(output.content, '');
  const rendered = output.details;
  for (const label of ['配置项', '路径', '操作', '系统错误码']) assert.ok(rendered.includes(label));
  assert.match(rendered, /rename/);
  assert.match(rendered, /EACCES/);
  assert.doesNotMatch(rendered, /system_code|field:|\[FILE_IO_ERROR\]/);
});
