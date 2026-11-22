import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import stringWidth from 'fast-string-width';
import type { Command } from 'commander';
import { addContentOptions, createCli } from '../src/cli/program.js';
import { TerminalHelp } from '../src/cli/help.js';
import { capture, context, temporary } from './helpers.js';

test('Bare root, help aliases, and version follow Commander without configuration reads for version', async (t) => {
  const root = temporary(t);
  const outputs: string[] = [];
  for (const args of [[], ['--help'], ['-h']]) {
    const channels = capture();
    const cli = createCli('1.2.3', { channels, config: context(root, { UNISEARCH_LANG: 'en' }) });
    assert.equal(await cli.run(args), 0);
    assert.equal(channels.err, '');
    assert.match(channels.out, /\bunisearch\b/);
    assert.match(channels.out, /\bsetup\b/);
    outputs.push(channels.out);
  }
  assert.ok(outputs.every((value) => value === outputs[0]));
  for (const args of [['-V'], ['--version'], ['--help', '--version'], ['--version', '--help']]) {
    const channels = capture();
    const config = context(root, { UNISEARCH_LANG: 'bad', UNISEARCH_CONFIG_PATH: '' });
    assert.equal(await createCli('1.2.3', { channels, config }).run(args), 0);
    assert.equal(channels.out, 'unisearch 1.2.3\n');
    assert.equal(channels.err, '');
  }
});

test('Help uses the saved language and honors an environment override', async (t) => {
  const root = temporary(t);
  const path = join(root, 'config.json');
  writeFileSync(path, '{"language":"zh","providers":false}');
  for (const override of [undefined, 'en']) {
    const channels = capture();
    const config = context(root, { UNISEARCH_CONFIG_PATH: path, UNISEARCH_LANG: override });
    assert.equal(await createCli('1.2.3', { channels, config }).run(['--help']), 0);
    assert.equal(/^\p{Script=Han}/u.test(channels.out), override === undefined, channels.out);
    assert.match(channels.out, /--version/);
    assert.equal(channels.err, '');
  }
});

test('All help pages fit terminal columns in both languages without losing content', async (t) => {
  const root = temporary(t);
  const paths: string[][] = [];
  function collect(command: Command, path: string[]): void {
    paths.push(path);
    for (const child of command.commands) collect(child, [...path, child.name()]);
  }
  collect(createCli('1.2.3').program, []);
  for (const language of ['zh', 'en']) {
    for (const path of paths) {
      const usage = ['unisearch', ...path].join(' ');
      let content: string | undefined;
      for (const columns of [100, 40]) {
        const channels = capture();
        const cli = createCli('1.2.3', {
          channels,
          config: {
            ...context(root, { UNISEARCH_LANG: language }),
            home: () => join(root, '中文用户目录'),
          },
        });
        let command: Command = cli.program;
        for (const name of path) command = command.commands.find((child) => child.name() === name)!;
        command.configureOutput({ getOutHelpWidth: () => columns });
        const label = `${language} ${path.join(' ')} (${columns} columns)`;
        assert.equal(await cli.run([...path, '--help']), 0, label);
        assert.equal(channels.err, '', label);
        const lines = channels.out.split('\n');
        assert.ok(lines[0].includes(usage), label);
        for (const line of lines) {
          assert.ok(stringWidth(line) <= columns, `${label}: ${line}`);
          assert.doesNotMatch(line, /^\s*[。！？；，、：）》】」』”’〉〕｝\]})]/u, label);
        }
        const compact = channels.out.replace(/\s/g, '');
        content ??= compact;
        assert.equal(compact, content, label);
      }
    }
  }
});

test('Mixed help text uses Unicode line breaks', () => {
  const help = new TerminalHelp();
  const value = '中文说明。换行保留标点，括号（说明）与英文名称 Unicode';
  for (const width of [8, 12, 16]) {
    const wrapped = help.boxWrap(value, width);
    assert.equal(wrapped.replace(/\s/g, ''), value.replace(/\s/g, ''));
    for (const line of wrapped.split('\n')) {
      assert.ok(stringWidth(line) <= width);
      assert.doesNotMatch(line, /^[。！？；，、：）》】」』”’〉〕｝\]})]/u);
      assert.doesNotMatch(line, /[（《【「『“‘〈〔｛\[({]$/u);
    }
    assert.ok(wrapped.split('\n').some((line) => line.includes('Unicode')));
  }
});

test('Narrow help stacks descriptions and wide help aligns wrapped Chinese descriptions', async (t) => {
  const root = temporary(t);
  for (const columns of [60, 100]) {
    const channels = capture();
    const cli = createCli('1.2.3', {
      channels,
      config: context(root, { UNISEARCH_LANG: 'zh' }),
    });
    cli.program
      .command('sample')
      .description(
        '检查中文介绍在较窄终端中的换行位置和后续缩进，保留每一个汉字以及英文名称 Commander。',
      );
    cli.program.configureOutput({ getOutHelpWidth: () => columns });
    assert.equal(await cli.run(['--help']), 0);
    if (columns === 60) {
      assert.match(channels.out, /\n  sample\n    检查中文介绍/);
    } else {
      assert.match(channels.out, /\n  sample +检查中文介绍/);
      const lines = channels.out.split('\n');
      const index = lines.findIndex((line) => line.startsWith('  sample '));
      const descriptionColumn = lines[index]!.indexOf('检查');
      assert.equal(lines[index + 1]!.match(/^ */)![0].length, descriptionColumn);
    }
  }
});

test('Invalid input produces one result using the recognized format', async (t) => {
  const root = temporary(t);
  for (const args of [
    ['search', '--format', 'json'],
    ['search', 'query', '--format=json', '--unknown'],
    ['search', 'query', '--format=json', '--verbose', '--verbose'],
    ['search', 'query', '--format=json', '--output='],
    ['search', 'query', '--timeout=0', '--format=json'],
    ['status', '--json', '--unknown'],
    ['doctor', '--timeout=0', '--json'],
    ['config', 'list', '--format=json'],
    ['config', 'get'],
  ]) {
    const channels = capture();
    const cli = createCli('1.2.3', { channels, config: context(root, { UNISEARCH_LANG: 'en' }) });
    assert.equal(await cli.run(args), 2, args.join(' '));
    const result = JSON.parse(channels.out);
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
    assert.equal(channels.err, '');
    assert.doesNotMatch(channels.out, /\u001b/);
  }
  for (const args of [
    ['--format'],
    ['--format=xml'],
    ['unknown-command'],
    ['unknown-command', '--help'],
    ['unknown-command', '--version'],
    ['search', 'query', '--format=json', '--format=markdown'],
    ['search', 'query', '--format=json', '--format'],
    ['search', 'query', '--format=xml'],
    ['status', '--unknown'],
  ]) {
    const channels = capture();
    const cli = createCli('1.2.3', { channels, config: context(root, { UNISEARCH_LANG: 'en' }) });
    assert.equal(await cli.run(args), 2);
    assert.equal(channels.out, '');
    assert.ok(channels.err.trim());
  }
});

test('Language failures use the public error shell and do not expose config contents', async (t) => {
  const root = temporary(t);
  const path = join(root, 'config.json');
  writeFileSync(path, '{"api_key":"fake-secret",');
  const channels = capture();
  const cli = createCli('1.2.3', {
    channels,
    config: context(root, { UNISEARCH_CONFIG_PATH: path }),
  });
  assert.equal(await cli.run(['config', 'list']), 3);
  assert.equal(JSON.parse(channels.out).error.code, 'CONFIG_PARSE_ERROR');
  assert.doesNotMatch(channels.out, /fake-secret|SyntaxError/);
  assert.equal(channels.err, '');
});

test('Operation options accept both argument positions, detect duplicates, and honor --', async (t) => {
  const root = temporary(t);
  for (const args of [
    ['source', 'read', '--format=json', 'hello'],
    ['source', 'read', 'hello', '--format=json'],
    ['source', 'read', '--format=json', '--', '--help'],
  ]) {
    const channels = capture();
    const cli = createCli('1.2.3', { channels, config: context(root, { UNISEARCH_LANG: 'en' }) });
    let value: string | undefined;
    const command = cli.program.command('source').command('read <value>');
    addContentOptions(command);
    command.action((input) => {
      value = input;
    });
    assert.equal(await cli.run(args), 0);
    assert.equal(command.optsWithGlobals().format, 'json');
    assert.equal(value, args.includes('--') ? '--help' : 'hello');
    assert.equal(channels.out, '');
  }
  for (const args of [
    ['--format=json', 'source', 'read', 'x'],
    ['source', '--format=json', 'read', 'x'],
    ['--format=json', 'source', 'read', 'x', '--format=json'],
    ['source', 'read', 'x', '--format=json', '--format=json'],
    ['source', 'read'],
  ]) {
    const channels = capture();
    const cli = createCli('1.2.3', { channels, config: context(root, { UNISEARCH_LANG: 'en' }) });
    const command = cli.program
      .command('source')
      .command('read <value>')
      .action(() => assert.fail('No action for invalid input'));
    addContentOptions(command);
    assert.equal(await cli.run(args), 2);
  }
  const outputs: string[] = [];
  for (const args of [['source'], ['source', '--help']]) {
    const channels = capture();
    const cli = createCli('1.2.3', { channels, config: context(root, { UNISEARCH_LANG: 'en' }) });
    cli.program.command('source').command('read <value>');
    assert.equal(await cli.run(args), 0);
    outputs.push(channels.out);
  }
  assert.equal(outputs[0], outputs[1]);
  assert.match(outputs[0], /unisearch source/);
});

test('Command handlers share output options and propagate failure exits to the CLI', async (t) => {
  const root = temporary(t);
  for (const save of [false, true]) {
    const channels = capture();
    const cli = createCli('1.2.3', { channels, config: context(root, { UNISEARCH_LANG: 'en' }) });
    let calls = 0;
    const command = cli.program.command('sample').action(() =>
      cli.runOperation(async () => {
        calls++;
        return {
          result: {
            status: 'partial',
            data: ['retained'],
            error: { code: 'PARTIAL_FAILURE', message: 'One task failed.' },
          },
          exitCode: 6,
        };
      }),
    );
    addContentOptions(command);
    const args = ['sample', '--format=json'];
    if (save) args.push('--output', 'result.json');
    assert.equal(await cli.run(args), 6);
    assert.equal(calls, 1);
    const result = JSON.parse(
      save ? readFileSync(join(root, 'result.json'), 'utf8') : channels.out,
    );
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.data, ['retained']);
    if (save) {
      assert.equal(channels.out, '');
      assert.match(channels.err, /result.json/);
    } else assert.equal(channels.err, '');
  }
});
