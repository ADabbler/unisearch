import { colon, text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { ExtractData, MapData, TavilySearchData } from '../providers/tavily.js';
import { inline, resultTitle } from './exa.js';
import { link } from './firecrawl.js';

export function renderTavilySearch(
  data: TavilySearchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const separator = colon(language);
  const entries = data.results.map((item, index) => {
    const sections = [
      resultTitle(
        index,
        item.url,
        item.title,
        level,
        !!item.content?.trim() || !!item.text?.trim(),
      ),
    ];
    const metadata = [
      item.published_date
        ? `${text(language, 'tavilyPublished')}${separator}${inline(item.published_date)}`
        : '',
      item.score === undefined
        ? ''
        : `${text(language, 'relevanceScore')}${separator}${item.score}`,
    ].filter(Boolean);
    if (metadata.length) sections.push(metadata.join(' · '));
    if (item.missing_content)
      sections.push(
        `${text(language, 'missingContentLabel')}${separator}${language === 'zh' ? text(language, 'textLabel') : 'text'}`,
      );
    if (item.content)
      sections.push(
        `${'#'.repeat(level + 1)} ${text(language, 'tavilyContent')}\n\n${item.content}`,
      );
    if (item.text)
      sections.push(`${'#'.repeat(level + 1)} ${text(language, 'textLabel')}\n\n${item.text}`);
    return sections.join('\n\n');
  });
  return `${showProvider ? `${text(language, 'tavilySource')}\n\n` : ''}${entries.length ? entries.join('\n\n---\n\n') : text(language, 'noResults')}`;
}
export function renderExtract(data: ExtractData, language: Language): string {
  return `${text(language, 'tavilySource')}${data.content_type === 'snippets' ? ` · ${text(language, 'tavilySnippets')}` : ''}\n\n${data.results.map((item) => `## ${link(item.url)}\n\n${item.text}`).join('\n\n---\n\n')}`;
}
export function renderMap(data: MapData, language: Language): string {
  return `${text(language, 'tavilySource')}\n\n${data.results.length ? data.results.map((url) => `- ${link(url)}`).join('\n') : text(language, 'noSiteLinks')}`;
}
