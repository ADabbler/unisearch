import { isObject } from '../config/fields.js';
import { AppError, failure } from '../errors.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { success } from '../result.js';
import type { JsonObject, Outcome, PublicError } from '../result.js';
import type { SearchResult } from './exa.js';
import { validPageUrl } from './firecrawl-response.js';

export type ContentSource = { url: string; source: 'cached' | 'crawled' };
export type FetchData = JsonObject & {
  provider: 'exa';
  results: SearchResult[];
  content_sources?: ContentSource[];
};
type UrlFailure = PublicError & { url: string };

export function contentsData(
  body: unknown,
  request: { urls: string[]; highlights: boolean },
  language: Language,
): Outcome<FetchData> {
  const results: SearchResult[] = [];
  const failures: UrlFailure[] = [];
  const sources: ContentSource[] = [];
  let structural: { key: MessageKey; reason?: string } | undefined;
  let successful = 0;
  const fail = (
    url: string,
    code: 'INVALID_RESPONSE' | 'CONTENT_UNAVAILABLE',
    key: MessageKey,
    details?: JsonObject,
  ) => {
    failures.push({
      url,
      code,
      message: text(language, key),
      ...(details && Object.keys(details).length ? { details } : {}),
    });
  };
  if (!isObject(body) || !Array.isArray(body.results)) structural = { key: 'invalidResults' };
  const entries = isObject(body) && Array.isArray(body.results) ? body.results : [];
  for (const item of entries) {
    if (!isObject(item) || !validPageUrl(item.url)) {
      structural ??= { key: 'invalidResponse' };
      continue;
    }
    const result: SearchResult = { url: item.url };
    let invalid = false;
    if (typeof item.title !== 'string') invalid = true;
    else if (item.title.trim()) result.title = item.title;
    for (const [source, target] of [
      ['publishedDate', 'published_date'],
      ['author', 'author'],
    ] as const) {
      const value = item[source];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string') invalid = true;
      else result[target] = value;
    }
    if (item.text !== undefined && item.text !== null) {
      if (typeof item.text !== 'string') invalid = true;
      else if (item.text.trim()) result.text = item.text;
    }
    if (request.highlights) {
      const value = item.highlights;
      let invalidHighlights = false;
      if (value !== undefined && value !== null) {
        if (!Array.isArray(value)) invalidHighlights = true;
        else {
          const highlights: string[] = [];
          for (const entry of value) {
            if (typeof entry !== 'string') invalidHighlights = true;
            else if (entry.trim()) highlights.push(entry);
          }
          if (highlights.length) result.highlights = highlights;
        }
      }
      if (result.text && !result.highlights && !invalidHighlights)
        result.missing_content = ['highlights'];
      invalid ||= invalidHighlights;
    }
    if (result.text || result.highlights) results.push(result);
    if (invalid) fail(item.url, 'INVALID_RESPONSE', 'invalidResponse');
    else if (!result.text)
      fail(item.url, 'CONTENT_UNAVAILABLE', 'exaEmptyContent', { reason: 'empty_content' });
    else successful++;
  }
  const statuses = isObject(body) ? body.statuses : undefined;
  let errorCount = 0;
  if (statuses !== undefined) {
    if (!Array.isArray(statuses))
      structural = { key: 'exaStatusMismatch', reason: 'status_result_mismatch' };
    else {
      const remaining = new Map<string, number>();
      for (const url of request.urls) remaining.set(url, (remaining.get(url) ?? 0) + 1);
      let invalidStatuses = false;
      for (const item of statuses) {
        if (
          !isObject(item) ||
          typeof item.id !== 'string' ||
          !remaining.has(item.id) ||
          (item.status !== 'success' && item.status !== 'error')
        ) {
          invalidStatuses = true;
          continue;
        }
        remaining.set(item.id, remaining.get(item.id)! - 1);
        const source = item.source;
        const validSource = source === 'cached' || source === 'crawled';
        let invalid = source !== undefined && !validSource;
        if (item.status === 'success') {
          if (validSource) sources.push({ url: item.id, source });
          if (item.error !== undefined && item.error !== null) invalid = true;
          if (invalid) invalidStatuses = true;
          continue;
        }
        errorCount++;
        const details: JsonObject = {};
        if (validSource) details.content_source = source;
        if (item.error !== undefined && item.error !== null) {
          if (!isObject(item.error)) invalid = true;
          else {
            const tag = item.error.tag;
            if (tag !== undefined) {
              if (typeof tag !== 'string') invalid = true;
              else if (tag.trim()) details.upstream_code = tag;
            }
            const status = item.error.httpStatusCode;
            if (status !== undefined && status !== null) {
              if (
                typeof status !== 'number' ||
                !Number.isInteger(status) ||
                status < 100 ||
                status > 599
              )
                invalid = true;
              else details.page_status = status;
            }
          }
        }
        fail(
          item.id,
          invalid ? 'INVALID_RESPONSE' : 'CONTENT_UNAVAILABLE',
          invalid ? 'invalidResponse' : 'exaContentUnavailable',
          details,
        );
      }
      if (invalidStatuses || [...remaining.values()].some((count) => count !== 0))
        structural = { key: 'exaStatusMismatch', reason: 'status_result_mismatch' };
    }
  }
  if (
    !structural &&
    !(statuses === undefined && entries.length === 0) &&
    entries.length + errorCount !== request.urls.length
  )
    structural = { key: 'exaResultCount', reason: 'result_count_mismatch' };
  const data: FetchData | undefined = results.length
    ? { provider: 'exa', results, ...(sources.length ? { content_sources: sources } : {}) }
    : undefined;
  if (!structural && !failures.length && successful) return success(data!);
  const details: JsonObject = {
    ...(data ? {} : { provider: 'exa', ...(sources.length ? { content_sources: sources } : {}) }),
  };
  if (structural) {
    if (structural.reason) details.reason = structural.reason;
    if (failures.length) {
      if (request.urls.length === 1 && failures.length === 1) {
        const { url, ...cause } = failures[0];
        details.causes = [{ ...cause, details: { ...cause.details, url } }];
      } else details.failures = failures;
    }
    const outcome = failure<FetchData>(
      new AppError('INVALID_RESPONSE', structural.key, details),
      language,
    );
    if (data) outcome.result.data = data;
    return outcome;
  }
  if (!failures.length)
    return failure(
      new AppError('CONTENT_UNAVAILABLE', 'exaEmptyContent', {
        ...details,
        reason: 'empty_content',
      }),
      language,
    );
  if (request.urls.length === 1) {
    const { url, details: own, ...error } = failures[0];
    return {
      result: {
        status: 'error',
        ...(data ? { data } : {}),
        error: { ...error, details: { ...details, url, ...own } },
      },
      exitCode: 4,
    };
  }
  details.failures = failures;
  if (successful && data)
    return {
      result: {
        status: 'partial',
        data,
        error: { code: 'PARTIAL_FAILURE', message: text(language, 'exaPartial'), details },
      },
      exitCode: 6,
    };
  return {
    result: {
      status: 'error',
      ...(data ? { data } : {}),
      error: {
        code: failures.every((item) => item.code === failures[0].code)
          ? failures[0].code
          : 'UPSTREAM_ERROR',
        message: text(language, 'exaAllContentFailed'),
        details,
      },
    },
    exitCode: 4,
  };
}
