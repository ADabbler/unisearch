import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';
import * as clack from '@clack/prompts';
import { terminalPrompts } from '../src/cli/prompts.js';
import { AppError } from '../src/errors.js';

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

test('terminal choices end the guide on the last option and show each keyboard hint once', async (t) => {
  const f = terminal(t);
  const first = f.prompts.select('界面语言', choices, 'b', 'zh');
  const firstFrame = f.take();
  assert.match(firstFrame, /↑↓ 移动，回车确认，Esc 取消/);
  assert.ok(firstFrame.split('\n')[1].startsWith(`${clack.S_STEP_ACTIVE}  界面语言 （↑↓`));
  assert.ok(firstFrame.endsWith(`${clack.S_BAR_END}  ${clack.S_RADIO_ACTIVE} Beta\n`));
  f.input.write('\r');
  assert.equal(await first, 'b');
  f.take();

  const next = f.prompts.select('协议', choices, 'a', 'zh');
  assert.doesNotMatch(f.take(), /↑↓|Esc/);
  f.input.write('\x1b[B\r');
  assert.equal(await next, 'b');
  f.take();

  const multi = f.prompts.multi(
    '服务',
    [
      { value: 'a', label: '模型搜索' },
      { value: 'b', label: 'Exa', description: '搜索、网页读取' },
    ],
    [],
    'zh',
  );
  const multiFrame = f.take();
  assert.match(multiFrame, /空格选择/);
  assert.ok(
    multiFrame.endsWith(`${clack.S_BAR_END}  ${clack.S_CHECKBOX_INACTIVE} Exa: 搜索、网页读取\n`),
  );
  f.input.write(' \x1b[B ');
  await setImmediate();
  f.take();
  f.input.write('\r');
  assert.deepEqual(await multi, ['a', 'b']);
  const submitted = f.take();
  assert.match(submitted, /模型搜索, Exa/);
  assert.doesNotMatch(submitted, /网页读取/);

  const targets = f.prompts.multi('Skill', choices, [], 'zh');
  assert.doesNotMatch(f.take(), /↑↓|空格选择|Esc/);
  f.input.write('\r');
  assert.deepEqual(await targets, []);
  assert.match(f.take(), /未选择/);
});

test('narrow prompts wrap text and keep the guide on every line', { timeout: 5000 }, async (t) => {
  const f = terminal(t, 28);
  const result = f.prompts.select('界面语言', choices, 'a', 'zh');
  const frame = f.take().trimEnd().split('\n');
  assert.ok(frame.length > 4);
  assert.ok(frame[1].startsWith(`${clack.S_STEP_ACTIVE}  界面语言 （↑↓`));
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
    '请输入：',
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
    '请输入：',
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
    '请输入：',
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
      'Enter: ',
      placeholder,
    );
    const active = f.take();
    if (secret) assert.ok(!active.includes(placeholder));
    f.input.write('\r');
    assert.equal(await kept, '');
    assert.ok(f.take().includes(`${clack.S_BAR}  ${placeholder}`));
  }
});

test('terminal choice lists scroll within the viewport and retain every selectable option', async (t) => {
  const f = terminal(t, 28, 10);
  const options = Array.from({ length: 17 }, (_, index) => ({
    value: String(index),
    label: `Target ${index}`,
  }));
  const result = f.prompts.multi('Skill targets', options, [], 'en');
  const first = f.take().trimEnd().split('\n');
  assert.ok(first.length <= 10);
  assert.equal(first.at(-1), `${clack.S_BAR_END}  ...`);
  f.input.write('\x1b[B'.repeat(16));
  await setImmediate();
  assert.match(f.take(), /Target 16/);
  f.input.write(' \r');
  assert.deepEqual(await result, ['16']);
});

test('terminal Escape, Ctrl+C, Ctrl+D, EOF and abort cancel prompts and release listeners', async (t) => {
  for (const action of ['escape', 'ctrl-c', 'ctrl-d', 'eof', 'abort'] as const) {
    const f = terminal(t);
    const result = f.prompts.select('Protocol', choices, 'a', 'en');
    assert.match(f.take(), /↑↓ move, Enter confirm, Esc cancel/);
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
