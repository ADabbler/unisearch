import { colon, text } from '../i18n/messages.js';
import { sourceLabel } from '../i18n/providers.js';
import type { Language } from '../i18n/messages.js';
import type { FetchData, SearchData } from '../providers/deepseek-response.js';
import { distinctSummary, inline, link, pageBody, proseField, rankedResults } from './markdown.js';

export function renderSearch(
  data: SearchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const separator = colon(language);
  const entries = rankedResults(data.results, language, level, (item) => {
    const parts: string[] = [];
    const metadata: string[] = [];
    for (const [value, label] of [
      [item.site_name, 'siteLabel'],
      [item.date, 'publishedLabel'],
      [item.authority, 'deepseekAuthorityLabel'],
      [item.rerank_score, 'relevanceScore'],
    ] as const)
      if (value !== undefined)
        metadata.push(`${text(language, label)}${separator}${inline(String(value))}`);
    if (metadata.length) parts.push(metadata.join(' · '));
    const summary = distinctSummary(item.summary, item.text);
    if (summary) parts.push(proseField(language, 'summaryLabel', summary));
    if (item.text) parts.push(pageBody(language, item.text, summary));
    return parts;
  });
  return showProvider ? `${sourceLabel('deepseek', language)}\n\n${entries}` : entries;
}

export function renderFetch(data: FetchData, language: Language): string {
  const [page] = data.results;
  return [`${sourceLabel('deepseek', language)} · ${link(page.url, page.title)}`, page.text].join(
    '\n\n',
  );
}
