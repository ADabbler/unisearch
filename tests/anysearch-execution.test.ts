import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as anysearch from '../src/providers/anysearch.js';
import { executeRequest } from '../src/execution.js';
import type { ExecutionClock } from '../src/execution.js';
import type { JsonObject } from '../src/result.js';
import { fixture, envelope, page, pageUrl, payloads } from './anysearch-fixture.js';

test('AnySearch HTTP status, business codes, invalid error bodies and redirects have explicit policies', async (t) => {
  const f = await fixture(t);
  for (const operation of ['search', 'domains', 'extract'] as const) {
    const request = anysearch.prepare(
      operation,
      operation === 'extract' ? pageUrl : 'q',
      {},
      {},
      f.env,
      'en',
    );
    for (const [status, code, retry, exit] of [
      [400, 'INVALID_ARGUMENT', false, 2],
      [401, 'AUTHENTICATION_ERROR', false, 3],
      [403, 'ACCESS_DENIED', false, 3],
      [402, 'QUOTA_EXCEEDED', false, 4],
      [408, 'TIMEOUT', true, 4],
      [429, 'RATE_LIMITED', true, 4],
      [500, 'UPSTREAM_ERROR', true, 4],
      [502, 'UPSTREAM_ERROR', true, 4],
      [503, 'UPSTREAM_ERROR', true, 4],
      [504, 'TIMEOUT', true, 4],
      [422, operation === 'extract' ? 'CONTENT_UNAVAILABLE' : 'UPSTREAM_ERROR', false, 4],
      ...[301, 302, 404, 415, 501].map((status) => [status, 'UPSTREAM_ERROR', false, 4] as const),
    ] as const) {
      f.reply(
        { code: 0, message: 'quota exhausted or invalid key', error_code: 'fixture_code' },
        status,
        { location: `${f.base}/redirect`, 'retry-after': '1' },
      );
      const result = await anysearch.request(
        request,
        { signal: new AbortController().signal },
        'en',
      );
      assert.equal(result.outcome.result.error?.code, code, `${operation} ${status}`);
      assert.equal(result.retry, retry);
      assert.equal(result.outcome.exitCode, exit);
      if (status !== 402)
        assert.equal(result.outcome.result.error?.details?.upstream_code, 'fixture_code');
      if (code === 'TIMEOUT')
        assert.equal(result.outcome.result.error?.details?.timeout_scope, 'request');
    }
  }
  assert.ok(f.calls.every((call) => !call.path.includes('redirect')));
  for (const body of [{}, { code: '0' }, { code: null }, { code: 0 }, '{']) {
    f.reply(body);
    assert.equal(
      (await f.run(['anysearch', 'search', 'q', '--format=json'])).json().error.code,
      'INVALID_RESPONSE',
    );
  }
  for (const status of [200, 401, 503]) {
    f.handle((_call, res) => {
      res.writeHead(status);
      res.end(Buffer.from([0xff]));
    });
    const result = (await f.run(['anysearch', 'search', 'q', '--format=json'])).json();
    assert.equal(
      result.error.code,
      { 200: 'INVALID_RESPONSE', 401: 'AUTHENTICATION_ERROR', 503: 'UPSTREAM_ERROR' }[status],
    );
    if (status !== 200) assert.equal(result.error.details.reason, 'error_body_invalid');
  }
  f.reply({ code: -123, message: 'quota exhausted', error_code: 'undocumented' });
  const failed = await f.run(['anysearch', 'search', 'q', '--format=json'], {
    UNISEARCH_RETRIES: '2',
  });
  assert.equal(failed.json().error.code, 'UPSTREAM_ERROR');
  assert.equal(failed.json().error.details.upstream_code, 'undocumented');
});

test('AnySearch authentication never retries anonymously and diagnostics redact all configured credentials', async (t) => {
  const f = await fixture(t);
  f.save({
    providers: { anysearch: { api_key: 'fixture-old-key' }, exa: { api_key: 'fixture-exa-key' } },
  });
  const secrets = 'fixture-old-key fixture-new-key fixture-exa-key';
  for (const status of [401, 403]) {
    f.reply(
      {
        code: -1,
        message: `${secrets}\nAuthorization: Bearer unknown\nhttps://u:p@example.org`,
        request_id: 'body-id',
        error_code: 'fixture-old-key',
      },
      status,
      { 'x-request-id': 'gateway/fixture-new-key' },
    );
    for (const format of ['json', 'markdown']) {
      const before = f.calls.length;
      const result = await f.run(
        ['anysearch', 'extract', pageUrl, '--format', format, '--verbose'],
        { UNISEARCH_ANYSEARCH_API_KEY: 'fixture-new-key', UNISEARCH_RETRIES: '2' },
      );
      assert.equal(result.exit, 3);
      assert.equal(f.calls.length, before + 1);
      assert.equal(f.calls.at(-1)!.headers.authorization, 'Bearer fixture-new-key');
      assert.doesNotMatch(
        result.channels.out + result.channels.err,
        /fixture-old-key|fixture-new-key|fixture-exa-key|unknown|u:p|body-id/,
      );
      assert.match(result.channels.out + result.channels.err, /gateway\/\[REDACTED\]/);
      if (format === 'json') assert.equal(result.json().meta.attempts[0].request_id, undefined);
    }
  }
  const before = f.calls.length;
  assert.equal(
    (await f.run(['anysearch', 'search', 'q'], { UNISEARCH_ANYSEARCH_API_KEY: '' })).exit,
    3,
  );
  assert.equal(f.calls.length, before);
  f.reply(envelope({ ...page, content: secrets }));
  const data = (await f.run(['anysearch', 'extract', pageUrl, '--format=json'])).json().data;
  assert.equal(data.text, secrets);
  for (const message of [
    'AnySearch request failed',
    'AnySearch request failed Extra information.',
  ]) {
    f.reply({ code: -1, message, request_id: 'body-id' }, 404);
    const result = (await f.run(['anysearch', 'search', 'q', '--format=json'])).json();
    assert.equal(
      result.error.details.upstream_message,
      message.endsWith('Extra information.') ? message : undefined,
    );
    assert.equal(result.error.details.request_id, 'body-id');
  }
});

test(
  'AnySearch 402 closes an unfinished sensitive body without decoding, retaining only the header ID',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const original = readFileSync(f.file, 'utf8');
    const output = join(f.root, 'saved.json');
    writeFileSync(output, 'original');
    for (const header of [undefined, 'gateway/non-uuid-id']) {
      f.handle((_call, res) => {
        res.writeHead(402, header ? { 'x-request-id': header } : {});
        res.write(
          JSON.stringify({
            code: -1,
            request_id: 'body-only-id',
            message: 'new-password',
            data: { username: 'new-user', password: 'new-password', api_key: 'new-key' },
          }),
        );
        // Deliberately leave the body open: the operation must cancel rather than consume it.
      });
      for (const format of ['json', 'markdown']) {
        const result = await f.run(
          ['anysearch', 'search', 'q', '--verbose', '--format', format, '--output', output],
          { UNISEARCH_RETRIES: '2' },
        );
        assert.equal(result.exit, 4);
        assert.doesNotMatch(
          result.channels.out + result.channels.err + readFileSync(output, 'utf8'),
          /new-user|new-password|new-key|body-only-id/,
        );
        if (format === 'json') assert.equal(result.json().error.details.request_id, header);
        assert.equal(readFileSync(output, 'utf8'), 'original');
      }
    }
    assert.equal(f.calls.length, 4);
    assert.equal(readFileSync(f.file, 'utf8'), original);
    assert.deepEqual(readdirSync(f.root).sort(), ['config.json', 'saved.json']);
  },
);

test('AnySearch late successful responses remain retryable while malformed responses do not', async (t) => {
  const f = await fixture(t);
  const request = anysearch.prepare('extract', pageUrl, {}, {}, f.env, 'en');
  for (const malformed of [false, true]) {
    let now = 0;
    let calls = 0;
    const waits: number[] = [];
    const time: ExecutionClock = {
      now: () => now,
      wallNow: () => 0,
      schedule: () => () => {},
      async sleep(ms) {
        waits.push(ms);
        now += ms;
      },
    };
    f.handle((call, res) => {
      calls++;
      // A delayed event loop may deliver the complete response before the timer callback.
      if (calls === 1) now += 30001;
      res.end(JSON.stringify(malformed ? {} : payloads[call.path]));
    });

    const record: JsonObject = {};
    const result = await executeRequest((context) => anysearch.request(request, context, 'en'), {
      provider: 'anysearch',
      timeout: 100,
      retries: 1,
      requestLimit: anysearch.requestLimit,
      signal: new AbortController().signal,
      language: 'en',
      clock: time,
      record,
    });
    assert.equal(result.exitCode, malformed ? 4 : 0);
    assert.equal(calls, malformed ? 1 : 2);
    assert.deepEqual(waits, malformed ? [] : [1000]);
    assert.equal((record.attempts as JsonObject[])[0].code, 'TIMEOUT');
  }
});
