import { colon, text } from '../i18n/messages.js';
import { sourceLabel } from '../i18n/providers.js';
import type { Language } from '../i18n/messages.js';
import type { Data, Page } from '../providers/jina-response.js';
import {
  blockField,
  inline,
  jsonBlock,
  link,
  pageBody,
  proseField,
  rankedResults,
  renderPages,
} from './markdown.js';
import { warnings } from './firecrawl.js';

export function pageContent(page: Page, language: Language, single: boolean): string[] {
  const sep = colon(language);
  const sections: string[] = [];
  const metadata = [
    [page.published_date, 'publishedLabel'],
    [page.date, 'jinaSearchDateLabel'],
    [page.source, 'jinaMediaSourceLabel'],
  ] as const;
  const labels = metadata.flatMap(([value, key]) =>
    value === undefined ? [] : [`${text(language, key)}${sep}${inline(value)}`],
  );
  if (labels.length) sections.push(labels.join(' · '));
  if (page.num_pages !== undefined)
    sections.push(`${text(language, 'jinaDocumentPagesLabel')}${sep}${page.num_pages}`);
  sections.push(...warnings(page.warnings, language));
  if (page.description) sections.push(proseField(language, 'summaryLabel', page.description));
  if (page.image_url) {
    const name = new URL(page.image_url).pathname.split('/').at(-1) || page.image_url;
    let dimensions = '';
    if (page.image_width !== undefined && page.image_height !== undefined)
      dimensions = ` · ${page.image_width} × ${page.image_height}`;
    else if (page.image_width !== undefined)
      dimensions = ` · ${text(language, 'jinaImageWidthLabel')}${sep}${page.image_width}`;
    else if (page.image_height !== undefined)
      dimensions = ` · ${text(language, 'jinaImageHeightLabel')}${sep}${page.image_height}`;
    sections.push(
      `${text(language, 'jinaImageLabel')}${sep}${link(page.image_url, name)}${dimensions}`,
    );
  } else {
    for (const [value, label] of [
      [page.image_width, 'jinaImageWidthLabel'],
      [page.image_height, 'jinaImageHeightLabel'],
    ] as const)
      if (value !== undefined) sections.push(`${text(language, label)}${sep}${value}`);
  }
  if (page.text) sections.push(pageBody(language, page.text, page.description, single));
  if (page.site_links?.length)
    sections.push(
      blockField(
        language,
        'jinaSiteLinksLabel',
        page.site_links.map((item) => `- ${link(item.url, item.title)}`).join('\n'),
      ),
    );
  if (page.metadata)
    sections.push(blockField(language, 'pageMetadataLabel', jsonBlock(page.metadata)));
  if (page.external)
    sections.push(blockField(language, 'jinaExternalRelationsLabel', jsonBlock(page.external)));
  return sections;
}
export function renderJina(data: Data, language: Language, level = 2, showProvider = true): string {
  const source = sourceLabel('jina', language);
  if (!('search_type' in data))
    return renderPages(data.results, language, source, (page, single) =>
      pageContent(page, language, single),
    );
  const labels = { web: 'jinaWeb', news: 'jinaNews', images: 'jinaImages' } as const;
  const type = text(language, labels[data.search_type]);
  return [
    showProvider ? `${source} · ${type}` : type,
    rankedResults(data.results, language, level, (page) => pageContent(page, language, false)),
  ].join('\n\n');
}
