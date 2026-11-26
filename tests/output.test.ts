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

test('Result shapes preserve empty data, partial results, failures, and cancellation', async () => {
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
    assert.deepEqual(
      Object.keys(JSON.parse(channels.out)),
      outcome.result.error ? ['status', 'error', 'data'] : ['status', 'data'],
    );
    assert.equal(channels.err, '');
  }
  const unknown = failure(new Error('secret=do-not-print'), 'en');
  assert.equal(unknown.result.error?.code, 'INTERNAL_ERROR');
  assert.equal(unknown.exitCode, 5);
  assert.doesNotMatch(JSON.stringify(unknown), /do-not-print/);
});

test('Failure composition keeps the incoming error causes and previous failure', () => {
  const cause = new AppError('FILE_IO_ERROR', 'fileIO', { operation: 'cleanup' }).public('en');
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
  assert.match(channels.out, /^>.*\bPARTIAL_FAILURE\b/m);
  assert.match(channels.out, /\bsample\b.*\bTIMEOUT\b.*Upstream timeout/);
  assert.ok(channels.out.endsWith(body));
  const plain = capture();
  await display(success(body), options, plain);
  assert.equal(plain.out, body);
  assert.equal(plain.err, '');
});

test('Plain text routes errors to stderr and retains completed results for partial failure and cancellation', async () => {
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
    assert.ok(channels.err.trim());
  }
  const channels = capture();
  await display(
    failure<string>(new AppError('TIMEOUT', 'requestTimeout'), 'en'),
    { ...options, language: 'en' },
    channels,
  );
  assert.equal(channels.out, '');
  assert.ok(channels.err.trim());
});

test('Verbose views use one details object without changing normal data', async () => {
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
  assert.match(markdown.err, /elapsed_ms: 12/);
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

test('Saving success, partial, and error-with-data suppresses stdout and preserves exit status', async (t) => {
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

test(
  'Output uses default permissions for new files and preserves existing POSIX permissions',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const root = temporary(t);
    const reference = join(root, 'default');
    await fs.writeFile(reference, '');
    const path = join(root, 'result.md');
    const save = (mode?: number) =>
      execute(
        async () => {
          if (mode !== undefined) await fs.chmod(path, mode);
          return success(body);
        },
        { ...options, output: path },
        capture(),
      );
    assert.equal(await save(), 0);
    assert.equal((await fs.stat(path)).mode & 0o777, (await fs.stat(reference)).mode & 0o777);
    for (const mode of [0o600, 0o660]) {
      assert.equal(await save(mode), 0);
      assert.equal((await fs.stat(path)).mode & 0o777, mode);
    }
  },
);

test('No-data failure and cancellation keep the existing file', async (t) => {
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

test('Cancellation around output preparation, writing and rename preserves the exact commit boundary', async (t) => {
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

test('Bad output directories stop the operation before it starts', async (t) => {
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

test('Valid long output filenames do not exceed the temporary filename limit', async (t) => {
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

test('Temporary-file creation errors stop the operation', async (t) => {
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

test('Write failure preserves old content and acquired data', async (t) => {
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

test('Replacement failure retains previous failure reasons and removes the temporary file', async (t) => {
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

test('Cleanup failure reports the temporary path and preserves a prior failure or cancellation', async (t) => {
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
  assert.equal(error.details.causes[0].code, 'INVALID_CONFIG');
  const files = await fs.readdir(root);
  assert.equal(files.length, 1);
  assert.equal(error.details.path, join(root, files[0]));

  const path = join(root, 'existing');
  await fs.writeFile(path, 'old');
  const cancelled = failure(new AppError('CANCELLED', 'cancelled'), 'en', success(body));
  const report = capture();
  assert.equal(
    await execute(async () => cancelled, { ...options, format: 'json', output: path }, report),
    130,
  );
  const result = JSON.parse(report.out);
  assert.equal(result.data, body);
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(result.error.details.causes[0].code, 'FILE_IO_ERROR');
  assert.equal(result.error.details.causes[0].details.operation, 'cleanup');
  assert.equal(await fs.readFile(path, 'utf8'), 'old');
});

test('Render failures report an error, retain serializable data, and do not replace a target', async (t) => {
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
  const retained = channels.out.match(/```json\n([^\n]+)\n```/);
  assert.ok(retained);
  assert.equal(JSON.parse(retained[1]), body);
  assert.doesNotMatch(channels.out, /fake-secret/);
  assert.equal(await fs.readFile(path, 'utf8'), 'old');
  const invalid = capture();
  assert.equal(await display(success(Number.NaN), { language: 'en', format: 'json' }, invalid), 5);
  const result = JSON.parse(invalid.out);
  assert.equal(result.error.code, 'RENDER_ERROR');
  assert.equal('data' in result, false);
});

test('Plain-text renderer failure reports the error with retained data', async () => {
  const channels = capture();
  const exit = await execute(
    async () => success(body),
    {
      ...options,
      format: 'text',
      renderText: () => {
        throw new Error('private render failure');
      },
    },
    channels,
  );
  assert.equal(exit, 5);
  assert.ok(channels.err.trim());
  assert.ok(channels.out.includes(JSON.stringify(body)));
  assert.doesNotMatch(channels.out + channels.err, /private render failure/);
});

test('Stream errors are handled and result in a nonzero exit', async () => {
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
