import { text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { SearchData, FetchData, ContentSource } from '../providers/exa.js';
import type { JsonObject } from '../result.js';
import { link } from './firecrawl.js';

export function inline(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>]/g, '\\$&');
}

/** Percent-encode the characters that end a Markdown link destination. */
export function linkTarget(url: string): string {
  return url.replace(/[<>\s()\\]/g, (value) =>
    encodeURIComponent(value).replace(/\(/g, '%28').replace(/\)/g, '%29'),
  );
}

export function resultTitle(
  index: number,
  url: string,
  title: string | undefined,
  level: number,
  hasContent: boolean,
): string {
  const value = `${index + 1}. ${link(url, title)}`;
  return hasContent ? `${'#'.repeat(level)} ${value}` : value;
}

export function renderSearch(
  data: SearchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const separator = language === 'zh' ? '：' : ': ';
  const entries = data.results.map((item, index) => {
    const sections = [
      resultTitle(
        index,
        item.url,
        item.title,
        level,
        !!item.text?.trim() || !!item.highlights?.some((value) => value.trim()),
      ),
    ];
    const metadata = [
      item.published_date
        ? `${text(language, 'publishedLabel')}${separator}${inline(item.published_date)}`
        : '',
      item.author ? `${text(language, 'authorLabel')}${separator}${inline(item.author)}` : '',
    ].filter(Boolean);
    if (metadata.length) sections.push(metadata.join(' · '));
    if (item.missing_content) {
      const missing = item.missing_content.map((value) => {
        if (language !== 'zh') return value;
        return text(language, value === 'text' ? 'textLabel' : 'highlightsLabel');
      });
      sections.push(
        `${text(language, 'missingContentLabel')}${separator}${missing.join(language === 'zh' ? '、' : ', ')}`,
      );
    }
    if (item.highlights)
      sections.push(
        `${'#'.repeat(level + 1)} ${text(language, 'highlightsLabel')}\n\n${item.highlights
          .map((value) => value.replace(/\r\n|\r/g, '\n'))
          .join('\n\n')}`,
      );
    if (item.text)
      sections.push(`${'#'.repeat(level + 1)} ${text(language, 'textLabel')}\n\n${item.text}`);
    return sections.join('\n\n');
  });
  return `${showProvider ? `${text(language, 'exaSource')}\n\n` : ''}${entries.length ? entries.join('\n\n---\n\n') : text(language, 'noResults')}`;
}

export function contentSources(sources: ContentSource[] | undefined, language: Language): string[] {
  return (sources ?? []).map(
    (item) =>
      `${text(language, 'contentSourceLabel')}${language === 'zh' ? '：' : ': '}${link(item.url)} · ${item.source}`,
  );
}

export function renderFetch(data: FetchData, language: Language): string {
  return [
    text(language, 'exaSource'),
    ...contentSources(data.content_sources, language),
    renderSearch(data, language, 2, false),
  ].join('\n\n');
}

export function renderPageLatencies(entry: JsonObject, language: Language): string[] {
  if (!Array.isArray(entry.page_latencies)) return [];
  return entry.page_latencies.map((value) => {
    const page = value as JsonObject;
    return `  ${text(language, 'pageLatencyLabel')}${language === 'zh' ? '：' : ': '}${page.url} · ${page.latency_ms} ms`;
  });
}

export function renderExecution(data: JsonObject, language: Language): string {
  if (!Array.isArray(data.attempts)) return '';
  const sep = language === 'zh' ? '：' : ': ';
  const lines = [`${text(language, 'elapsedLabel')}${sep}${data.elapsed_ms} ms`];
  for (const [index, value] of data.attempts.entries()) {
    const entry = value as JsonObject;
    const parts = [
      entry.http_status === undefined ? '' : `HTTP ${entry.http_status}`,
      `${entry.duration_ms} ms`,
      entry.code ? `[${entry.code}]` : text(language, 'successLabel'),
      entry.request_id ? `${text(language, 'requestIdLabel')} ${entry.request_id}` : '',
      entry.response_id ? `${text(language, 'responseIdLabel')} ${entry.response_id}` : '',
      entry.model ? `${text(language, 'modelLabel')}${sep}${entry.model}` : '',
      entry.billed_tokens === undefined
        ? ''
        : `${text(language, 'billedTokensLabel')}${sep}${entry.billed_tokens}`,
    ].filter(Boolean);
    lines.push(
      `${text(language, 'attemptLabel')} ${index + 1}${sep}${parts.join(language === 'zh' ? '，' : ', ')}`,
    );
    if (entry.wait_ms !== undefined)
      lines.push(
        `${text(language, 'retryWaitLabel')}${sep}${entry.wait_ms} ms${language === 'zh' ? '，' : ', '}${text(language, 'sourceLabel')} ${entry.wait_source}`,
      );
    if (entry.retry_after_invalid) lines.push('retry_after_invalid: true');
    lines.push(...renderPageLatencies(entry, language));
  }
  return lines.join('\n');
}
