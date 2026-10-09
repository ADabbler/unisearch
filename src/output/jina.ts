import { text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { Data, Page } from '../providers/jina-response.js';
import type { JsonValue } from '../result.js';
import { inline } from './exa.js';
import { link, warnings } from './firecrawl.js';

function cell(value: JsonValue): string {
  return inline(typeof value === 'string' ? value : JSON.stringify(value)).replace(/\|/g, '\\|');
}
function table(headers: string[], rows: string[][]): string {
  return [headers, headers.map(() => '---'), ...rows]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
}
export function pageContent(page: Page, language: Language): string[] {
  const sep = language === 'zh' ? '：' : ': ';
  const sections: string[] = [];
  const metadata = [
    [page.published_date, 'publishedLabel'],
    [page.date, 'searchDateLabel'],
    [page.source, 'mediaSourceLabel'],
  ] as const;
  const labels = metadata.flatMap(([value, key]) =>
    value === undefined ? [] : [`${text(language, key)}${sep}${inline(value)}`],
  );
  if (labels.length) sections.push(labels.join(' · '));
  if (page.num_pages !== undefined)
    sections.push(`${text(language, 'documentPagesLabel')}${sep}${page.num_pages}`);
  sections.push(...warnings(page.warnings, language));
  if (page.description) sections.push(page.description);
  if (page.image_url) {
    const name = new URL(page.image_url).pathname.split('/').at(-1) || page.image_url;
    let dimensions = '';
    if (page.image_width !== undefined && page.image_height !== undefined)
      dimensions = ` · ${page.image_width} × ${page.image_height}`;
    else if (page.image_width !== undefined)
      dimensions = ` · ${text(language, 'imageWidthLabel')}${sep}${page.image_width}`;
    else if (page.image_height !== undefined)
      dimensions = ` · ${text(language, 'imageHeightLabel')}${sep}${page.image_height}`;
    sections.push(
      `${text(language, 'imageLabel')}${sep}${link(page.image_url, name)}${dimensions}`,
    );
  } else {
    for (const [value, label] of [
      [page.image_width, 'imageWidthLabel'],
      [page.image_height, 'imageHeightLabel'],
    ] as const)
      if (value !== undefined) sections.push(`${text(language, label)}${sep}${value}`);
  }
  if (page.text) sections.push(page.text);
  if (page.site_links)
    sections.push(
      `${text(language, 'siteLinksLabel')}${sep}\n\n${page.site_links.map((item) => `- ${link(item.url, item.title)}`).join('\n')}`,
    );
  if (page.metadata)
    sections.push(
      `${text(language, 'pageMetadataLabel')}${sep}\n\n${table(
        [text(language, 'metadataFieldLabel'), text(language, 'metadataValueLabel')],
        Object.entries(page.metadata).map(([key, value]) => [cell(key), cell(value)]),
      )}`,
    );
  if (page.external) {
    const rows = Object.entries(page.external).flatMap(([rel, addresses]) => {
      if (!Object.keys(addresses).length) return [[cell(rel), '', '{}']];
      return Object.entries(addresses).map(([url, attrs]) => [cell(rel), cell(url), cell(attrs)]);
    });
    sections.push(
      `${text(language, 'externalRelationsLabel')}${sep}\n\n${table([text(language, 'relationLabel'), text(language, 'linkLabel'), text(language, 'attributesLabel')], rows)}`,
    );
  }
  return sections;
}
export function renderJina(data: Data, language: Language, level = 2, showProvider = true): string {
  const searching = 'search_type' in data;
  const source = text(language, 'jinaSource');
  const sections: string[] = [];
  if (searching) {
    const labels = { web: 'jinaWeb', news: 'jinaNews', images: 'jinaImages' } as const;
    const type = text(language, labels[data.search_type]);
    sections.push(showProvider ? `${source} · ${type}` : type);
  } else if (showProvider) {
    const page = data.results[0];
    sections.push(data.results.length === 1 ? `${source} · ${link(page.url, page.title)}` : source);
  }
  const entries = data.results.map((page, index) =>
    [
      ...(searching || data.results.length !== 1
        ? [`${'#'.repeat(level)} ${index + 1}. ${link(page.url, page.title)}`]
        : []),
      ...pageContent(page, language),
    ].join('\n\n'),
  );
  sections.push(entries.length ? entries.join('\n\n---\n\n') : text(language, 'noResults'));
  return sections.join('\n\n');
}
