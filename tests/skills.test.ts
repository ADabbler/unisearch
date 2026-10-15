import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { manageSkills, preflightSkills } from '../src/skills/manage.js';
import { parseTargets, targetPaths } from '../src/skills/targets.js';
import { temporary, context, capture } from './helpers.js';
import { createCli } from '../src/cli/program.js';
import { AppError } from '../src/errors.js';

test('Target paths use platform roots and Devin overrides, and IDs are strict', () => {
  const config = { ...context('/home/test'), platform: 'linux' as const };
  assert.deepEqual(targetPaths(['codex', 'opencode', 'devin'], config), [
    { target: 'codex', path: '/home/test/.codex/skills/unisearch' },
    { target: 'opencode', path: '/home/test/.config/opencode/skills/unisearch' },
    { target: 'devin', path: '/home/test/.config/devin/skills/unisearch' },
  ]);
  for (const value of ['', 'codex,', 'codex,codex', 'Codex', 'windsurf', ' codex'])
    assert.throws(() => parseTargets(value));
  assert.deepEqual(parseTargets('codex,devin'), ['codex', 'devin']);
  assert.equal(
    targetPaths(['devin'], { ...config, env: { XDG_CONFIG_HOME: '/xdg' } })[0].path,
    '/xdg/devin/skills/unisearch',
  );
  assert.equal(
    targetPaths(['devin'], { ...config, env: { XDG_CONFIG_HOME: 'relative' } })[0].path,
    '/home/test/.config/devin/skills/unisearch',
  );
  const windows = {
    ...config,
    platform: 'win32' as const,
    cwd: 'C:\\work',
    home: () => 'C:\\Users\\test',
  };
  assert.deepEqual(targetPaths(['codex', 'devin'], windows), [
    { target: 'codex', path: 'C:\\Users\\test\\.codex\\skills\\unisearch' },
    { target: 'devin', path: 'C:\\Users\\test\\AppData\\Roaming\\devin\\skills\\unisearch' },
  ]);
  assert.equal(
    targetPaths(['devin'], { ...windows, env: { APPDATA: 'D:\\Roaming' } })[0].path,
    'D:\\Roaming\\devin\\skills\\unisearch',
  );
});

test('Complete copies compare bytes, directories and types; update does not create absent targets', async (t) => {
  const root = temporary(t),
    source = join(root, 'source');
  await fs.mkdir(join(source, 'references'), { recursive: true });
  await fs.writeFile(join(source, 'SKILL.md'), 'skill\n');
  await fs.writeFile(join(source, 'references', 'a.md'), 'reference');
  const targets = targetPaths(['codex', 'claude'], context(root, {}));
  assert.equal((await manageSkills('update', targets, 'en', undefined, source)).exitCode, 5);
  assert.equal((await manageSkills('install', targets, 'en', undefined, source)).exitCode, 0);
  const before = await fs.stat(join(targets[0].path, 'SKILL.md'));
  assert.equal(
    (await manageSkills('install', targets, 'en', undefined, source)).result.data?.targets[0].state,
    'unchanged',
  );
  assert.equal((await fs.stat(join(targets[0].path, 'SKILL.md'))).mtimeMs, before.mtimeMs);
  await fs.writeFile(join(targets[0].path, 'SKILL.md'), 'skill\r\n');
  await fs.rm(join(targets[0].path, 'references'), { recursive: true });
  await fs.mkdir(join(targets[0].path, 'extra'));
  const status = await manageSkills('status', targets, 'en', undefined, source);
  assert.deepEqual(status.result.data?.targets[0].differences, {
    missing: ['references'],
    modified: ['SKILL.md'],
    extra: ['extra'],
  });
  assert.equal(
    (await manageSkills('update', targets, 'en', undefined, source)).result.data?.targets[0].state,
    'updated',
  );
  assert.equal(
    (await manageSkills('status', targets, 'en', undefined, source)).result.data?.targets[0].state,
    'current',
  );
  assert.equal(
    (await manageSkills('remove', targets, 'en', undefined, '/missing-source')).exitCode,
    0,
  );
  assert.equal(
    (await manageSkills('remove', targets, 'en')).result.data?.targets[0].state,
    'absent',
  );
});

test('Root and internal links never modify external targets; parent links are supported', async (t) => {
  const root = temporary(t),
    source = join(root, 'source'),
    outside = join(root, 'outside');
  await fs.mkdir(source);
  await fs.writeFile(join(source, 'SKILL.md'), 'skill');
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, 'sentinel'), 'untouched');
  const [target] = targetPaths(['codex'], context(root, {}));
  await fs.mkdir(join(root, '.codex'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(outside, join(root, '.codex', 'skills'), linkType);
  await fs.symlink(outside, target.path, linkType);
  const status = await manageSkills('status', [target], 'en', undefined, source);
  assert.equal(status.result.data?.targets[0].state, 'different');
  assert.ok(status.result.data?.targets[0].differences);
  await manageSkills('install', [target], 'en', undefined, source);
  assert.equal((await fs.lstat(target.path)).isDirectory(), true);
  await fs.symlink(outside, join(target.path, 'external'), linkType);
  await manageSkills('remove', [target], 'en');
  assert.equal(await fs.readFile(join(outside, 'sentinel'), 'utf8'), 'untouched');
});

test('Status compares the contents behind a root skill symlink', async (t) => {
  const root = temporary(t),
    source = join(root, 'source'),
    outside = join(root, 'outside');
  await fs.mkdir(source);
  await fs.mkdir(outside);
  await fs.writeFile(join(source, 'SKILL.md'), 'skill');
  await fs.writeFile(join(outside, 'SKILL.md'), 'skill');
  const [target] = targetPaths(['codex'], context(root, {}));
  await fs.mkdir(join(root, '.codex', 'skills'), { recursive: true });
  await fs.symlink(outside, target.path, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await manageSkills('status', [target], 'en', undefined, source);
  assert.equal(result.result.data?.targets[0].state, 'current');
  assert.equal(result.result.data?.targets[0].differences, undefined);
  assert.equal((await fs.lstat(target.path)).isSymbolicLink(), true);
  const update = await manageSkills('update', [target], 'en', undefined, source);
  assert.equal(update.result.data?.targets[0].state, 'unchanged');
  assert.equal((await fs.lstat(target.path)).isSymbolicLink(), true);
});

test('Independent failures, cancellation, source validation and overlap preflight', async (t) => {
  const root = temporary(t),
    source = join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(join(source, 'SKILL.md'), 'skill');
  const targets = targetPaths(['codex', 'claude'], context(root, {}));
  await fs.mkdir(join(root, '.codex', 'skills'), { recursive: true });
  await fs.writeFile(targets[0].path, 'not a skill');
  const result = await manageSkills('install', targets, 'en', undefined, source);
  assert.equal(result.exitCode, 6);
  assert.equal(result.result.data?.targets[0].changed, false);
  assert.equal(result.result.data?.targets[1].state, 'installed');
  const abort = new AbortController();
  abort.abort();
  const cancelled = await manageSkills('remove', targets, 'en', abort.signal);
  assert.equal(cancelled.exitCode, 130);
  assert.ok(cancelled.result.data?.targets.every((item) => item.state === 'not_started'));
  await assert.rejects(preflightSkills([targets[0], targets[0]], source));
  await assert.rejects(preflightSkills(targets, source, join(targets[1].path, 'config.json')));
  await fs.symlink(
    targets[1].path,
    join(source, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(manageSkills('install', targets, 'en', undefined, source));
});

test('Failed removal and rename retain actual side effects and cleanup errors', async (t) => {
  const root = await fs.realpath(temporary(t)),
    source = join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(join(source, 'SKILL.md'), 'new');
  const targets = targetPaths(['codex'], context(root, {}));
  await manageSkills('install', targets, 'en', undefined, source);
  await fs.writeFile(join(targets[0].path, 'SKILL.md'), 'old');
  const rm = fs.rm;
  const removal = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === targets[0].path) throw Object.assign(new Error(), { code: 'EACCES' });
    return rm(...args);
  });
  const failed = await manageSkills('update', targets, 'en', undefined, source);
  assert.equal(failed.result.data?.targets[0].changed, 'unknown');
  assert.equal(await fs.readFile(join(targets[0].path, 'SKILL.md'), 'utf8'), 'old');
  removal.mock.restore();
  t.mock.method(fs, 'rename', async () => {
    throw Object.assign(new Error(), { code: 'EIO' });
  });
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).includes('.unisearch-skill-'))
      throw Object.assign(new Error(), { code: 'EACCES' });
    return rm(...args);
  });
  const renamed = await manageSkills('update', targets, 'en', undefined, source);
  assert.equal(renamed.exitCode, 5);
  assert.equal(renamed.result.data?.targets[0].changed, true);
  assert.match(JSON.stringify(renamed), /cleanup/);
  assert.match(JSON.stringify(renamed), /rename/);
  await assert.rejects(fs.stat(targets[0].path));
});

test('Cancellation during replacement finishes current target and does not start the next', async (t) => {
  const root = await fs.realpath(temporary(t)),
    source = join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(join(source, 'SKILL.md'), 'new');
  const targets = targetPaths(['codex', 'claude'], context(root, {}));
  await manageSkills('install', targets, 'en', undefined, source);
  for (const target of targets) await fs.writeFile(join(target.path, 'SKILL.md'), 'old');
  const abort = new AbortController(),
    rm = fs.rm;
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    await rm(...args);
    if (args[0] === targets[0].path) abort.abort();
  });
  const result = await manageSkills('update', targets, 'en', abort.signal, source);
  assert.equal(result.exitCode, 130);
  assert.deepEqual(
    result.result.data?.targets.map((item) => item.state),
    ['updated', 'not_started'],
  );
  assert.equal(await fs.readFile(join(targets[0].path, 'SKILL.md'), 'utf8'), 'new');
  assert.equal(await fs.readFile(join(targets[1].path, 'SKILL.md'), 'utf8'), 'old');
});

test('Skill CLI uses plain text and rejects unsupported result options before writes', async (t) => {
  const root = temporary(t);
  const config = context(root, { UNISEARCH_LANG: 'en' });
  const run = async (args: string[]) => {
    const channels = capture();
    const exit = await createCli('test', { config, channels }).run(args);
    return { exit, channels };
  };
  const missing = await run(['skills', 'install']);
  assert.equal(missing.exit, 2);
  const status = await run(['skills', 'status', '--targets', 'codex']);
  assert.match(status.channels.out, /Codex: not installed/);
  const compactStatus = await run(['skills', 'status', '--targets', 'codex,claude']);
  assert.doesNotMatch(compactStatus.channels.out, /\n\n/);
  const [target] = targetPaths(['codex'], config);
  const rejected = await run([
    'skills',
    'install',
    '--targets',
    'codex',
    '--output',
    'result.json',
  ]);
  assert.equal(rejected.exit, 2);
  await assert.rejects(fs.stat(target.path));
  const installed = await run(['skills', 'install', '--targets', 'codex']);
  assert.equal(installed.exit, 0);
  assert.match(installed.channels.out, /Codex: installed/);
  assert.ok(installed.channels.out.replace(/\r?\n\s*/g, '').includes(target.path));
  assert.equal((await run(['skills', 'remove', '--targets', 'codex'])).exit, 0);
});

test('Unexpected read failures stop subsequent Skill targets', async (t) => {
  const root = await fs.realpath(temporary(t)),
    source = join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(join(source, 'SKILL.md'), 'skill');
  const targets = targetPaths(['codex', 'claude'], context(root));
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === targets[0].path) throw new TypeError('fixture programming failure');
    return lstat(...args);
  });
  const result = await manageSkills('install', targets, 'en', undefined, source);
  assert.equal(result.exitCode, 5);
  assert.equal(result.result.error?.code, 'INTERNAL_ERROR');
  assert.equal(result.result.data?.targets[1].state, 'not_started');
});

test('Skill preflight preserves unexpected errors and classifies filesystem failures', async (t) => {
  const root = temporary(t);
  const source = join(root, 'source');
  await fs.mkdir(source);
  const realpath = fs.realpath;
  let problem: Error = new TypeError('fixture programming failure');
  t.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
    if (args[0] === source) throw problem;
    return realpath(...args);
  });
  await assert.rejects(preflightSkills([], source), (error) => error === problem);
  problem = Object.assign(new Error('fixture IO failure'), { code: 'EACCES' });
  await assert.rejects(
    preflightSkills([], source),
    (error) => error instanceof AppError && error.code === 'FILE_IO_ERROR',
  );
});
