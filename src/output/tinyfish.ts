import { colon, text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { FetchData, SearchData } from '../providers/tinyfish-response.js';
import { inline, resultTitle } from './exa.js';
import { inlineCode } from './context7.js';
import { contentInfo, link } from './firecrawl.js';

export function renderSearch(
  data: SearchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const sep = colon(language);
  const parts = showProvider ? [text(language, 'tinyfishSource')] : [];
  if (data.page !== undefined) {
    const page = `${text(language, 'tinyfishPageLabel')}${sep}${data.page}`;
    if (showProvider) parts[0] += ` · ${page}`;
    else parts.push(page);
  }
  if (!data.results.length) parts.push(text(language, 'noResults'));
  for (const [index, item] of data.results.entries()) {
    if (index) parts.push('---');
    parts.push(resultTitle(index, item.url, item.title, level, !!item.snippet?.trim()));
    const site = [
      item.site_name ? `${text(language, 'tinyfishSiteLabel')}${sep}${inline(item.site_name)}` : '',
      item.position !== undefined && item.position !== index + 1
        ? `${text(language, 'tinyfishRankLabel')}${sep}${item.position}`
        : '',
    ].filter(Boolean);
    if (site.length) parts.push(site.join(' · '));
    const metadata: string[] = [];
    for (const [value, label] of [
      [item.date, 'publishedLabel'],
      [item.publisher, 'tinyfishPublisherLabel'],
      [item.authors?.join(language === 'zh' ? '、' : ', '), 'authorLabel'],
      [item.venue, 'tinyfishVenueLabel'],
      [item.year, 'tinyfishYearLabel'],
      [item.cited_by_count, 'tinyfishCitationsLabel'],
    ] as const)
      if (value !== undefined)
        metadata.push(`${text(language, label)}${sep}${inline(String(value))}`);
    if (metadata.length) parts.push(metadata.join(' · '));
    if (item.snippet) parts.push(item.snippet);
    if (item.pdf_url) parts.push(link(item.pdf_url, 'PDF'));
    if (item.thumbnail_url)
      parts.push(link(item.thumbnail_url, text(language, 'tinyfishThumbnailLabel')));
  }
  return parts.join('\n\n');
}

export function renderFetch(data: FetchData, language: Language): string {
  const sep = colon(language);
  const parts = [text(language, 'tinyfishSource')];
  for (const page of data.results) {
    if (data.results.length === 1) parts[0] += ` · ${link(page.url, page.title)}`;
    else parts.push(`## ${link(page.url, page.title)}`);
    parts.push(...contentInfo(page, language));
    const metadata: string[] = [];
    for (const [value, label] of [
      [page.published_date, 'publishedLabel'],
      [page.author, 'authorLabel'],
      [page.language, 'tinyfishLanguageLabel'],
    ] as const)
      if (value !== undefined) metadata.push(`${text(language, label)}${sep}${inline(value)}`);
    if (metadata.length) parts.push(metadata.join(' · '));
    if (page.description) parts.push(page.description);
    if (page.unmatched_selectors)
      parts.push(
        `${text(language, 'unmatchedSelectorsLabel')}${sep}${page.unmatched_selectors.map(inlineCode).join(language === 'zh' ? '、' : ', ')}`,
      );
    if (page.missing_content)
      parts.push(
        `${text(language, 'tinyfishMissingLabel')}${sep}${page.missing_content.map((key) => text(language, key === 'links' ? 'tinyfishLinksLabel' : 'tinyfishImagesLabel')).join(language === 'zh' ? '、' : ', ')}`,
      );
    if (page.not_modified) parts.push(text(language, 'tinyfishUnchangedLabel'));
    if (page.etag) parts.push(`ETag${sep}${inlineCode(page.etag)}`);
    if (page.last_modified)
      parts.push(`${text(language, 'tinyfishModifiedLabel')}${sep}${inline(page.last_modified)}`);
    if (page.text) parts.push(page.text);
    for (const [key, heading, empty] of [
      ['links', 'tinyfishLinksLabel', 'tinyfishNoLinks'],
      ['image_links', 'tinyfishImagesLabel', 'tinyfishNoImages'],
    ] as const) {
      const urls = page[key];
      if (urls === undefined) continue;
      if (!urls.length) parts.push(text(language, empty));
      else
        parts.push(
          `### ${text(language, heading)}`,
          urls
            .map((url) => `- ${/^https?:\/\//.test(url) ? link(url) : inlineCode(url)}`)
            .join('\n'),
        );
    }
    if (page.page_metadata)
      parts.push(
        `### ${text(language, 'pageMetadataLabel')}`,
        `\`\`\`json\n${JSON.stringify(page.page_metadata, null, 2)}\n\`\`\``,
      );
  }
  return parts.join('\n\n');
}
