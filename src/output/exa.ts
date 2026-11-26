import { colon, text } from '../i18n/messages.js';
import { sourceLabel } from '../i18n/providers.js';
import type { Language } from '../i18n/messages.js';
import type { SearchData, FetchData, ContentSource } from '../providers/exa.js';
import type { JsonObject } from '../result.js';
import {
  blockField,
  diagnostic,
  highlightField,
  inline,
  jsonBlock,
  link,
  pageBody,
  rankedResults,
  renderPages,
} from './markdown.js';

function resultFields(item: SearchData['results'][number], language: Language): string[] {
  const separator = colon(language);
  const sections: string[] = [];
  const metadata = [
    item.published_date
      ? `${text(language, 'publishedLabel')}${separator}${inline(item.published_date)}`
      : '',
    item.author ? `${text(language, 'authorLabel')}${separator}${inline(item.author)}` : '',
  ].filter(Boolean);
  if (metadata.length) sections.push(metadata.join(' · '));
  if (item.missing_content)
    sections.push(
      `${text(language, 'missingContentLabel')}${separator}${language === 'zh' ? text(language, 'textLabel') : 'text'}`,
    );
  return sections;
}

export function renderSearch(
  data: SearchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const sections = showProvider ? [sourceLabel('exa', language)] : [];
  for (const key of ['warnings', 'notices'] as const)
    for (const item of data[key] ?? [])
      sections.push(
        diagnostic(
          `${text(language, key === 'warnings' ? 'upstreamWarningLabel' : 'exaUpstreamNoticeLabel')}${colon(language)}[${inline(item.code)}] ${inline(item.path)}: ${item.message}`,
        ),
      );
  if (data.output) sections.push(blockField(language, 'exaSynthesis', jsonBlock(data.output)));
  sections.push(
    rankedResults(data.results, language, level, (item) => {
      const fields = resultFields(item, language);
      if (item.highlights?.length) fields.push(highlightField(language, item.highlights));
      if (item.text) fields.push(pageBody(language, item.text, item.highlights));
      return fields;
    }),
  );
  return sections.join('\n\n');
}

export function contentSources(sources: ContentSource[] | undefined, language: Language): string[] {
  return (sources ?? []).map(
    (item) =>
      `${text(language, 'exaContentSourceLabel')}${colon(language)}${link(item.url)} · ${item.source}`,
  );
}

export function renderFetch(data: FetchData, language: Language): string {
  return renderPages(
    data.results,
    language,
    sourceLabel('exa', language),
    (page, single) => {
      const fields = resultFields(page, language);
      if (page.text) fields.push(pageBody(language, page.text, page.highlights, single));
      if (page.highlights?.length) fields.push(highlightField(language, page.highlights));
      return fields;
    },
    contentSources(data.content_sources, language),
  );
}

export function renderPageLatencies(entry: JsonObject, language: Language): string[] {
  if (!Array.isArray(entry.page_latencies)) return [];
  return entry.page_latencies.map((value) => {
    const page = value as JsonObject;
    return `  ${text(language, 'pageLatencyLabel')}${colon(language)}${page.url} · ${page.latency_ms} ms`;
  });
}

export function renderExecution(data: JsonObject, language: Language): string {
  if (!Array.isArray(data.attempts)) return '';
  const sep = colon(language);
  const lines = [`${text(language, 'elapsedLabel')}${sep}${data.elapsed_ms} ms`];
  for (const [index, value] of data.attempts.entries()) {
    const entry = value as JsonObject;
    const parts = [
      entry.http_status === undefined ? '' : `HTTP ${entry.http_status}`,
      `${entry.duration_ms} ms`,
      entry.code ? `[${entry.code}]` : text(language, 'successLabel'),
      entry.request_id ? `${text(language, 'requestIdLabel')}${sep}${entry.request_id}` : '',
      entry.response_id ? `${text(language, 'responseIdLabel')}${sep}${entry.response_id}` : '',
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
