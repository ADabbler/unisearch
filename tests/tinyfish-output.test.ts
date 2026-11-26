import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownNodes } from './helpers.js';
import { fixture, hit, page, search, url } from './tinyfish-fixture.js';

test('TinyFish Markdown preserves page content, links, metadata and selector diagnostics', async (t) => {
  const f = await fixture(t);
  f.reply({
    results: [
      {
        ...page(),
        links: [],
        image_links: ['mailto:media@example.org'],
        page_metadata: { flag: false, count: 0 },
      },
    ],
    errors: [],
  });
  const args = [
    'tinyfish',
    'fetch',
    url,
    '--include-links',
    '--include-image-links',
    '--include-metadata',
  ];
  const markdown = await f.run(args);
  assert.equal(markdown.exit, 0);
  assert.ok(markdown.channels.out.includes(page().text));
  assert.deepEqual(markdownNodes(markdown.channels.out, 'ATXHeading1'), ['# Guide']);
  assert.ok(markdown.channels.out.includes('`mailto:media@example.org`'));
  assert.match(markdown.channels.out, /"flag": false/);
  assert.match(markdown.channels.out, /"count": 0/);
  assert.equal(markdown.channels.err, '');
  const json = await f.run([...args, '--format=json']);
  assert.equal(json.exit, 0);
  assert.deepEqual(json.json().data.results[0].links, []);

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
  const failed = await f.run(['tinyfish', 'fetch', url, '--target-selector', 'article']);
  assert.equal(failed.exit, 4);
  assert.equal(failed.channels.out, '');
  assert.ok(failed.channels.err.includes('article'));
  assert.ok(failed.channels.err.includes('#main'));
});

test('Batch fetch fences each original page beneath its own numbered heading', async (t) => {
  const f = await fixture(t);
  const other = 'https://example.org/other';
  const pages = [page(), { ...page(other), text: '## Upgrade' }];
  f.reply({ results: pages, errors: [] });
  const result = await f.run(['tinyfish', 'fetch', url, other]);
  assert.equal(result.exit, 0, result.channels.err);
  assert.equal(result.channels.err, '');
  assert.deepEqual(
    markdownNodes(result.channels.out, 'ATXHeading2', 'CodeText'),
    pages.flatMap((p, i) => [`## ${i + 1}. [${p.title}](${p.url})`, p.text]),
  );
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
  const r = await f.run(['search', 'q', '--sources', 'model,tinyfish', '--format=json']);
  assert.equal(r.exit, 6);
  const data = r.json();
  const source = data.data.sources.find(
    (source: { provider: string }) => source.provider !== 'model',
  );
  assert.equal(source.provider, 'tinyfish');
  assert.equal(source.data.results.length, 2);
  assert.equal(source.data.provider, undefined);
  assert.equal(data.error.details.failures[0].provider, 'tinyfish');
  assert.equal(data.error.details.failures[0].details.provider, undefined);
  assert.equal(data.error.details.failures[0].details.http_status, undefined);
});
