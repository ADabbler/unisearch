import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { AppError, failure } from '../src/errors.js';
import { success } from '../src/result.js';
import type { Outcome } from '../src/result.js';
import { display, execute, writeText } from '../src/output/index.js';
import { render } from '../src/output/render.js';
import type { OutputOptions } from '../src/output/index.js';
import { capture, temporary } from './helpers.js';

const body = '# Original answer\n\n[Source](https://example.com)\n\n```js\nconst value = 1;\n```\n';
const options: OutputOptions<string> = {
  language: 'zh',
  format: 'markdown',
  renderData: (value) => value,
};
const partial: Outcome<string> = {
  result: {
    status: 'partial',
    data: body,
    error: {
      code: 'PARTIAL_FAILURE',
      message: '一项补充检索失败。',
      details: {
        failures: [{ provider: 'sample', code: 'TIMEOUT', message: 'Upstream timeout' }],
      },
    },
  },
  exitCode: 6,
};
const failed: Outcome<string> = {
  result: { status: 'error', data: body, error: { code: 'TIMEOUT', message: 'Upstream timeout' } },
  exitCode: 4,
};

test('result shapes preserve empty data, partial results, failures, and cancellation', async () => {
  const empty = capture();
  assert.equal(await display(success([]), { language: 'en', format: 'json' }, empty), 0);
  assert.deepEqual(JSON.parse(empty.out), { status: 'success', data: [] });
  const withEmptyMeta = success([]);
  withEmptyMeta.result.meta = {};
  assert.deepEqual(JSON.parse(render(withEmptyMeta, { language: 'en', format: 'json' }).content), {
    status: 'success',
    data: [],
  });
  const cancelled = failure(new AppError('CANCELLED', 'cancelled'), 'zh', success(body));
  for (const outcome of [success(body), partial, failed, cancelled]) {
    const channels = capture();
    assert.equal(
      await display(outcome, { ...options, format: 'json' }, channels),
      outcome.exitCode,
    );
    assert.deepEqual(JSON.parse(channels.out), outcome.result);
    assert.equal(channels.err, '');
  }
  const unknown = failure(new Error('secret=do-not-print'), 'en');
  assert.equal(unknown.result.error?.code, 'INTERNAL_ERROR');
  assert.equal(unknown.exitCode, 5);
  assert.doesNotMatch(JSON.stringify(unknown), /do-not-print/);
});

test('failure composition keeps the incoming error causes and previous failure', () => {
  const cause = { code: 'CLEANUP_FAILURE', message: 'The temporary file could not be removed.' };
  const error = new AppError('FILE_IO_ERROR', 'fileIO', { causes: [cause] });
  const outcome = failure(error, 'en', partial);
  assert.equal(outcome.exitCode, 5);
  assert.equal(outcome.result.data, body);
  assert.deepEqual(outcome.result.error?.details?.causes, [cause, partial.result.error]);
  assert.deepEqual(error.details?.causes, [cause]);
});

test('Markdown preserves original content and necessary failure summaries', async () => {
  const channels = capture();
  assert.equal(await display(partial, options, channels), 6);
  assert.match(channels.out, /^> 部分完成:/);
  assert.match(channels.out, /sample: \[TIMEOUT\] Upstream timeout/);
  assert.ok(channels.out.endsWith(body));
  const plain = capture();
  await display(success(body), options, plain);
  assert.equal(plain.out, body);
  assert.equal(plain.err, '');
});

test('plain text routes errors to stderr and retains completed results for partial failure and cancellation', async () => {
  const renderData = (value: string) => value;
  for (const outcome of [
    failure<string>(new AppError('TIMEOUT', 'requestTimeout', { provider: 'exa' }), 'en'),
    {
      result: {
        status: 'partial',
        data: 'Codex: installed',
        error: { code: 'SKILL_TARGETS_FAILED', message: 'One target failed' },
      },
      exitCode: 6,
    } as Outcome<string>,
    failure(new AppError('CANCELLED', 'cancelled'), 'en', success('Saved execution.retries = 2')),
  ]) {
    const channels = capture();
    assert.equal(
      await display(outcome, { language: 'en', format: 'text', renderData }, channels),
      outcome.exitCode,
    );
    assert.equal(channels.out, outcome.result.data === undefined ? '' : outcome.result.data + '\n');
    assert.match(channels.err, /^Error:|^Partial completion:/);
    assert.doesNotMatch(channels.err, /\[(TIMEOUT|CANCELLED|SKILL_TARGETS_FAILED)\]|^>/);
  }
  const channels = capture();
  await display(
    failure<string>(new AppError('TIMEOUT', 'requestTimeout'), 'en'),
    { ...options, language: 'en' },
    channels,
  );
  assert.equal(channels.out, '');
  assert.equal(channels.err, 'Error: The request timed out\n');
});

test('verbose views use one details object without changing normal data', async () => {
  let detailRenders = 0;
  const execution = {
    data: { elapsed_ms: 12 },
    markdown: (value: { [key: string]: unknown }) => {
      detailRenders++;
      return `elapsed_ms: ${value.elapsed_ms}`;
    },
  };
  const ordinary = capture();
  await display(success(body), { ...options, execution }, ordinary);
  assert.equal(detailRenders, 0);
  assert.equal(ordinary.out, body);
  const markdown = capture();
  await display(success(body), { ...options, execution, verbose: true }, markdown);
  assert.equal(markdown.out, body);
  assert.equal(markdown.err, 'elapsed_ms: 12\n');
  const json = capture();
  await display(success(body), { ...options, format: 'json', execution, verbose: true }, json);
  assert.deepEqual(JSON.parse(json.out), {
    status: 'success',
    data: body,
    meta: { elapsed_ms: 12 },
  });
  assert.equal(json.err, '');
  assert.equal(detailRenders, 1);
});

test('saving success, partial, and error-with-data suppresses stdout and preserves exit status', async (t) => {
  const root = temporary(t);
  const path = join(root, '中文 output.md');
  for (const outcome of [success(body), partial, failed]) {
    await fs.writeFile(path, 'old');
    let calls = 0;
    const channels = capture();
    assert.equal(
      await execute(
        async () => {
          calls++;
          return outcome;
        },
        { ...options, output: path },
        channels,
      ),
      outcome.exitCode,
    );
    assert.equal(calls, 1);
    assert.equal(channels.out, '');
    assert.equal(await fs.readFile(path, 'utf8'), render(outcome, options).content);
    if (outcome.exitCode === 0) assert.equal(channels.err, '');
    else assert.ok(channels.err.includes(path));
    assert.deepEqual(await fs.readdir(root), ['中文 output.md']);
  }
  const channels = capture();
  await execute(async () => partial, { ...options, output: path, format: 'json' }, channels);
  assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), partial.result);
});

test('no-data failure and cancellation keep the existing file', async (t) => {
  const root = temporary(t);
  const path = join(root, 'result.json');
  await fs.writeFile(path, 'old');
  for (const outcome of [
    failure<string>(new AppError('INVALID_CONFIG', 'invalidLanguage'), 'en'),
    failure(new AppError('CANCELLED', 'cancelled'), 'en', success(body)),
  ]) {
    const channels = capture();
    assert.equal(
      await execute(async () => outcome, { ...options, format: 'json', output: path }, channels),
      outcome.exitCode,
    );
    assert.deepEqual(JSON.parse(channels.out), outcome.result);
    assert.equal(await fs.readFile(path, 'utf8'), 'old');
    assert.deepEqual(await fs.readdir(root), ['result.json']);
  }
});

test('cancellation around output preparation, writing and rename preserves the exact commit boundary', async (t) => {
  const root = temporary(t);
  const path = join(root, 'result.json');
  for (const phase of [
    'prepare',
    'write',
    'before-rename',
    'rename',
    'rename-failure',
    'cleanup',
  ]) {
    await fs.writeFile(path, 'old');
    const abort = new AbortController();
    const originalOpen = fs.open;
    const originalRename = fs.rename;
    const open = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (phase === 'prepare') abort.abort();
      const write = handle.writeFile.bind(handle);
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'writeFile', async (...args: Parameters<typeof handle.writeFile>) => {
        await write(...args);
        if (phase === 'write') abort.abort();
      });
      t.mock.method(handle, 'close', async () => {
        await close();
        if (phase === 'before-rename') abort.abort();
      });
      return handle;
    });
    const rename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (phase === 'rename-failure') {
        abort.abort();
        throw Object.assign(new Error(), { code: 'EACCES' });
      }
      if (phase === 'rename') abort.abort();
      await originalRename(...args);
      if (phase === 'cleanup') abort.abort();
    });
    const channels = capture();
    let calls = 0;
    try {
      const code = await execute(
        async () => {
          calls++;
          return success(body);
        },
        { ...options, format: 'json', output: path, signal: abort.signal },
        channels,
      );
      assert.equal(code, 130, phase);
      assert.equal(calls, phase === 'prepare' ? 0 : 1);
      const result = JSON.parse(channels.out);
      assert.equal(result.error.code, 'CANCELLED');
      const saved = phase === 'rename' || phase === 'cleanup';
      assert.equal(result.error.details?.output_saved, saved ? true : undefined);
      if (saved) {
        assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).status, 'success');
        assert.equal(result.error.details.path, path);
      } else assert.equal(await fs.readFile(path, 'utf8'), 'old');
      if (phase === 'rename-failure')
        assert.equal(result.error.details.causes[0].code, 'FILE_IO_ERROR');
      assert.equal(channels.err, '');
      assert.deepEqual(await fs.readdir(root), ['result.json']);
    } finally {
      open.mock.restore();
      rename.mock.restore();
    }
  }
});

test('cancellation only renders again when cleanup changes the report and preserves the input outcome', async (t) => {
  const root = temporary(t);
  const path = join(root, 'result.md');
  await fs.writeFile(path, 'old');
  for (const cleanupFails of [false, true]) {
    if (cleanupFails) {
      t.mock.method(fs, 'unlink', async () => {
        throw Object.assign(new Error(), { code: 'EACCES' });
      });
    }
    const outcome = failure(new AppError('CANCELLED', 'cancelled'), 'en', success(body));
    const original = structuredClone(outcome);
    const channels = capture();
    let renders = 0;
    const code = await execute(
      async () => outcome,
      {
        ...options,
        output: path,
        renderData: (value) => {
          renders++;
          return value;
        },
      },
      channels,
    );
    assert.equal(code, 130);
    assert.equal(renders, cleanupFails ? 2 : 1);
    assert.deepEqual(outcome, original);
    assert.equal(await fs.readFile(path, 'utf8'), 'old');
    if (cleanupFails) assert.match(channels.out, /FILE_IO_ERROR/);
  }
});

test('bad output directories stop the operation before it starts', async (t) => {
  const root = temporary(t);
  for (const path of [join(root, 'missing', 'result'), root]) {
    let calls = 0;
    const channels = capture();
    const code = await execute(
      async () => {
        calls++;
        return success(body);
      },
      { ...options, format: 'json', output: path },
      channels,
    );
    assert.equal(code, 5);
    assert.equal(calls, 0);
    assert.equal(JSON.parse(channels.out).error.code, 'FILE_IO_ERROR');
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test('valid long output filenames do not exceed the temporary filename limit', async (t) => {
  const root = temporary(t);
  const name = 'report-'.repeat(32) + '.md';
  const path = join(root, name);
  await fs.writeFile(path, 'old');
  const channels = capture();
  assert.equal(await execute(async () => success(body), { ...options, output: path }, channels), 0);
  assert.equal(await fs.readFile(path, 'utf8'), body);
  assert.deepEqual(await fs.readdir(root), [name]);
  assert.equal(channels.out, '');
  assert.equal(channels.err, '');
});

test('temporary-file creation errors stop the operation', async (t) => {
  const root = temporary(t);
  const path = join(root, 'result');
  await fs.writeFile(path, 'old');
  t.mock.method(fs, 'open', async () => {
    throw Object.assign(new Error('fake-secret'), { code: 'EACCES' });
  });
  const channels = capture();
  assert.equal(
    await execute(
      async () => {
        assert.fail('Must not start');
      },
      { ...options, format: 'json', output: path },
      channels,
    ),
    5,
  );
  assert.equal(JSON.parse(channels.out).error.details.system_code, 'EACCES');
  assert.doesNotMatch(channels.out, /fake-secret/);
  assert.equal(await fs.readFile(path, 'utf8'), 'old');
});

test('write failure preserves old content and acquired data', async (t) => {
  const root = temporary(t);
  const path = join(root, 'result');
  await fs.writeFile(path, 'old');
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    t.mock.method(handle, 'writeFile', async () => {
      throw Object.assign(new Error(), { code: 'ENOSPC' });
    });
    return handle;
  });
  const channels = capture();
  assert.equal(
    await execute(
      async () => success(body),
      { ...options, format: 'json', output: path },
      channels,
    ),
    5,
  );
  const result = JSON.parse(channels.out);
  assert.equal(result.data, body);
  assert.equal(result.error.details.system_code, 'ENOSPC');
  assert.equal(await fs.readFile(path, 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(root), ['result']);
});

test('replacement failure retains previous failure reasons and removes the temporary file', async (t) => {
  const root = temporary(t);
  const path = join(root, 'result');
  await fs.writeFile(path, 'old');
  t.mock.method(fs, 'rename', async () => {
    throw Object.assign(new Error(), { code: 'EACCES' });
  });
  const channels = capture();
  assert.equal(
    await execute(async () => partial, { ...options, format: 'json', output: path }, channels),
    5,
  );
  const result = JSON.parse(channels.out);
  assert.equal(result.data, body);
  assert.equal(result.error.code, 'FILE_IO_ERROR');
  assert.equal(result.error.details.causes[0].code, 'PARTIAL_FAILURE');
  assert.equal(await fs.readFile(path, 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(root), ['result']);
});

test('cleanup failure reports the temporary file path', async (t) => {
  const root = temporary(t);
  t.mock.method(fs, 'unlink', async () => {
    throw Object.assign(new Error(), { code: 'EACCES' });
  });
  const channels = capture();
  const original = failure<string>(new AppError('INVALID_CONFIG', 'invalidLanguage'), 'en');
  assert.equal(
    await execute(
      async () => original,
      { ...options, format: 'json', output: join(root, 'result') },
      channels,
    ),
    5,
  );
  const error = JSON.parse(channels.out).error;
  assert.equal(error.details.operation, 'cleanup');
  assert.ok(error.details.path.startsWith(root));
  assert.equal(error.details.causes[0].code, 'INVALID_CONFIG');
  assert.equal((await fs.readdir(root)).length, 1);
});

test('render failures report an error, retain serializable data, and do not replace a target', async (t) => {
  const root = temporary(t);
  const path = join(root, 'result');
  await fs.writeFile(path, 'old');
  const channels = capture();
  assert.equal(
    await execute(
      async () => partial,
      {
        ...options,
        output: path,
        renderData: () => {
          throw new Error('fake-secret');
        },
      },
      channels,
    ),
    5,
  );
  assert.match(channels.out, /RENDER_ERROR/);
  assert.match(channels.out, /PARTIAL_FAILURE/);
  assert.match(channels.out, /已取得的数据/);
  assert.doesNotMatch(channels.out, /fake-secret/);
  assert.equal(await fs.readFile(path, 'utf8'), 'old');
  const invalid = capture();
  assert.equal(await display(success(Number.NaN), { language: 'en', format: 'json' }, invalid), 5);
  const result = JSON.parse(invalid.out);
  assert.equal(result.error.code, 'RENDER_ERROR');
  assert.equal('data' in result, false);
  assert.match(result.error.message, /could not be serialized/);
});

test('a renderer failure without a file is reported once and cannot turn into success', async () => {
  for (const renderer of ['renderData', 'renderText'] as const) {
    const channels = capture();
    let renders = 0;
    const exit = await execute(
      async () => success(body),
      {
        ...options,
        format: renderer === 'renderText' ? 'text' : 'markdown',
        [renderer]: () => {
          if (++renders === 1) throw new Error('first render failed');
          return 'incorrect second success';
        },
      },
      channels,
    );
    assert.equal(exit, 5);
    assert.equal(renders, 1);
    const output = channels.out + channels.err;
    assert.match(output, /RENDER_ERROR|结果渲染失败/);
    assert.doesNotMatch(output, /incorrect second success/);
  }
});

test('stream errors are handled and result in a nonzero exit', async () => {
  const stream = new Writable({
    write(_chunk, _encoding, done) {
      done(Object.assign(new Error(), { code: 'EPIPE' }));
    },
  });
  await assert.rejects(writeText(stream, 'hello'), { code: 'EPIPE' });
  const channels = capture();
  channels.stdout = async () => {
    throw Object.assign(new Error(), { code: 'EPIPE' });
  };
  assert.equal(await display(success(body), options, channels), 5);
  assert.match(channels.err, /文件或输出通道操作失败/);
  assert.match(channels.err, /EPIPE/);
  assert.ok(channels.err.endsWith(body));

  const closed = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  closed.destroy();
  await once(closed, 'close');
  await assert.rejects(writeText(closed, 'hello'), { code: 'ERR_STREAM_DESTROYED' });
  assert.equal(closed.listenerCount('error'), 0);
});
