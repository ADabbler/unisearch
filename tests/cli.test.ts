import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import stringWidth from 'fast-string-width';
import type { Command } from 'commander';
import { addContentOptions, createCli } from '../src/cli/program.js';
import { TerminalHelp } from '../src/cli/help.js';
import { capture, context, temporary } from './helpers.js';

test('Bare root, help aliases, and version follow Commander without configuration reads for version', async (t) => {
  const root = temporary(t);
  const outputs: string[] = [];
  for (const args of [[], ['--help'], ['-h'], ['-h', '--help']]) {
    const channels = capture();
    const cli = createCli('1.2.3', { channels, config: context(root, { UNISEARCH_LANG: 'en' }) });
    assert.equal(await cli.run(args), 0);
    assert.equal(channels.err, '');
    assert.match(channels.out, /^Usage: unisearch/);
    assert.doesNotMatch(channels.out, /--lang/);
    assert.match(channels.out, /\bsetup\b/);
    assert.doesNotMatch(channels.out, /--format|--output|--verbose|--timeout/);
    assert.match(channels.out, /\bexa\b/);
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

test('Saved Chinese language changes help, not option names', async (t) => {
  const root = temporary(t);
  const path = join(root, 'config.json');
  writeFileSync(path, '{"language":"zh","providers":false}');
  const channels = capture();
  assert.equal(
    await createCli('1.2.3', {
      channels,
      config: context(root, { UNISEARCH_CONFIG_PATH: path }),
    }).run(['--help']),
    0,
  );
  assert.match(channels.out, /^用法：/);
  assert.doesNotMatch(channels.out, /--format/);
  assert.match(channels.out, /显示版本/);
  assert.equal(channels.err, '');
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
      let content: string | undefined;
      for (const columns of [120, 80, 60, 40]) {
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
        for (const line of channels.out.split('\n')) {
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

test('Parent help shows summaries while command help retains details after usage', async (t) => {
  const root = temporary(t);
  for (const language of ['zh', 'en']) {
    for (const [path, present] of [
      [
        [],
        language === 'zh'
          ? '联网诊断全部服务或指定服务'
          : 'Run online diagnostics for all services or a specified service',
      ],
      [['config'], language === 'zh' ? '保存一个配置项' : 'Save a configuration field'],
      [['tinyfish'], language === 'zh' ? '批量读取网页正文' : 'Read content from multiple pages'],
    ] as const) {
      const channels = capture();
      assert.equal(
        await createCli('1.2.3', {
          channels,
          config: context(root, { UNISEARCH_LANG: language }),
        }).run([...path, '--help']),
        0,
      );
      assert.ok(channels.out.replace(/\s+/g, ' ').includes(present));
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
    ['status', '--json', '--unknown'],
    ['doctor', '--json', '--timeout=0'],
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
    assert.doesNotMatch(channels.out, /Usage:|\u001b/);
  }
  for (const args of [
    ['--format'],
    ['--format=xml'],
    ['unknown-command'],
    ['search', 'query', '--format=json', '--format=markdown'],
    ['search', 'query', '--format=json', '--format'],
    ['search', 'query', '--format=xml'],
    ['status', '--unknown'],
    ['list', '--help'],
    ['list', '-h'],
    ['list', '--version'],
    ['list', '-V'],
    ['exa', 'list', '--help'],
    ['exa', 'list', '-h'],
    ['exa', 'list', '--version'],
    ['exa', 'list', '-V'],
  ]) {
    const channels = capture();
    const cli = createCli('1.2.3', { channels, config: context(root, { UNISEARCH_LANG: 'en' }) });
    assert.equal(await cli.run(args), 2);
    assert.equal(channels.out, '');
    assert.match(channels.err, /^Error:/);
    assert.doesNotMatch(channels.err, /\[INVALID_ARGUMENT\]|^>/);
  }
  const help = capture();
  assert.equal(
    await createCli('1.2.3', {
      channels: help,
      config: context(root, { UNISEARCH_LANG: 'en' }),
    }).run(['config', 'list', '--help']),
    0,
  );
  assert.match(help.out, /^Usage: unisearch config list/);
  assert.equal(help.err, '');
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
  assert.doesNotMatch(channels.out, /fake-secret|Usage:|SyntaxError/);
  assert.equal(channels.err, '');
});

test('Invalid format uses stderr when language selection also fails', async (t) => {
  const root = temporary(t);
  const channels = capture();
  const cli = createCli('1.2.3', {
    channels,
    config: context(root, { UNISEARCH_LANG: 'invalid' }),
  });
  assert.equal(await cli.run(['search', 'query', '--format=invalid']), 3);
  assert.equal(channels.out, '');
  assert.match(channels.err, /^Error: Interface language/);
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

test('Compiled entry works outside the source directory with UTF-8 paths', (t) => {
  const root = temporary(t);
  const path = join(root, '中文 config.json');
  writeFileSync(path, '{"language":"zh"}');
  const env: NodeJS.ProcessEnv = { ...process.env, UNISEARCH_CONFIG_PATH: path };
  delete env.UNISEARCH_LANG;
  const result = spawnSync(process.execPath, [resolve('dist/cli.js'), '--help'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^用法：/);
  assert.equal(result.stderr, '');
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const version = spawnSync(process.execPath, [resolve('dist/cli.js'), '--version'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(version.stdout, `unisearch ${manifest.version}\n`);
});

test('All 41 operations expose and enforce the confirmed option matrix', async (t) => {
  const root = temporary(t);
  const content = new Set([
    'search',
    'fetch',
    'map',
    'exa search',
    'exa fetch',
    'ctx7 library',
    'ctx7 docs',
    'anysearch search',
    'anysearch domains',
    'anysearch extract',
    'tavily search',
    'tavily extract',
    'tavily map',
    'firecrawl search',
    'firecrawl scrape',
    'firecrawl map',
    'jina search',
    'jina fetch',
    'zhipu search',
    'zhipu fetch',
    'zhipu-mcp search',
    'zhipu-mcp fetch',
    'zhipu-mcp docs',
    'zhipu-mcp tree',
    'zhipu-mcp read-file',
    'tinyfish search',
    'tinyfish fetch',
    'deepseek search',
    'deepseek fetch',
  ]);
  const local = new Set([
    'status',
    'doctor',
    'setup',
    'config path',
    'config list',
    'config get',
    'config set',
    'config unset',
    'skills install',
    'skills status',
    'skills update',
    'skills remove',
  ]);
  const paths: string[][] = [];
  const visit = (command: Command, path: string[]) => {
    const name = path.join(' ');
    const flags = command.options.map((option) => option.long);
    let expected: string[] = [];
    if (content.has(name)) expected = ['--format', '--output', '--verbose', '--timeout'];
    else if (name === 'doctor') expected = ['--json', '--verbose', '--timeout'];
    else if (name === 'status') expected = ['--json'];
    for (const flag of ['--format', '--output', '--verbose', '--timeout', '--json'])
      assert.equal(flags.includes(flag), expected.includes(flag), `${name} ${flag}`);
    if (!command.commands.length) {
      assert.ok(content.has(name) || local.has(name), name);
      paths.push(path);
    }
    for (const child of command.commands) visit(child, [...path, child.name()]);
  };
  visit(createCli('test').program, []);
  assert.equal(paths.length, 41);
  for (const path of paths) {
    const name = path.join(' ');
    let unsupported: string[];
    if (content.has(name)) unsupported = ['--json'];
    else if (name === 'doctor') unsupported = ['--format=json', '--output=report'];
    else if (name === 'status')
      unsupported = ['--format=json', '--output=report', '--verbose', '--timeout=1'];
    else unsupported = ['--format=json', '--output=report', '--verbose', '--timeout=1', '--json'];
    for (const flag of unsupported) {
      const channels = capture();
      const cli = createCli('test', { config: context(root, { UNISEARCH_LANG: 'en' }), channels });
      assert.equal(await cli.run([...path, flag]), 2, `${name} ${flag}`);
      if (['config list', 'config get'].includes(name)) {
        assert.equal(JSON.parse(channels.out).error.code, 'INVALID_ARGUMENT');
        assert.equal(channels.err, '');
      } else {
        assert.equal(channels.out, '');
        assert.match(channels.err, /^Error:/);
      }
    }
  }
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
