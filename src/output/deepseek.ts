import { colon, text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { FetchData, SearchData } from '../providers/deepseek-response.js';
import { inline, resultTitle } from './exa.js';
import { link } from './firecrawl.js';

export function renderSearch(
  data: SearchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const separator = colon(language);
  const parts = showProvider ? [text(language, 'deepseekSource')] : [];
  if (!data.results.length) parts.push(text(language, 'noResults'));
  for (const [index, item] of data.results.entries()) {
    if (index) parts.push('---');
    parts.push(resultTitle(index, item.url, item.title, level, !!item.summary?.trim()));
    const metadata: string[] = [];
    for (const [value, label] of [
      [item.site_name, 'deepseekSiteLabel'],
      [item.date, 'publishedLabel'],
      [item.authority, 'deepseekAuthorityLabel'],
      [item.rerank_score, 'relevanceScore'],
    ] as const)
      if (value !== undefined)
        metadata.push(`${text(language, label)}${separator}${inline(String(value))}`);
    if (metadata.length) parts.push(metadata.join(' · '));
    if (item.summary) parts.push(item.summary);
    if (item.content) {
      parts.push(`${'#'.repeat(level + 1)} ${text(language, 'textLabel')}`);
      parts.push(item.content);
    }
  }
  return parts.join('\n\n');
}

export function renderFetch(data: FetchData, language: Language): string {
  const [page] = data.results;
  return [`${text(language, 'deepseekSource')} · ${link(page.url, page.title)}`, page.text].join(
    '\n\n',
  );
}
