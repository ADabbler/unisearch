import { text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { FetchData, SearchData } from '../providers/zhipu-response.js';
import { inline } from './exa.js';
import { link } from './firecrawl.js';
import { pageContent } from './jina.js';
import { inlineCode } from './context7.js';

export function renderZhipu(
  data: SearchData | FetchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const sep = language === 'zh' ? '：' : ': ';
  const source = text(language, 'zhipuSource');
  const sections: string[] = [];
  if ('search_engine' in data) {
    sections.push(
      `${showProvider ? `${source} · ` : ''}${text(language, 'zhipuEngineLabel')}${sep}${inlineCode(data.search_engine)}`,
    );
    for (const intent of data.search_intent ?? []) {
      for (const [key, label] of [
        ['intent', 'zhipuIntentLabel'],
        ['query', 'zhipuQueryLabel'],
        ['keywords', 'zhipuKeywordsLabel'],
      ] as const)
        if (intent[key]) sections.push(`${text(language, label)}${sep}${inline(intent[key])}`);
    }
    if (!data.results.length) sections.push(text(language, 'noResults'));
    for (const [index, item] of data.results.entries()) {
      sections.push(`${'#'.repeat(level)} ${index + 1}. ${link(item.url, item.title)}`);
      const labels: string[] = [];
      if (item.source)
        labels.push(`${text(language, 'zhipuWebsiteLabel')}${sep}${inline(item.source)}`);
      if (item.published_date)
        labels.push(`${text(language, 'publishedLabel')}${sep}${inline(item.published_date)}`);
      if (item.refer)
        labels.push(`${text(language, 'zhipuReferLabel')}${sep}${inlineCode(item.refer)}`);
      if (labels.length) sections.push(labels.join(' · '));
      if (item.description) sections.push(item.description);
    }
  } else {
    for (const page of data.results) {
      sections.push(`${source} · ${link(page.url, page.title)}`, ...pageContent(page, language));
    }
  }
  return sections.join('\n\n');
}
