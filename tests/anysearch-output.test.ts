import assert from 'node:assert/strict';
import { test } from 'node:test';
import { text } from '../src/i18n/messages.js';
import * as output from '../src/output/anysearch.js';
import * as anysearch from '../src/providers/anysearch.js';
import { hit, pageUrl } from './anysearch-fixture.js';
import { markdownNodes } from './helpers.js';

test('AnySearch Markdown preserves distinct summaries, raw content, identifiers and parameter semantics', () => {
  const language = 'zh';
  const raw = '# Heading\n\n```md\n**original**\n```\n';
  const data = anysearch.searchData(
    {
      results: [
        { ...hit, title: 'A [link] `code`', snippet: raw, content: raw },
        { ...hit, title: null, snippet: 'Use <Widget> &copy;.', content: raw },
        { url: pageUrl },
      ],
    },
    5,
  );
  const md = output.renderSearch(data, language);
  assert.deepEqual(markdownNodes(md, 'CodeText', 'StrongEmphasis'), [
    raw.trimEnd(),
    `**${text(language, 'summaryLabel')}**`,
    `**${text(language, 'textLabel')}**`,
    raw.trimEnd(),
  ]);
  assert.ok(md.includes('**：Use \\<Widget\\> \\&copy;.'));
  assert.ok(md.includes(`## 3. <${pageUrl}>`));
  const links = { ...data, results: [{ url: pageUrl }, { url: 'https://example.org/other' }] };
  assert.match(output.renderSearch(links, language), /^1\. <.+>\n2\. <.+>$/m);
  assert.ok(md.includes('A \\[link\\] \\`code\\`'));
  const description = 'Values: "", 0, false. Unit: ms.\r# Examples\n100.';
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
              ' name ': { required: true, description: '<identifier>\r\n' },
            },
          },
        ],
      },
    ],
  });
  const definitions = output.renderDomains(domains, language);
  const [optional, required] = markdownNodes(definitions, 'ListItem');
  assert.ok(optional.includes(text(language, 'anysearchOptional')));
  assert.equal(markdownNodes(optional, 'CodeText').join(''), description.replace('\r', '\n'));
  assert.ok(required.includes(text(language, 'anysearchRequired')));
  assert.ok(required.includes('：\\<identifier\\>'));
  assert.deepEqual(markdownNodes(definitions, 'InlineCode'), ['`` odd`name ``', '`  name  `']);
});
