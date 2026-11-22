import assert from 'node:assert/strict';
import { test } from 'node:test';
import { text } from '../src/i18n/messages.js';
import * as output from '../src/output/anysearch.js';
import * as anysearch from '../src/providers/anysearch.js';
import { hit, pageUrl } from './anysearch-fixture.js';

test('AnySearch Markdown preserves distinct summaries, raw content, identifiers and parameter semantics', () => {
  const language = 'zh';
  const raw = '# Heading\n\n```md\n**original**\n```\n';
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
  const md = output.renderSearch(data, language);
  assert.equal(md.split(raw).length, 3);
  assert.ok(md.includes('Summary.'));
  assert.ok(md.includes('A \\[link\\] \\`code\\`'));
  const description = 'Values: "", 0, false. Unit: ms.\nExample: 100.';
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
                description,
              },
              name: { required: true },
            },
          },
        ],
      },
    ],
  });
  const definitions = output.renderDomains(domains, language);
  const lines = definitions.split('\n');
  const optional = lines.find((line) => line.startsWith('- `` odd`name ``'));
  const required = lines.find((line) => line.startsWith('- `name`'));
  assert.ok(optional?.includes(text(language, 'anysearchOptional')), definitions);
  assert.ok(required?.includes(text(language, 'anysearchRequired')), definitions);
  assert.ok(definitions.includes(description.replace('\n', '\n  ')));
});
