import { providerName } from '../i18n/providers.js';
import type { Language } from '../i18n/messages.js';
import { colon, text } from '../i18n/messages.js';
import type { JsonObject } from '../result.js';
import type { CombinedData } from '../search.js';
import { renderPageLatencies, renderSearch } from './exa.js';
import { blockField, fenced, inline, link } from './markdown.js';
import { renderTavilySearch } from './tavily.js';
import { renderSearch as renderFirecrawlSearch } from './firecrawl.js';
import { renderJina } from './jina.js';
import { renderZhipu } from './zhipu.js';
import { renderMcp } from './zhipu-mcp.js';
import { renderSearch as renderAnySearch } from './anysearch.js';
import { renderSearch as renderTinyfish } from './tinyfish.js';
import { renderSearch as renderDeepseek } from './deepseek.js';

function renderSource(
  source: CombinedData['sources'][number],
  language: Language,
  grouped: boolean,
): string {
  const { provider, data } = source;
  const level = grouped ? 3 : 2;
  switch (provider) {
    case 'model': {
      const sections = [
        `${text(language, 'modelLabel')}${colon(language)}${inline(data.model)}`,
        grouped ? fenced(data.text) : data.text,
      ];
      if (data.citations?.length) {
        const citations = data.citations.map((item) => `- ${link(item.url, item.title)}`);
        sections.push(blockField(language, 'modelSourcesLabel', citations.join('\n')));
      }
      return sections.join('\n\n');
    }
    case 'zhipu':
      return renderZhipu({ provider, ...data }, language, level, !grouped);
    case 'tinyfish':
      return renderTinyfish({ provider, ...data }, language, level, !grouped);
    case 'zhipu-mcp':
      return renderMcp({ provider, ...data }, language, 'search', !grouped);
    case 'anysearch':
      return renderAnySearch({ provider, ...data }, language, level, !grouped);
    case 'exa':
      return renderSearch({ provider, ...data }, language, level, !grouped);
    case 'tavily':
      return renderTavilySearch({ provider, ...data }, language, level, !grouped);
    case 'jina':
      return renderJina({ provider, ...data }, language, level, !grouped);
    case 'deepseek':
      return renderDeepseek({ provider, ...data }, language, level, !grouped);
    case 'firecrawl':
      return renderFirecrawlSearch({ provider, ...data }, language, level, !grouped);
  }
}

export function renderCombinedSearch(data: CombinedData, language: Language): string {
  const grouped = data.sources.length > 1;
  return data.sources
    .map((source) => {
      const body = renderSource(source, language, grouped);
      if (!grouped) return body;
      const title =
        source.provider === 'model'
          ? text(language, 'modelAnswerLabel')
          : providerName(source.provider, language);
      return `## ${title}\n\n${body}`;
    })
    .join('\n\n');
}

export function renderSearchExecution(data: JsonObject, language: Language): string {
  if (!Array.isArray(data.attempts)) return '';
  const separator = colon(language);
  const searched =
    Array.isArray(data.searched_sources) && data.searched_sources.length
      ? [
          '',
          `### ${text(language, 'modelSearchedSourcesLabel')}`,
          '',
          ...data.searched_sources.map((url) => `- ${link(String(url))}`),
        ]
      : [];
  return [
    `${text(language, 'elapsedLabel')}${separator}${data.elapsed_ms} ms`,
    ...data.attempts.map((value) => {
      const item = value as JsonObject;
      let target = String(item.provider);
      if (item.model) {
        target += `/${item.model}`;
        if (item.effort) target += `(${item.effort})`;
      }
      const summary = [
        target,
        `${item.duration_ms} ms`,
        item.http_status === undefined ? '' : `HTTP ${item.http_status}`,
        item.code ? `[${item.code}]` : '',
        item.request_id ? `${text(language, 'requestIdLabel')}${separator}${item.request_id}` : '',
        item.response_id
          ? `${text(language, 'responseIdLabel')}${separator}${item.response_id}`
          : '',
        item.billed_tokens === undefined
          ? ''
          : `${text(language, 'billedTokensLabel')}${separator}${item.billed_tokens}`,
        item.wait_ms === undefined
          ? ''
          : `${text(language, 'retryWaitLabel')} ${item.wait_ms} ms (${item.wait_source})`,
        item.retry_after_invalid ? 'retry_after_invalid: true' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return [summary, ...renderPageLatencies(item, language)].join('\n');
    }),
    ...searched,
  ].join('\n');
}
