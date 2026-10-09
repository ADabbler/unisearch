import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import * as output from '../src/output/anysearch.js';
import * as anysearch from '../src/providers/anysearch.js';
import { fixture, envelope, hit, page, pageUrl, payloads } from './anysearch-fixture.js';

test('AnySearch Markdown preserves distinct summaries, raw content, identifiers and parameter semantics', () => {
  const raw = '# Heading\n\n```md\n**original**\n```\n'.repeat(3000);
  const data = anysearch.searchData(
    {
      results: [
        { ...hit, title: 'A [link] `code`', snippet: raw, content: raw },
        { ...hit, title: null, snippet: 'Summary.', content: raw },
        { url: pageUrl },
      ],
    },
    5,
  );
  const md = output.renderSearch(data, 'zh');
  assert.equal(md.split(raw).length, 3);
  assert.equal(md.match(/\*\*摘要\*\*/g)?.length, 1);
  assert.equal(md.match(/\*\*内容\*\*/g)?.length, 1);
  assert.ok(md.includes('A \\[link\\] \\`code\\`'));
  const domains = anysearch.domainsData({
    domains: [
      {
        domain: 'code',
        sub_domains: [
          {
            sub_domain: 'code.doc',
            params: {
              'odd`name': {
                required: false,
                description: 'Values: "", 0, false. Unit: ms.\nExample: 100.',
              },
              name: { required: true },
            },
          },
        ],
      },
    ],
  });
  const definitions = output.renderDomains(domains, 'zh');
  assert.ok(
    definitions.includes(
      '- `` odd`name ``（可选）：Values: "", 0, false. Unit: ms.\n  Example: 100.',
    ),
  );
  assert.ok(definitions.includes('- `name`（必需）'));
  assert.doesNotMatch(definitions, /参数|sort_order/);
});

test('AnySearch file output saves empty and full results, preserves failed targets and prepares before HTTP', async (t) => {
  const f = await fixture(t);
  const outputPath = join(f.root, 'result.md');
  for (const args of [
    ['anysearch', 'search', 'q'],
    ['anysearch', 'domains'],
    ['anysearch', 'domains', 'code'],
    ['anysearch', 'extract', pageUrl],
    ['fetch', pageUrl],
  ]) {
    const failed = await f.run([...args, '--output', join(f.root, 'absent', 'out')]);
    assert.equal(failed.exit, 5);
  }
  assert.equal(f.calls.length, 0);
  for (const [args, response] of [
    [['anysearch', 'domains'], undefined],
    [['anysearch', 'domains', 'new'], envelope({ domains: [] })],
    [['anysearch', 'search', 'q'], envelope({ results: [] })],
    [['anysearch', 'extract', pageUrl], envelope({ ...page, content: page.content.repeat(5000) })],
  ] as const) {
    if (response) f.reply(response);
    const result = await f.run([...args, '--verbose', '--output', outputPath]);
    assert.equal(result.exit, 0, result.channels.out);
    assert.equal(result.channels.out, '');
    assert.ok(readFileSync(outputPath, 'utf8').startsWith('Source: AnySearch'));
    assert.doesNotMatch(readFileSync(outputPath, 'utf8'), /Execution time:/);
    if (args.length > 2) assert.match(result.channels.err, /Execution time:/);
    else assert.equal(result.channels.err, '');
  }
  const original = readFileSync(outputPath, 'utf8');
  f.reply({ code: -1, message: 'bad key' }, 401);
  assert.equal((await f.run(['anysearch', 'extract', pageUrl, '--output', outputPath])).exit, 3);
  assert.equal(readFileSync(outputPath, 'utf8'), original);
  assert.deepEqual(readdirSync(f.root).sort(), ['config.json', 'result.md']);
});

test('AnySearch combined partial and model-error output retains successful evidence and sanitizes diagnostics in files', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_MODEL_API_KEY = 'fixture-model-key';
  f.env.UNISEARCH_EXA_API_KEY = 'fixture-exa-key';
  f.env.UNISEARCH_ANYSEARCH_API_KEY = 'fixture-any-key';
  const path = join(f.root, 'result');
  for (const mode of ['model-failure', 'any-failure']) {
    f.handle((call, res) => {
      if (call.path === (mode === 'model-failure' ? '/model/responses' : '/gateway/v1/search')) {
        res.writeHead(401);
        res.end(
          JSON.stringify({
            code: -1,
            message: 'fixture-model-key fixture-exa-key fixture-any-key',
            error: { message: 'failure' },
          }),
        );
      } else res.end(JSON.stringify(payloads[call.path]));
    });
    for (const format of ['json', 'markdown']) {
      const result = await f.run([
        'search',
        'q',
        '--extra-sources',
        'anysearch,exa',
        '--verbose',
        '--format',
        format,
        '--output',
        path,
      ]);
      assert.equal(result.exit, mode === 'model-failure' ? 3 : 6);
      assert.equal(result.channels.out, '');
      assert.match(result.channels.err, /Result saved to:/);
      const saved = readFileSync(path, 'utf8');
      assert.doesNotMatch(
        saved + result.channels.err,
        /fixture-model-key|fixture-exa-key|fixture-any-key/,
      );
      if (format === 'json')
        assert.equal(
          JSON.parse(saved).data.extra_sources[0].provider,
          mode === 'model-failure' ? 'anysearch' : 'exa',
        );
      else assert.match(saved, /Supplemental|Additional|Exa|AnySearch/);
    }
  }
});

test('AnySearch online and offline output honor rename cancellation and IO failure boundaries', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'result.json');
  const rename = fs.rename;
  for (const args of [
    ['anysearch', 'domains'],
    ['anysearch', 'extract', pageUrl],
  ])
    for (const phase of ['before', 'submitted', 'io']) {
      writeFileSync(path, 'original');
      const open = fs.open;
      const openMock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          if (phase === 'before') process.emit('SIGINT');
        };
        return handle;
      });
      const renameMock = t.mock.method(
        fs,
        'rename',
        async (...args: Parameters<typeof fs.rename>) => {
          if (phase === 'io') throw Object.assign(new Error('fixture IO'), { code: 'EACCES' });
          if (phase === 'submitted') process.emit('SIGINT');
          return rename(...args);
        },
      );
      try {
        const result = await f.run([...args, '--format=json', '--output', path]);
        assert.equal(result.exit, phase === 'io' ? 5 : 130);
        assert.ok(result.json().data);
        if (phase === 'submitted') {
          assert.equal(result.json().error.details.output_saved, true);
          assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, 'success');
        } else assert.equal(readFileSync(path, 'utf8'), 'original');
        assert.deepEqual(readdirSync(f.root).sort(), ['config.json', 'result.json']);
      } finally {
        openMock.mock.restore();
        renameMock.mock.restore();
      }
    }
});
