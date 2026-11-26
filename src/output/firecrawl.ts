import { colon, text } from '../i18n/messages.js';
import { sourceLabel } from '../i18n/providers.js';
import type { Language } from '../i18n/messages.js';
import type {
  ContentTruncation,
  MapData,
  ScrapeData,
  SearchData,
} from '../providers/firecrawl-response.js';
import {
  diagnostic,
  distinctSummary,
  indentListBlock,
  inline,
  link,
  pageBody,
  proseField,
  rankedResults,
} from './markdown.js';

export function warnings(values: string[] | undefined, language: Language): string[] {
  return (values ?? []).map((value) =>
    diagnostic(`${text(language, 'upstreamWarningLabel')}${colon(language)}${value}`),
  );
}
export function contentInfo(
  data: { final_url?: string; content_truncation?: ContentTruncation },
  language: Language,
): string[] {
  const sections: string[] = [];
  if (data.final_url)
    sections.push(`${text(language, 'finalUrlLabel')}${colon(language)}${link(data.final_url)}`);
  if (data.content_truncation)
    sections.push(
      text(language, 'truncatedContent')
        .replace('{parsed}', String(data.content_truncation.parsed_pages))
        .replace('{total}', String(data.content_truncation.total_pages)),
    );
  return sections;
}

export function renderSearch(
  data: SearchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const sections = showProvider ? [sourceLabel('firecrawl', language)] : [];
  sections.push(...warnings(data.warnings, language));
  const results = rankedResults(data.results, language, level, (item) => {
    const parts: string[] = [];
    if (item.category?.trim())
      parts.push(
        `${text(language, 'firecrawlCategoryLabel')}${colon(language)}${inline(item.category)}`,
      );
    parts.push(...warnings(item.warnings, language));
    const summary = distinctSummary(item.description, item.text);
    if (summary) parts.push(proseField(language, 'summaryLabel', summary));
    parts.push(...contentInfo(item, language));
    if (item.missing_content)
      parts.push(
        `${text(language, 'missingContentLabel')}${colon(language)}${text(language, 'textLabel')}`,
      );
    if (item.content_error) {
      const details: string[] = [];
      if (item.content_error.page_status !== undefined)
        details.push(
          `${text(language, 'pageStatusLabel')}${colon(language)}${item.content_error.page_status}`,
        );
      if (item.content_error.message)
        details.push(
          `${text(language, 'upstreamMessageLabel')}${colon(language)}${item.content_error.message}`,
        );
      if (details.length) parts.push(diagnostic(details.join('\n')));
    }
    if (item.text) parts.push(pageBody(language, item.text, summary));
    return parts;
  });
  sections.push(results);
  return sections.join('\n\n');
}

export function renderScrape(data: ScrapeData, language: Language): string {
  return [
    `${sourceLabel('firecrawl', language)} · ${link(data.url, data.title)}`,
    ...warnings(data.warnings, language),
    ...contentInfo(data, language),
    data.text,
  ].join('\n\n');
}

export function renderMapLinks(links: MapData['links'], language: Language): string {
  if (!links.length) return text(language, 'noSiteLinks');
  return links
    .map((item) => {
      const entry = `- ${link(item.url, item.title)}`;
      if (!item.description?.trim()) return entry;
      const description = proseField(language, 'descriptionLabel', item.description);
      return `${entry}\n${indentListBlock(description)}`;
    })
    .join('\n');
}

export function renderMap(data: MapData, language: Language): string {
  return [
    sourceLabel('firecrawl', language),
    ...warnings(data.warnings, language),
    renderMapLinks(data.links, language),
  ].join('\n\n');
}
