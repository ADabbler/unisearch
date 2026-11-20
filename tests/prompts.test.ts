import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';
import { once } from 'node:events';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';
import * as clack from '@clack/prompts';
import { terminalPrompts } from '../src/cli/prompts.js';
import { AppError } from '../src/errors.js';
import { text } from '../src/i18n/messages.js';
import { setupPreviewLines } from '../src/output/setup.js';
import { promptSetup, SetupDraft } from '../src/setup.js';
import { context, temporary } from './helpers.js';

const term = process.env.TERM;
before(() => {
  // readline treats editing keys as text under TERM=dumb; these fixtures model an interactive terminal.
  process.env.TERM = 'xterm-256color';
});
after(() => {
  if (term === undefined) delete process.env.TERM;
  else process.env.TERM = term;
});

function terminal(t: TestContext, columns = 80, rows = 24) {
  const input = new PassThrough();
  let content = '';
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        content += chunk.toString();
        callback();
      },
    }),
    { columns, rows },
  );
  const abort = new AbortController();
  t.after(() => {
    abort.abort();
    input.destroy();
    output.destroy();
  });
  return {
    input,
    output,
    abort,
    prompts: terminalPrompts(abort.signal, { input, output }),
    take() {
      const result = stripVTControlCharacters(content);
      content = '';
      return result;
    },
  };
}

const choices = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

test('Terminal choices place keys after the options and retain only the submitted selection', async (t) => {
  const f = terminal(t);
  const single = f.prompts.select('界面语言', choices, 'a', 'zh');
  const singleFrame = f.take().trimEnd().split('\n');
  assert.equal(singleFrame[1], `${clack.S_STEP_ACTIVE}  界面语言`);
  assert.deepEqual(singleFrame.slice(-3, -1), [
    `${clack.S_BAR}  ${clack.S_RADIO_INACTIVE} Beta`,
    clack.S_BAR,
  ]);
  assert.ok(singleFrame.at(-1)!.startsWith(`${clack.S_BAR_END}  `));
  f.input.write('\x1b[B');
  await setImmediate();
  f.take();
  f.input.write('\r');
  assert.equal(await single, 'b');
  assert.ok(f.take().trimEnd().endsWith(`${clack.S_BAR}  Beta`));

  const multi = f.prompts.multi(
    '服务',
    [
      { value: 'a', label: '模型搜索' },
      { value: 'b', label: 'Exa', description: '搜索、网页读取' },
    ],
    [],
    'zh',
  );
  const multiFrame = f.take().trimEnd().split('\n');
  assert.equal(multiFrame[1], `${clack.S_STEP_ACTIVE}  服务`);
  assert.deepEqual(multiFrame.slice(-3, -1), [
    `${clack.S_BAR}  ${clack.S_CHECKBOX_INACTIVE} Exa: 搜索、网页读取`,
    clack.S_BAR,
  ]);
  assert.ok(multiFrame.at(-1)!.startsWith(`${clack.S_BAR_END}  `));
  f.input.write(' \x1b[B ');
  await setImmediate();
  f.take();
  f.input.write('\r');
  assert.deepEqual(await multi, ['a', 'b']);
  const submitted = f.take();
  assert.ok(submitted.trimEnd().endsWith(`${clack.S_BAR}  模型搜索, Exa`));

  const targets = f.prompts.multi('Skill', choices, [], 'zh');
  f.take();
  f.input.write('\r');
  assert.deepEqual(await targets, []);
  assert.match(f.take(), /未选择/);
  f.abort.abort();
  assert.equal(f.take(), '');
});

test('Required source selection keeps the prompt open on empty Enter and accepts a selection', async (t) => {
  for (const language of ['zh', 'en'] as const) {
    const f = terminal(t, 28, 10);
    const result = f.prompts.multi(
      text(language, 'setupSelectSearchSources'),
      choices,
      [],
      language,
      (selected) => (selected?.length ? undefined : text(language, 'setupSearchSourcesRequired')),
    );
    f.take();
    f.input.write('\r');
    await setImmediate();
    const error = f
      .take()
      .replace(/^[│└] {2}/gm, '')
      .replace(/\s/g, '');
    const message = text(language, 'setupSearchSourcesRequired').replace(/\s/g, '');
    assert.ok(error.includes(language === 'zh' ? `（${message}）` : `(${message})`));
    assert.ok(error.lastIndexOf(message) < error.lastIndexOf('Alpha'));
    f.input.write(' \r');
    assert.deepEqual(await result, ['a']);
  }
});

test('A long configuration preview can be paged without losing its actions', async (t) => {
  const details = Array.from({ length: 8 }, (_, index) => `Change ${index + 1}`);
  for (const columns of [32, 24]) {
    const f = terminal(t, columns, 10);
    const menu = f.prompts.select('Preview', choices, 'a', 'en', { menu: { details } });
    const first = f.take();
    assert.ok(first.split('\n').length <= f.output.rows);
    assert.match(first, /Change 1/);
    assert.doesNotMatch(first, /Change 8/);
    f.input.write('\x1b[6~'.repeat(details.length));
    await setImmediate();
    assert.match(f.take(), /Change 8/);
    f.input.write('\x1b[5~'.repeat(details.length));
    await setImmediate();
    assert.match(f.take(), /Change 1/);
    f.input.write('\x1b[B\r');
    assert.equal(await menu, 'b');
  }
});

test('Narrow prompts wrap text and keep the guide on every line', { timeout: 5000 }, async (t) => {
  const f = terminal(t, 28);
  const result = f.prompts.select('界面语言', choices, 'a', 'zh');
  const frame = f.take().trimEnd().split('\n');
  assert.ok(frame.length > 4);
  assert.equal(frame[1], `${clack.S_STEP_ACTIVE}  界面语言`);
  for (const line of frame) {
    assert.ok(stringWidth(line) <= 28, line);
    assert.ok(
      [clack.S_BAR, clack.S_STEP_ACTIVE, clack.S_BAR_END].some((prefix) => line.startsWith(prefix)),
      line,
    );
  }
  f.input.write('\r');
  assert.equal(await result, 'a');
  f.take();
  const secret = 'fixture-hidden-secret';
  const input = f.prompts.input(
    '配置模型搜索 API Key（UNISEARCH_MODEL_API_KEY：fixt•••-key）',
    true,
    (value) => (value === secret ? undefined : 'API Key 必须是不含空白的非空字符串，请重新输入'),
    'zh',
  );
  const initial = f.take().trimEnd().split('\n');
  assert.ok(initial.length > 4);
  assert.ok(initial.at(-1)!.startsWith(`${clack.S_BAR_END}  请输入：`));
  assert.doesNotMatch(initial.at(-1)!, /请输入： /);
  for (const line of initial) {
    assert.ok(
      [clack.S_BAR, clack.S_STEP_ACTIVE, clack.S_BAR_END].some((prefix) => line.startsWith(prefix)),
      line,
    );
    assert.ok(stringWidth(line) <= 28, line);
  }
  f.input.write('bad\r');
  await setImmediate();
  const error = f.take();
  assert.match(error, /API Key/);
  assert.doesNotMatch(error, /bad/);
  assert.ok(error.includes(`${clack.S_BAR_END}  `));
  f.input.write('\x15' + secret + '\r');
  assert.equal(await input, secret);
  assert.doesNotMatch(f.take(), new RegExp(secret));

  const text = f.prompts.input(
    '配置 API 地址',
    false,
    () => undefined,
    'zh',
    'https://example.org/default',
  );
  const placeholderFrame = f
    .take()
    .split('\n')
    .map((line) => line.replace(/^[│└]  /, ''))
    .join('');
  assert.ok(placeholderFrame.includes('请输入：https://example.org/default'));
  const url = 'https://example.org/a/long/gateway/prefix';
  f.input.write(url);
  await setImmediate();
  assert.ok(f.take().includes(`${clack.S_BAR_END}  `));
  f.input.write('\r');
  assert.equal(await text, url);
  assert.match(f.take(), /https:\/\/example\.org\/a\/lon[\s\S]*g\/gateway\/prefix/);

  const retained = f.prompts.input(
    '配置 Tavily API 地址',
    false,
    () => undefined,
    'zh',
    'https://api.tavily.com',
  );
  f.take();
  f.input.write('\r');
  assert.equal(await retained, '');
  assert.match(f.take(), /https:\/\/api\.tavily\.com/);

  for (const [secret, placeholder] of [
    [false, 'dwa'],
    [true, 'fixt•••-key'],
    [true, '••••••••'],
  ] as const) {
    const kept = f.prompts.input(
      secret ? 'Configure API Key' : 'Configure model ID',
      secret,
      () => undefined,
      'en',
      placeholder,
    );
    const active = f.take();
    if (secret) assert.ok(!active.includes(placeholder));
    f.input.write('\r');
    assert.equal(await kept, '');
    assert.ok(f.take().includes(`${clack.S_BAR}  ${placeholder}`));
  }
});

test('Terminal choice lists scroll within the viewport and retain every selectable option', async (t) => {
  const f = terminal(t, 28, 10);
  const options = Array.from({ length: 17 }, (_, index) => ({
    value: String(index),
    label: `Target ${index}`,
  }));
  const result = f.prompts.multi('Skill targets', options, [], 'en');
  const first = f.take().trimEnd().split('\n');
  assert.ok(first.length <= 10);
  assert.ok(first.includes(`${clack.S_BAR}  ...`));
  f.input.write('\x1b[B'.repeat(16));
  await setImmediate();
  assert.match(f.take(), /Target 16/);
  f.input.write(' \r');
  assert.deepEqual(await result, ['16']);
});

test('Terminal Escape, Ctrl+C, Ctrl+D, EOF and abort cancel prompts and release listeners', async (t) => {
  for (const action of ['escape', 'ctrl-c', 'ctrl-d', 'eof', 'abort'] as const) {
    const f = terminal(t);
    const prompts = terminalPrompts(f.abort.signal, {
      input: f.input,
      output: f.output,
      backOnEscape: action !== 'escape',
    });
    const result = prompts.select('Protocol', choices, 'a', 'en');
    if (action === 'escape') f.input.write('\x1b');
    else if (action === 'ctrl-c') f.input.write('\x03');
    else if (action === 'ctrl-d') f.input.write('\x04');
    else if (action === 'eof') f.input.end();
    else f.abort.abort();
    await assert.rejects(
      result,
      (error: unknown) => error instanceof AppError && error.code === 'CANCELLED',
    );
    assert.equal(f.input.listenerCount('keypress'), 0);
    assert.equal(f.input.listenerCount('end'), 0);
    assert.equal(f.output.listenerCount('resize'), 0);
  }
});

test('Setup Escape returns to the parent menu until it reaches the main menu', async (t) => {
  const f = terminal(t);
  const root = temporary(t);
  const draft = new SetupDraft(
    { path: join(root, 'config.json'), source: 'default', exists: false, values: {} },
    context(root),
    'en',
  );
  const prompts = terminalPrompts(f.abort.signal, {
    input: f.input,
    output: f.output,
    backOnEscape: true,
  });
  const cancelled = assert.rejects(
    promptSetup(
      draft,
      prompts,
      setupPreviewLines,
      () => {},
      () => {},
    ),
    (error: unknown) => error instanceof AppError && error.code === 'CANCELLED',
  );
  const escape = async () => {
    const keypress = once(f.input, 'keypress');
    f.input.write('\x1b');
    await keypress;
    await setImmediate();
  };
  const heading = (key: Parameters<typeof text>[1]) => {
    assert.ok(f.take().includes(`${clack.S_STEP_ACTIVE}  ${text('en', key)}`));
  };

  heading('setupTitle');
  f.input.write('\x1b[B\r');
  await setImmediate();
  heading('setupSearch');
  f.input.write('\x1b[B\r');
  await setImmediate();
  heading('setupClassifierUrl');
  const url = 'https://example.org/v1';
  f.input.write(`${url}\r`);
  await setImmediate();
  heading('setupClassifierKey');
  f.input.write('fixture-unconfirmed-key');
  await escape();
  heading('setupSearch');
  assert.equal(draft.current('search.routing.classifier.base_url').value, url);
  assert.equal(draft.current('search.routing.classifier.api_key').value, undefined);

  f.input.write('\r');
  await setImmediate();
  heading('setupClassifierUrl');
  await escape();
  heading('setupSearch');
  await escape();
  heading('setupTitle');
  await escape();
  await cancelled;
});
