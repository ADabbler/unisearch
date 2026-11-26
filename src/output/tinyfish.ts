import { colon, text } from '../i18n/messages.js';
import { sourceLabel } from '../i18n/providers.js';
import type { Language } from '../i18n/messages.js';
import type { FetchData, SearchData } from '../providers/tinyfish-response.js';
import {
  blockField,
  inline,
  inlineCode,
  jsonBlock,
  link,
  pageBody,
  proseField,
  rankedResults,
  renderPages,
} from './markdown.js';
import { contentInfo } from './firecrawl.js';

export function renderSearch(
  data: SearchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const sep = colon(language);
  const sections = showProvider ? [sourceLabel('tinyfish', language)] : [];
  if (data.page !== undefined) {
    const page = `${text(language, 'tinyfishPageLabel')}${sep}${data.page}`;
    if (showProvider) sections[0] += ` · ${page}`;
    else sections.push(page);
  }
  sections.push(
    rankedResults(data.results, language, level, (item, index) => {
      const parts: string[] = [];
      const site = [
        item.site_name ? `${text(language, 'siteLabel')}${sep}${inline(item.site_name)}` : '',
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
      if (item.summary) parts.push(proseField(language, 'summaryLabel', item.summary));
      if (item.pdf_url) parts.push(link(item.pdf_url, 'PDF'));
      if (item.thumbnail_url)
        parts.push(link(item.thumbnail_url, text(language, 'tinyfishThumbnailLabel')));
      return parts;
    }),
  );
  return sections.join('\n\n');
}

export function renderFetch(data: FetchData, language: Language): string {
  const sep = colon(language);
  return renderPages(data.results, language, sourceLabel('tinyfish', language), (page, single) => {
    const parts = contentInfo(page, language);
    const metadata: string[] = [];
    for (const [value, label] of [
      [page.published_date, 'publishedLabel'],
      [page.author, 'authorLabel'],
      [page.language, 'tinyfishLanguageLabel'],
    ] as const)
      if (value !== undefined) metadata.push(`${text(language, label)}${sep}${inline(value)}`);
    if (metadata.length) parts.push(metadata.join(' · '));
    if (page.description) parts.push(proseField(language, 'summaryLabel', page.description));
    if (page.unmatched_selectors)
      parts.push(
        `${text(language, 'tinyfishUnmatchedSelectorsLabel')}${sep}${page.unmatched_selectors.map(inlineCode).join(language === 'zh' ? '、' : ', ')}`,
      );
    if (page.missing_content) {
      const missing = page.missing_content.map((key) => {
        if (key === 'links') return text(language, 'tinyfishLinksLabel');
        if (key === 'iframe_links') return text(language, 'tinyfishIframesLabel');
        return text(language, 'tinyfishImagesLabel');
      });
      parts.push(
        `${text(language, 'tinyfishMissingLabel')}${sep}${missing.join(language === 'zh' ? '、' : ', ')}`,
      );
    }
    if (page.not_modified) parts.push(text(language, 'tinyfishUnchangedLabel'));
    if (page.etag) parts.push(`ETag${sep}${inlineCode(page.etag)}`);
    if (page.last_modified)
      parts.push(`${text(language, 'tinyfishModifiedLabel')}${sep}${inline(page.last_modified)}`);
    if (page.text) parts.push(pageBody(language, page.text, page.description, single));
    for (const [key, heading] of [
      ['links', 'tinyfishLinksLabel'],
      ['image_links', 'tinyfishImagesLabel'],
      ['iframe_links', 'tinyfishIframesLabel'],
    ] as const) {
      const urls = page[key];
      if (!urls?.length) continue;
      parts.push(
        blockField(
          language,
          heading,
          urls
            .map((url) => `- ${/^https?:\/\//i.test(url) ? link(url) : inlineCode(url)}`)
            .join('\n'),
        ),
      );
    }
    if (page.page_metadata)
      parts.push(blockField(language, 'pageMetadataLabel', jsonBlock(page.page_metadata)));
    return parts;
  });
}
