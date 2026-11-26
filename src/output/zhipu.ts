import { colon, text } from '../i18n/messages.js';
import { sourceLabel } from '../i18n/providers.js';
import type { Language } from '../i18n/messages.js';
import type { FetchData, SearchData } from '../providers/zhipu-response.js';
import { inline, inlineCode, proseField, rankedResults, renderPages } from './markdown.js';
import { pageContent } from './jina.js';

export function renderZhipu(
  data: SearchData | FetchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const sep = colon(language);
  const source = sourceLabel('zhipu', language);
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
    sections.push(
      rankedResults(data.results, language, level, (item) => {
        const fields: string[] = [];
        const labels: string[] = [];
        if (item.source)
          labels.push(`${text(language, 'zhipuWebsiteLabel')}${sep}${inline(item.source)}`);
        if (item.published_date)
          labels.push(`${text(language, 'publishedLabel')}${sep}${inline(item.published_date)}`);
        if (item.refer)
          labels.push(`${text(language, 'zhipuReferLabel')}${sep}${inlineCode(item.refer)}`);
        if (labels.length) fields.push(labels.join(' · '));
        if (item.summary) fields.push(proseField(language, 'summaryLabel', item.summary));
        return fields;
      }),
    );
    return sections.join('\n\n');
  }
  return renderPages(data.results, language, source, (page, single) =>
    pageContent(page, language, single),
  );
}
