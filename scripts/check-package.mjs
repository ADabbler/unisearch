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
const documentation = [
  'docs/en/configuration.md',
  'docs/en/design.md',
  'docs/zh-CN/configuration.md',
  'docs/zh-CN/design.md',
];
const expectedFiles = [
  ...compiledFiles,
  'skills/unisearch/SKILL.md',
  'skills/unisearch/agents/openai.yaml',
  'skills/unisearch/references/providers.md',
  'package.json',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  ...documentation,
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

function installed(args, expectedStatus = 0) {
  // Shim smoke tests use fixed arguments without embedded quotes; structured settings use files.
  const result =
    process.platform === 'win32'
      ? run(
          'cmd.exe',
          ['/d', '/s', '/c', `""${executable}" ${args.map((arg) => `"${arg}"`).join(' ')}"`],
          {
            cwd: caller,
            env,
            // Keep the nested quotes intact for cmd.exe's /c command line.
            windowsVerbatimArguments: true,
          },
          expectedStatus,
        )
      : run(executable, args, { cwd: caller, env }, expectedStatus);
  assert.equal(result.stderr, '');
  return result.stdout;
}

const installedManifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
for (const path of documentation) {
  assert.deepEqual(readFileSync(join(packageDirectory, path)), readFileSync(join(root, path)));
}
const skillPath = join(env.HOME, '.codex', 'skills', 'unisearch');
installed(['skills', 'install', '--targets', 'codex']);
for (const path of files.filter((path) => path.startsWith('skills/unisearch/'))) {
  assert.deepEqual(
    readFileSync(join(skillPath, path.slice('skills/unisearch/'.length))),
    readFileSync(join(root, path)),
  );
}
installed(['skills', 'remove', '--targets', 'codex']);
assert.equal(existsSync(skillPath), false);
installed(['skills', 'install', '--targets', 'codex']);

assert.equal(installedManifest.version, manifest.version);
assert.equal(installed(['--version']), `unisearch ${manifest.version}\n`);
assert.match(installed(['--help']), /^\p{Script=Han}/u);
assert.match(installed(['search', '--help']), /--sources/);
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
assert.equal(existsSync(join(packageDirectory, 'node_modules', 'typescript')), false);
assert.equal(readFileSync(config, 'utf8'), configText);
assert.equal(installed(['config', 'path']).trim(), config);

const catalog = JSON.parse(installed(['anysearch', 'domains', '--format=json']));
assert.equal(catalog.data.catalog_source, 'bundled');
assert.ok(catalog.data.domains.includes('code'));
assert.equal(JSON.parse(installed(['search', '--format=json'], 2)).error.code, 'INVALID_ARGUMENT');

installed(['config', 'set', 'execution.retries', '0']);
const get = JSON.parse(installed(['config', 'get', 'execution.retries']));
assert.deepEqual(get.data, { key: 'execution.retries', value: 0, source: 'config' });
const savedConfig = readFileSync(config, 'utf8');
assert.deepEqual(JSON.parse(savedConfig), { language: 'zh', execution: { retries: 0 } });

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
installed(['skills', 'update', '--targets', 'codex']);
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
        'package contents, isolated install and upgrade, executable, UTF-8 configuration, offline catalog, MCP client version, Skill lifecycle, uninstall preserving configuration and Skill copies',
    },
    null,
    2,
  ),
);
