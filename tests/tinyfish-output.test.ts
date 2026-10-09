import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, hit, page, search, url } from './tinyfish-fixture.js';

test('TinyFish Markdown keeps metadata, alternate ranks, explicit empty links and diagnostic arrays', async (t) => {
  const f = await fixture(t);
  f.reply({ ...search, results: [{ ...hit, position: 7, cited_by_count: 0 }] });
  const searched = await f.run(['tinyfish', 'search', 'q'], { UNISEARCH_LANG: 'zh' });
  assert.match(searched.channels.out, /排名：7/);
  assert.match(searched.channels.out, /被引次数：0/);
  f.reply({
    results: [
      {
        ...page(),
        links: [],
        image_links: ['mailto:media@example.org'],
        page_metadata: { canonical: url, flag: false, count: 0 },
      },
    ],
    errors: [],
  });
  const extracted = await f.run(
    ['tinyfish', 'fetch', url, '--include-links', '--include-image-links', '--include-metadata'],
    { UNISEARCH_LANG: 'zh' },
  );
  assert.match(extracted.channels.out, /无页面链接/);
  assert.match(extracted.channels.out, /`mailto:media@example.org`/);
  assert.match(extracted.channels.out, /"flag": false/);
  assert.match(extracted.channels.out, /"count": 0/);
  assert.ok(extracted.channels.out.includes(page().text));
  assert.equal(extracted.channels.err, '');
  f.reply({
    results: [],
    errors: [
      {
        url,
        error: 'selector_not_matched',
        unmatched_selectors: ['article'],
        candidate_selectors: ['#main'],
      },
    ],
  });
  const failed = await f.run(['tinyfish', 'fetch', url, '--target-selector', 'article'], {
    UNISEARCH_LANG: 'en',
  });
  assert.equal(failed.exit, 4);
  assert.equal(failed.channels.out, '');
  assert.match(failed.channels.err, /Unmatched selectors: article/);
  assert.match(failed.channels.err, /Candidate selectors: #main/);
});

test('TinyFish useful failed search data survives root combination without duplicated identity', async (t) => {
  const f = await fixture(t);
  f.env.UNISEARCH_MODEL_API_KEY = 'model-fixture-key';
  f.handle((call, res) =>
    res.end(
      JSON.stringify(
        call.path === '/tf-search/'
          ? { ...search, results: [{ ...hit, title: false }, hit] }
          : {
              model: 'fixture-model',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Answer' }],
                },
              ],
            },
      ),
    ),
  );
  const r = await f.run(['search', 'q', '--extra-sources', 'tinyfish', '--format=json']);
  assert.equal(r.exit, 6);
  const data = r.json();
  assert.equal(data.data.extra_sources[0].provider, 'tinyfish');
  assert.equal(data.data.extra_sources[0].data.results.length, 2);
  assert.equal(data.data.extra_sources[0].data.provider, undefined);
  assert.equal(data.error.details.failures[0].provider, 'tinyfish');
  assert.equal(data.error.details.failures[0].details.provider, undefined);
  assert.equal(data.error.details.failures[0].details.http_status, undefined);
});
