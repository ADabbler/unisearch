import { colon, text } from '../i18n/messages.js';
import { sourceLabel } from '../i18n/providers.js';
import type { Language } from '../i18n/messages.js';
import type { ExtractData, MapData, TavilySearchData } from '../providers/tavily.js';
import {
  distinctSummary,
  fenced,
  inline,
  link,
  pageBody,
  proseField,
  rankedResults,
  renderPages,
} from './markdown.js';

export function renderTavilySearch(
  data: TavilySearchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const separator = colon(language);
  const entries = rankedResults(data.results, language, level, (item) => {
    const sections: string[] = [];
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
    const summary = distinctSummary(item.summary, item.text);
    if (summary) sections.push(proseField(language, 'tavilyContent', summary));
    if (item.text) sections.push(pageBody(language, item.text, summary));
    return sections;
  });
  return showProvider ? `${sourceLabel('tavily', language)}\n\n${entries}` : entries;
}
export function renderExtract(data: ExtractData, language: Language): string {
  const snippets = data.content_type === 'snippets';
  const source =
    sourceLabel('tavily', language) + (snippets ? ` · ${text(language, 'tavilySnippets')}` : '');
  return renderPages(data.results, language, source, (item, single) => [
    single && !snippets ? item.text : fenced(item.text),
  ]);
}
export function renderMap(data: MapData, language: Language): string {
  return `${sourceLabel('tavily', language)}\n\n${data.results.length ? data.results.map((url) => `- ${link(url)}`).join('\n') : text(language, 'noSiteLinks')}`;
}
