import type { Language } from '../i18n/messages.js';
import { text } from '../i18n/messages.js';
import type { JsonObject } from '../result.js';
import type { CombinedData } from '../search.js';
import { inline, renderPageLatencies, renderSearch } from './exa.js';
import { renderTavilySearch } from './tavily.js';
import { renderSearch as renderFirecrawlSearch } from './firecrawl.js';
import { renderJina } from './jina.js';
import { renderZhipu } from './zhipu.js';
import { renderMcp } from './zhipu-mcp.js';
import { renderSearch as renderAnySearch } from './anysearch.js';
import { renderSearch as renderTinyfish } from './tinyfish.js';

export function renderCombinedSearch(data: CombinedData, language: Language): string {
  const sections: string[] = [];
  const separator = language === 'zh' ? '：' : ': ';
  if (data.answer) {
    if (data.extra_sources) sections.push(`## ${text(language, 'modelAnswerLabel')}`);
    sections.push(
      `${text(language, 'modelLabel')}${separator}${inline(data.answer.model)}`,
      data.answer.text,
    );
    if (data.answer.sources) {
      const sources = data.answer.sources.map((source) => {
        const url = source.url.replace(/[<>\s()\\]/g, (value) =>
          encodeURIComponent(value).replace(/\(/g, '%28').replace(/\)/g, '%29'),
        );
        return `- [${inline(source.title ?? source.url)}](${url})`;
      });
      sections.push(`### ${text(language, 'modelSourcesLabel')}\n\n${sources.join('\n')}`);
    }
  }
  if (data.extra_sources) {
    sections.push(`## ${text(language, 'extraSourcesLabel')}`);
    for (const source of data.extra_sources) {
      if (source.provider === 'zhipu')
        sections.push(
          `### ${text(language, 'zhipuLabel')}`,
          renderZhipu({ provider: 'zhipu', ...source.data }, language, 4, false),
        );
      else if (source.provider === 'tinyfish')
        sections.push(
          '### TinyFish',
          renderTinyfish({ provider: 'tinyfish', ...source.data }, language, 4, false),
        );
      else if (source.provider === 'zhipu-mcp')
        sections.push(
          '### Zhipu MCP',
          renderMcp({ provider: 'zhipu-mcp', ...source.data }, language, 'search', false),
        );
      else if (source.provider === 'anysearch')
        sections.push(
          '### AnySearch',
          renderAnySearch({ provider: 'anysearch', ...source.data }, language, 4, false),
        );
      else if (source.provider === 'exa')
        sections.push(
          '### Exa',
          renderSearch({ provider: 'exa', ...source.data }, language, 4, false),
        );
      else if (source.provider === 'tavily')
        sections.push(
          '### Tavily',
          renderTavilySearch({ provider: 'tavily', ...source.data }, language, 4, false),
        );
      else if (source.provider === 'jina')
        sections.push(
          '### Jina',
          renderJina({ provider: 'jina', ...source.data }, language, 4, false),
        );
      else
        sections.push(
          '### Firecrawl',
          renderFirecrawlSearch({ provider: 'firecrawl', ...source.data }, language, 4, false),
        );
    }
  }
  return sections.join('\n\n');
}

export function renderSearchExecution(data: JsonObject, language: Language): string {
  if (!Array.isArray(data.attempts)) return '';
  const separator = language === 'zh' ? '：' : ': ';
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
        item.request_id ? `${text(language, 'requestIdLabel')} ${item.request_id}` : '',
        item.response_id ? `${text(language, 'responseIdLabel')} ${item.response_id}` : '',
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
  ].join('\n');
}
