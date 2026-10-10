import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run this check through npm run check:package or npm run check.');

function run(command, args, options = {}, expectedStatus = 0) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    expectedStatus,
    `${command} exited unexpectedly.\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

const work = mkdtempSync(join(tmpdir(), 'unisearch-package-'));
const packedDirectory = join(work, 'package');
const prefix = join(work, 'install with spaces');
const caller = join(work, 'caller 中文');
for (const path of [packedDirectory, caller]) mkdirSync(path);
const config = join(caller, '设置.json');
const configText = '{"language":"zh"}\n';
writeFileSync(config, configText);

const packed = Object.values(
  JSON.parse(
    run(process.execPath, [
      npm,
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      packedDirectory,
    ]).stdout,
  ),
);
assert.equal(packed.length, 1);
assert.equal(packed[0].version, manifest.version);
const files = packed[0].files.map((file) => file.path);
const compiledFiles = readdirSync(join(root, 'src'), { recursive: true })
  .filter((path) => path.endsWith('.ts'))
  .map((path) => `dist/${path.slice(0, -3).split(sep).join('/')}.js`);
const expectedFiles = [
  ...compiledFiles,
  'skills/unisearch/SKILL.md',
  'skills/unisearch/agents/openai.yaml',
  'package.json',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'docs/en/configuration.md',
  'docs/zh-CN/configuration.md',
];
assert.deepEqual(
  files.toSorted(),
  expectedFiles.toSorted(),
  'Package contents must match the source modules and bundled resources.',
);
const tarball = join(packedDirectory, packed[0].filename);
run(process.execPath, [
  npm,
  'install',
  '--global',
  '--prefix',
  prefix,
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  tarball,
]);
const packageDirectory = join(
  prefix,
  ...(process.platform === 'win32' ? [] : ['lib']),
  'node_modules',
  manifest.name,
);
const executable = join(
  prefix,
  ...(process.platform === 'win32' ? [] : ['bin']),
  process.platform === 'win32' ? 'unisearch.cmd' : 'unisearch',
);
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('UNISEARCH_')),
  ),
  UNISEARCH_CONFIG_PATH: config,
  HOME: join(work, 'home'),
  USERPROFILE: join(work, 'home'),
  PATH: [dirname(executable), dirname(process.execPath), process.env.PATH].join(delimiter),
};

function installed(args, language, expectedStatus = 0, errorOutput = false) {
  const environment = { ...env };
  if (language !== undefined) environment.UNISEARCH_LANG = language;
  // Only the fixed smoke-test arguments below are passed to the Windows command shim.
  const result =
    process.platform === 'win32'
      ? run(
          'cmd.exe',
          ['/d', '/s', '/c', `""${executable}" ${args.map((arg) => `"${arg}"`).join(' ')}"`],
          {
            cwd: caller,
            env: environment,
            // Keep the nested quotes intact for cmd.exe's /c command line.
            windowsVerbatimArguments: true,
          },
          expectedStatus,
        )
      : run(executable, args, { cwd: caller, env: environment }, expectedStatus);
  assert.equal(
    errorOutput ? result.stdout : result.stderr,
    '',
    errorOutput ? result.stdout : result.stderr,
  );
  return errorOutput ? result.stderr : result.stdout;
}

const installedManifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
for (const path of ['docs/en/configuration.md', 'docs/zh-CN/configuration.md']) {
  assert.deepEqual(readFileSync(join(packageDirectory, path)), readFileSync(join(root, path)));
}
const skillPath = join(env.HOME, '.codex', 'skills', 'unisearch');
for (const command of ['setup', 'doctor', 'skills'])
  assert.match(installed([command, '--help'], 'en'), /^Usage:/);
assert.match(installed(['skills', 'install', '--targets', 'codex'], 'en'), /Codex: installed/);
for (const path of files.filter((path) => path.startsWith('skills/unisearch/'))) {
  assert.deepEqual(
    readFileSync(join(skillPath, path.slice('skills/unisearch/'.length))),
    readFileSync(join(root, path)),
  );
}
writeFileSync(join(skillPath, 'SKILL.md'), 'modified copy');
assert.match(installed(['skills', 'status', '--targets', 'codex'], 'en'), /Codex: different/);
assert.match(installed(['skills', 'update', '--targets', 'codex'], 'en'), /Codex: updated/);
assert.match(installed(['skills', 'status', '--targets', 'codex'], 'en'), /current/);
assert.match(installed(['skills', 'remove', '--targets', 'codex'], 'en'), /Codex: removed/);
installed(['skills', 'install', '--targets', 'codex']);
assert.equal(installedManifest.version, manifest.version);
assert.equal(installed(['--version']), `unisearch ${manifest.version}\n`);
assert.match(installed(['--help']), /^用法：/);
assert.match(installed(['--help'], 'en'), /^Usage:/);
assert.match(installed(['exa', 'search', '--help'], 'en'), /--search-type/);
assert.match(installed(['exa', 'search', '--help']), /搜索模式/);
assert.match(installed(['exa', 'fetch', '--help'], 'en'), /--max-length/);
assert.match(installed(['exa', 'fetch', '--help']), /正文/);
for (const operation of ['library', 'docs']) {
  assert.match(installed(['ctx7', operation, '--help'], 'en'), /^Usage:/);
  assert.match(installed(['ctx7', operation, '--help']), /^用法：/);
}
for (const operation of ['search', 'fetch', 'docs', 'tree', 'read-file']) {
  assert.match(installed(['zhipu-mcp', operation, '--help'], 'en'), /^Usage:/);
  assert.match(installed(['zhipu-mcp', operation, '--help']), /^用法：/);
}
run(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    const mcp = await import(pathToFileURL(process.argv[1]).href);
    const request = mcp.prepare('search', 'fixture', {}, {}, {
      UNISEARCH_ZHIPU_MCP_API_KEY: 'fixture-package-key',
    }, 'en');
    let calls = 0;
    const result = await mcp.request(request, { signal: new AbortController().signal }, 'en', async (_url, options) => {
      calls++;
      const message = JSON.parse(options.body);
      assert.equal(message.method, 'initialize');
      assert.equal(message.params.clientInfo.version, process.argv[2]);
      return Response.json({}, { status: 401 });
    });
    assert.equal(calls, 1);
    assert.equal(result.outcome.exitCode, 3);
  `,
    join(packageDirectory, 'dist/providers/zhipu-mcp.js'),
    manifest.version,
  ],
  { cwd: caller, env },
);
for (const operation of ['fetch', 'search']) {
  assert.match(installed(['jina', operation, '--help'], 'en'), /^Usage:/);
  assert.match(installed(['jina', operation, '--help']), /^用法：/);
  assert.match(installed(['zhipu', operation, '--help'], 'en'), /^Usage:/);
  assert.match(installed(['zhipu', operation, '--help']), /^用法：/);
}
for (const operation of ['search', 'domains', 'extract']) {
  assert.match(installed(['anysearch', operation, '--help'], 'en'), /^Usage:/);
  assert.match(installed(['anysearch', operation, '--help']), /^用法：/);
}
for (const operation of ['search', 'fetch']) {
  assert.match(installed(['tinyfish', operation, '--help'], 'en'), /^Usage:/);
  assert.match(installed(['tinyfish', operation, '--help']), /^用法：/);
}
assert.match(installed(['tinyfish', 'fetch', '--help'], 'en'), /--target-selector/);
const catalog = JSON.parse(installed(['anysearch', 'domains', '--format=json']));
assert.equal(catalog.data.catalog_source, 'bundled');
assert.ok(catalog.data.domains.includes('code'));
assert.match(installed(['anysearch', 'domains']), /内置官方领域目录/);
assert.match(installed(['search', '--help'], 'en'), /--effort/);
for (const operation of ['search', 'extract', 'map']) {
  assert.match(installed(['tavily', operation, '--help'], 'en'), /^Usage:/);
  assert.match(installed(['tavily', operation, '--help']), /^用法：/);
}
assert.match(installed(['tavily', '--help'], 'en'), /extract/);
assert.match(installed(['tavily', '--help']), /网页提取/);
assert.doesNotMatch(installed(['exa', '--help'], 'en'), /similar/);
for (const operation of ['fetch', 'map']) {
  assert.match(installed([operation, '--help'], 'en'), /--no-fallback/);
  assert.match(installed([operation, '--help']), /服务切换/);
}
for (const [operation, flag] of [
  ['search', '--categories'],
  ['scrape', '--max-age'],
  ['map', '--sitemap'],
]) {
  assert.match(installed(['firecrawl', operation, '--help'], 'en'), new RegExp(flag));
}
assert.doesNotMatch(installed(['firecrawl', '--help'], 'en'), /\n  (crawl|batch|browser) /);
assert.match(installed(['未实现的命令'], 'en', 2, true), /^Error: Unknown command/);
assert.equal(existsSync(join(packageDirectory, 'node_modules', 'typescript')), false);
assert.equal(existsSync(join(packageDirectory, 'src')), false);
assert.equal(readFileSync(config, 'utf8'), configText);

assert.equal(
  installed(['config', 'set', 'execution.retries', '0'], 'en'),
  'Saved execution.retries = 0\n',
);
const get = JSON.parse(installed(['config', 'get', 'execution.retries']));
assert.deepEqual(get.data, { key: 'execution.retries', value: 0, source: 'config' });
const status = JSON.parse(installed(['status', '--json']));
assert.equal(status.status, 'success');
assert.equal(status.data.services.find((service) => service.provider === 'zhipu').state, 'missing');
installed(['config', 'set', 'providers.zhipu.platform', 'zai']);
assert.equal(
  JSON.parse(installed(['config', 'get', 'providers.zhipu.base_url'])).data.value,
  'https://api.z.ai/api/paas/v4',
);
assert.equal(
  JSON.parse(installed(['config', 'get', 'providers.zhipu.search.engine'])).data.value,
  'search-prime',
);
env.UNISEARCH_ZHIPU_API_KEY = 'fixture-zhipu-key';
assert.equal(
  JSON.parse(installed(['status', '--json'])).data.services.find(
    (service) => service.provider === 'zhipu',
  ).state,
  'ready',
);
delete env.UNISEARCH_ZHIPU_API_KEY;
installed(['config', 'unset', 'providers.zhipu']);
assert.equal(status.data.services.find((s) => s.provider === 'tinyfish').state, 'missing');
installed(['config', 'set', 'providers.tinyfish.search_url', 'https://fixture.example/search']);
assert.equal(
  JSON.parse(installed(['config', 'get', 'providers.tinyfish.search_url'])).data.value,
  'https://fixture.example/search',
);
env.UNISEARCH_TINYFISH_API_KEY = 'fixture-tinyfish-key';
assert.equal(
  JSON.parse(installed(['status', '--json'])).data.services.find((s) => s.provider === 'tinyfish')
    .state,
  'ready',
);
installed(['config', 'unset', 'providers.tinyfish']);
delete env.UNISEARCH_TINYFISH_API_KEY;
assert.equal(
  status.data.services.find((service) => service.provider === 'zhipu-mcp').state,
  'missing',
);
installed(['config', 'set', 'providers.zhipu-mcp.platform', 'zai']);
assert.equal(
  JSON.parse(installed(['config', 'get', 'providers.zhipu-mcp.base_url'])).data.value,
  'https://api.z.ai/api/mcp',
);
env.UNISEARCH_ZHIPU_MCP_API_KEY = 'fixture-mcp-key';
assert.equal(
  JSON.parse(installed(['status', '--json'])).data.services.find(
    (service) => service.provider === 'zhipu-mcp',
  ).state,
  'ready',
);
delete env.UNISEARCH_ZHIPU_MCP_API_KEY;
installed(['config', 'unset', 'providers.zhipu-mcp']);
assert.equal(status.data.services.find((service) => service.provider === 'jina').state, 'ready');
installed(['config', 'set', 'providers.jina.search.limit', '10']);
assert.equal(
  JSON.parse(installed(['config', 'get', 'providers.jina.search.limit'])).data.value,
  10,
);
installed(['config', 'unset', 'providers.jina']);
assert.equal(status.data.services.find((service) => service.provider === 'ctx7').state, 'ready');
assert.equal(
  status.data.services.find((service) => service.provider === 'anysearch').state,
  'ready',
);
installed(['config', 'set', 'providers.anysearch.search.limit', '3']);
assert.equal(
  JSON.parse(installed(['config', 'get', 'providers.anysearch.search.limit'])).data.value,
  3,
);
installed(['config', 'unset', 'providers.anysearch']);
installed(['config', 'set', 'providers.ctx7.base_url', 'https://fixture.example/api']);
assert.equal(
  JSON.parse(installed(['config', 'get', 'providers.ctx7.base_url'])).data.value,
  'https://fixture.example/api',
);
installed(['config', 'set', 'providers.exa.search.limit', '10']);
assert.equal(JSON.parse(installed(['config', 'get', 'providers.exa.search.limit'])).data.value, 10);
installed(['config', 'unset', 'providers.exa.search.limit']);
for (const provider of ['model', 'exa', 'tavily', 'firecrawl']) {
  assert.equal(
    status.data.services.find((service) => service.provider === provider).state,
    'missing',
  );
}
assert.equal(
  status.data.services.find((service) => service.provider === 'model').issues[0].field,
  'providers.model.api_key',
);
installed(['config', 'set', 'providers.firecrawl.search.limit', '8']);
installed(['config', 'set', 'providers.firecrawl.map.sitemap', 'only']);
assert.equal(
  JSON.parse(installed(['config', 'get', 'providers.firecrawl.search.limit'])).data.value,
  8,
);
env.UNISEARCH_FIRECRAWL_API_KEY = 'fixture-firecrawl-key';
assert.equal(
  JSON.parse(installed(['status', '--json'])).data.services.find((s) => s.provider === 'firecrawl')
    .state,
  'ready',
);
installed(['config', 'set', 'providers.model.base_url', 'https://fixture.example/v1']);
installed(['config', 'set', 'providers.model.model.id', 'fixture-model']);
installed(['config', 'set', 'providers.model.model.effort', 'low']);
installed(['config', 'set', 'providers.model.tools', '[]']);
env.UNISEARCH_MODEL_API_KEY = 'fixture-package-key';
const modelStatus = JSON.parse(installed(['status', '--json']));
assert.equal(modelStatus.data.services[0].state, 'ready');
assert.equal(modelStatus.data.services[1].state, 'missing');
assert.doesNotMatch(JSON.stringify(modelStatus), /fixture-package-key/);
installed(['config', 'set', 'providers.tavily.map.limit', '20']);
assert.equal(JSON.parse(installed(['config', 'get', 'providers.tavily.map.limit'])).data.value, 20);
env.UNISEARCH_TAVILY_API_KEY = 'fixture-tavily-key';
assert.equal(
  JSON.parse(installed(['status', '--json'])).data.services.find((s) => s.provider === 'tavily')
    .state,
  'ready',
);
installed(['config', 'set', 'providers.tavily.enabled', 'false']);
assert.equal(
  JSON.parse(installed(['status', '--json'])).data.services.find((s) => s.provider === 'tavily')
    .state,
  'disabled',
);
installed(['config', 'unset', 'providers.tavily']);
assert.equal(JSON.parse(installed(['config', 'get', 'execution.retries'])).data.value, 0);
const savedConfig = readFileSync(config, 'utf8');
assert.deepEqual(JSON.parse(savedConfig), {
  language: 'zh',
  execution: { retries: 0 },
  providers: {
    ctx7: { base_url: 'https://fixture.example/api' },
    model: {
      base_url: 'https://fixture.example/v1',
      model: { id: 'fixture-model', effort: 'low' },
      tools: [],
    },
    firecrawl: { search: { limit: 8 }, map: { sitemap: 'only' } },
  },
});

const upgradeDirectory = join(work, 'upgrade source');
cpSync(packageDirectory, upgradeDirectory, { recursive: true });
run(
  process.execPath,
  [
    npm,
    'version',
    'prerelease',
    '--preid=upgrade-fixture',
    '--no-git-tag-version',
    '--ignore-scripts',
  ],
  { cwd: upgradeDirectory },
);
const upgradeManifest = JSON.parse(readFileSync(join(upgradeDirectory, 'package.json'), 'utf8'));
const upgradedSkill = `${readFileSync(join(upgradeDirectory, 'skills/unisearch/SKILL.md'), 'utf8')}\nFixture upgrade content.\n`;
writeFileSync(join(upgradeDirectory, 'skills/unisearch/SKILL.md'), upgradedSkill);
const upgradePack = Object.values(
  JSON.parse(
    run(
      process.execPath,
      [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', packedDirectory],
      { cwd: upgradeDirectory },
    ).stdout,
  ),
)[0];
run(process.execPath, [
  npm,
  'install',
  '--global',
  '--prefix',
  prefix,
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  join(packedDirectory, upgradePack.filename),
]);
assert.equal(installed(['--version']), `unisearch ${upgradeManifest.version}\n`);
assert.deepEqual(
  readFileSync(join(skillPath, 'SKILL.md')),
  readFileSync(join(root, 'skills/unisearch/SKILL.md')),
);
assert.match(installed(['skills', 'status', '--targets', 'codex'], 'en'), /Codex: different/);
assert.match(installed(['skills', 'update', '--targets', 'codex'], 'en'), /Codex: updated/);
assert.equal(readFileSync(join(skillPath, 'SKILL.md'), 'utf8'), upgradedSkill);
assert.equal(readFileSync(config, 'utf8'), savedConfig);

run(process.execPath, [
  npm,
  'uninstall',
  '--global',
  '--prefix',
  prefix,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  manifest.name,
]);
assert.equal(existsSync(executable), false);
assert.equal(readFileSync(join(skillPath, 'SKILL.md'), 'utf8'), upgradedSkill);
assert.equal(readFileSync(config, 'utf8'), savedConfig);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\n`);
}
console.log(
  JSON.stringify(
    {
      package: `${manifest.name}@${manifest.version}`,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      files: files.length,
      tarball,
      checks:
        'package contents, configuration docs, isolated install and fixture upgrade, npm bin, language, UTF-8, config set/get/unset, provider help and local status, setup/doctor help, offline domains, Skill install/status/update/remove, JSON/Markdown, errors, uninstall preserving configuration and Skill copies',
    },
    null,
    2,
  ),
);
