import { colon, text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type {
  ContentTruncation,
  MapData,
  ScrapeData,
  SearchData,
} from '../providers/firecrawl-response.js';
import { inline, linkTarget, resultTitle } from './exa.js';

export function link(url: string, title = url): string {
  return `[${inline(title)}](${linkTarget(url)})`;
}
export function warnings(values: string[] | undefined, language: Language): string[] {
  return (values ?? []).map(
    (value) =>
      `${text(language, 'upstreamWarningLabel')}${colon(language)}${value.replace(/\r\n|\r/g, '\n')}`,
  );
}
export function contentInfo(
  data: { final_url?: string; content_truncation?: ContentTruncation },
  language: Language,
): string[] {
  const sections: string[] = [];
  if (data.final_url)
    sections.push(`${text(language, 'finalUrlLabel')}${colon(language)}${inline(data.final_url)}`);
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
  const sections = showProvider ? [text(language, 'firecrawlSource')] : [];
  sections.push(...warnings(data.warnings, language));
  const results = data.results.map((item, index) => {
    const parts = [
      resultTitle(
        index,
        item.url,
        item.title,
        level,
        !!item.description?.trim() || !!item.text?.trim(),
      ),
    ];
    if (item.category)
      parts.push(`${text(language, 'categoryLabel')}${colon(language)}${inline(item.category)}`);
    parts.push(...warnings(item.warnings, language));
    if (item.description) parts.push(item.description);
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
      parts.push(details.join('\n').replace(/\r\n|\r/g, '\n'));
    }
    if (item.text)
      parts.push(`${'#'.repeat(level + 1)} ${text(language, 'textLabel')}\n\n${item.text}`);
    return parts.join('\n\n');
  });
  sections.push(results.length ? results.join('\n\n---\n\n') : text(language, 'noResults'));
  return sections.join('\n\n');
}

export function renderScrape(data: ScrapeData, language: Language): string {
  return [
    `${text(language, 'firecrawlSource')} · ${link(data.url, data.title)}`,
    ...warnings(data.warnings, language),
    ...contentInfo(data, language),
    data.text,
  ].join('\n\n');
}

export function renderMapLinks(links: MapData['links'], language: Language): string {
  if (!links.length) return text(language, 'noSiteLinks');
  return links
    .map((item, index) => {
      const prefix = `${index + 1}. `;
      const indent = ' '.repeat(prefix.length);
      const description = item.description
        ?.split(/\r\n|\r|\n/)
        .map((line) => indent + line)
        .join('\n');
      return `${prefix}${link(item.url, item.title)}${description ? `\n${description}` : ''}`;
    })
    .join('\n');
}

export function renderMap(data: MapData, language: Language): string {
  return [
    text(language, 'firecrawlSource'),
    ...warnings(data.warnings, language),
    renderMapLinks(data.links, language),
  ].join('\n\n');
}
