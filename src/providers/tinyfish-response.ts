import { hasNonfiniteNumber, isObject } from '../config/fields.js';
import type { AttemptContext } from '../execution.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { success } from '../result.js';
import type { JsonObject, Outcome, PublicError } from '../result.js';
import { validPageUrl } from './firecrawl-response.js';

export type SearchItem = JsonObject & {
  url: string;
  title?: string;
  snippet?: string;
  site_name?: string;
  position?: number;
  date?: string;
  publisher?: string;
  authors?: string[];
  venue?: string;
  year?: number;
  cited_by_count?: number;
  pdf_url?: string;
  thumbnail_url?: string;
};
export type SearchData = { provider: 'tinyfish'; page?: number; results: SearchItem[] };
export type Page = JsonObject & {
  url: string;
  text?: string;
  title?: string;
  final_url?: string;
  description?: string;
  language?: string;
  author?: string;
  published_date?: string;
  links?: string[];
  image_links?: string[];
  page_metadata?: JsonObject;
  unmatched_selectors?: string[];
  missing_content?: string[];
  etag?: string;
  last_modified?: string;
  not_modified?: boolean;
};
export type FetchData = { provider: 'tinyfish'; results: Page[] };
type UrlFailure = PublicError & { url: string };

function issue(field: string, language: Language): PublicError {
  return {
    code: 'INVALID_RESPONSE',
    message: text(language, 'tinyfishResponse'),
    details: { field },
  };
}
function reader(
  item: Record<string, unknown>,
  path: string,
  issues: PublicError[],
  language: Language,
) {
  const bad = (key: string) => {
    issues.push(issue(`${path}.${key}`, language));
  };
  return {
    bad,
    string(key: string): string | undefined {
      const value = item[key];
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'string') {
        bad(key);
        return undefined;
      }
      return value.trim() ? value : undefined;
    },
    strings(key: string, keepEmpty = false): string[] | undefined {
      const value = item[key];
      if (value === undefined) return undefined;
      if (!Array.isArray(value)) {
        bad(key);
        return undefined;
      }
      const items: string[] = [];
      for (const [index, entry] of value.entries()) {
        if (typeof entry !== 'string' || !entry.trim()) bad(`${key}[${index}]`);
        else items.push(entry);
      }
      return items.length || keepEmpty ? items : undefined;
    },
    number(key: string, minimum: number): number | undefined {
      const value = item[key];
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
        bad(key);
        return undefined;
      }
      return value;
    },
  };
}
function details(context: AttemptContext, hasData: boolean): JsonObject {
  return {
    ...(hasData ? {} : { provider: 'tinyfish' }),
    ...(context.requestId ? { request_id: context.requestId } : {}),
  };
}
function invalidResult<T extends JsonObject>(
  issues: PublicError[],
  context: AttemptContext,
  language: Language,
  data?: T,
): Outcome<T> {
  return {
    result: {
      status: 'error',
      ...(data ? { data } : {}),
      error: {
        code: 'INVALID_RESPONSE',
        message: text(language, 'tinyfishResponse'),
        details: {
          ...details(context, data !== undefined),
          ...(issues.length === 1 ? issues[0].details : { causes: issues }),
        },
      },
    },
    exitCode: 4,
  };
}

export function searchData(
  body: unknown,
  context: AttemptContext,
  language: Language,
): Outcome<SearchData> {
  if (!isObject(body)) return invalidResult([issue('response', language)], context, language);
  const issues: PublicError[] = [];
  let page: number | undefined;
  if (typeof body.page !== 'number' || !Number.isSafeInteger(body.page) || body.page < 0)
    issues.push(issue('page', language));
  else page = body.page;
  if (!Array.isArray(body.results))
    return invalidResult([...issues, issue('results', language)], context, language);
  const results: SearchItem[] = [];
  for (const [index, item] of body.results.entries()) {
    const path = `results[${index}]`;
    if (!isObject(item)) {
      issues.push(issue(path, language));
      continue;
    }
    if (!validPageUrl(item.url)) {
      issues.push(issue(`${path}.url`, language));
      continue;
    }
    const result: SearchItem = { url: item.url };
    const read = reader(item, path, issues, language);
    for (const key of ['title', 'snippet', 'site_name', 'date', 'publisher', 'venue'] as const) {
      const value = read.string(key);
      if (value !== undefined) result[key] = value;
    }
    for (const key of ['pdf_url', 'thumbnail_url'] as const) {
      const value = read.string(key);
      if (value !== undefined) {
        if (!validPageUrl(value)) read.bad(key);
        else result[key] = value;
      }
    }
    for (const key of ['position', 'year', 'cited_by_count'] as const) {
      const value = read.number(key, key === 'position' ? 1 : 0);
      if (value !== undefined) result[key] = value;
    }
    if (item.authors !== null) {
      const authors = read.strings('authors');
      if (authors) result.authors = authors;
    }
    results.push(result);
  }
  const data: SearchData | undefined =
    results.length || body.results.length === 0
      ? { provider: 'tinyfish', ...(page === undefined ? {} : { page }), results }
      : undefined;
  return issues.length ? invalidResult(issues, context, language, data) : success(data!);
}

const pageErrors: Record<string, MessageKey> = {
  target_http_error: 'tinyfishTargetHttp',
  page_not_found: 'tinyfishNotFound',
  timeout: 'tinyfishPageTimeout',
  bot_blocked: 'tinyfishBotBlocked',
  empty_content: 'tinyfishEmpty',
  login_required: 'tinyfishLogin',
  content_too_large: 'tinyfishTooLarge',
  target_unreachable: 'tinyfishUnreachable',
  proxy_error: 'tinyfishProxy',
  invalid_url: 'tinyfishInvalidUrl',
  invalid_redirect_url: 'tinyfishRedirect',
  selector_not_matched: 'tinyfishSelectorMiss',
  selector_unsupported: 'tinyfishSelectorUnsupported',
  conditional_unsupported: 'tinyfishConditional',
};

export function fetchData(
  body: unknown,
  input: { urls: string[]; body: JsonObject },
  context: AttemptContext,
  language: Language,
): Outcome<FetchData> {
  if (!isObject(body)) return invalidResult([issue('response', language)], context, language);
  const issues: PublicError[] = [];
  const failures: UrlFailure[] = [];
  const results: Page[] = [];
  const remaining = new Map<string, number>();
  for (const url of input.urls) remaining.set(url, (remaining.get(url) ?? 0) + 1);
  const identify = (entry: Record<string, unknown>, path: string): string | undefined => {
    if (!validPageUrl(entry.url)) {
      issues.push(issue(`${path}.url`, language));
      return undefined;
    }
    const count = remaining.get(entry.url);
    if (count === undefined || count <= 0) issues.push(issue(`${path}.url`, language));
    if (count !== undefined) remaining.set(entry.url, count - 1);
    return entry.url;
  };
  if (!Array.isArray(body.results)) issues.push(issue('results', language));
  else
    for (const [index, item] of body.results.entries()) {
      const path = `results[${index}]`;
      if (!isObject(item)) {
        issues.push(issue(path, language));
        continue;
      }
      const url = identify(item, path);
      if (url === undefined) continue;
      const page: Page = { url };
      const read = reader(item, path, issues, language);
      for (const key of [
        'title',
        'description',
        'language',
        'author',
        'published_date',
        'etag',
        'last_modified',
      ] as const) {
        const value = read.string(key);
        if (value !== undefined) page[key] = value;
      }
      const finalUrl = read.string('final_url');
      if (finalUrl !== undefined) {
        if (!validPageUrl(finalUrl)) read.bad('final_url');
        else if (finalUrl !== url) page.final_url = finalUrl;
      }
      if (item.format !== 'markdown') read.bad('format');
      if (item.text !== null && typeof item.text !== 'string') read.bad('text');
      else if (typeof item.text === 'string' && item.text.trim() && item.format === 'markdown')
        page.text = item.text;
      else if (item.format === 'markdown')
        failures.push({
          url,
          code: 'CONTENT_UNAVAILABLE',
          message: text(language, 'tinyfishEmpty'),
          details: { reason: 'empty_content' },
        });
      if (page.description === page.text) delete page.description;
      for (const key of ['links', 'image_links'] as const) {
        const value = read.strings(key, true);
        if (value !== undefined) page[key] = value;
        if (input.body[key] === true && item[key] === undefined)
          (page.missing_content ??= []).push(key);
      }
      const unmatched = read.strings('unmatched_selectors');
      if (unmatched) page.unmatched_selectors = unmatched;
      if (item.page_metadata !== undefined && item.page_metadata !== null) {
        if (!isObject(item.page_metadata) || hasNonfiniteNumber(item.page_metadata))
          read.bad('page_metadata');
        else if (Object.keys(item.page_metadata).length)
          page.page_metadata = item.page_metadata as JsonObject;
      }
      if (item.not_modified !== undefined) {
        if (typeof item.not_modified !== 'boolean') read.bad('not_modified');
        else if (item.not_modified) page.not_modified = true;
      }
      if (item.latency_ms !== undefined && item.latency_ms !== null) {
        if (
          typeof item.latency_ms !== 'number' ||
          !Number.isFinite(item.latency_ms) ||
          item.latency_ms < 0
        )
          read.bad('latency_ms');
        else (context.pageLatencies ??= []).push({ url, latency_ms: item.latency_ms });
      }
      if (Object.keys(page).some((key) => key !== 'url' && key !== 'missing_content'))
        results.push(page);
    }
  if (!Array.isArray(body.errors)) issues.push(issue('errors', language));
  else
    for (const [index, entry] of body.errors.entries()) {
      const path = `errors[${index}]`;
      if (!isObject(entry)) {
        issues.push(issue(path, language));
        continue;
      }
      const url = identify(entry, path);
      const read = reader(entry, path, issues, language);
      if (typeof entry.error !== 'string' || !entry.error.trim()) {
        read.bad('error');
        continue;
      }
      if (url === undefined) continue;
      const key = Object.hasOwn(pageErrors, entry.error)
        ? pageErrors[entry.error]
        : 'tinyfishReadFailed';
      let code: PublicError['code'] = 'CONTENT_UNAVAILABLE';
      if (entry.error === 'invalid_url') code = 'INVALID_ARGUMENT';
      else if (key === 'tinyfishReadFailed' || entry.error === 'conditional_unsupported')
        code = 'UPSTREAM_ERROR';
      const own: JsonObject = { upstream_code: entry.error };
      if (entry.status !== undefined) {
        if (
          typeof entry.status !== 'number' ||
          !Number.isInteger(entry.status) ||
          entry.status < 100 ||
          entry.status > 599
        )
          read.bad('status');
        else own.page_status = entry.status;
      }
      for (const name of ['unmatched_selectors', 'candidate_selectors']) {
        const value = read.strings(name);
        if (value) own[name] = value;
      }
      failures.push({ url, code, message: text(language, key), details: own });
    }
  if ([...remaining.values()].some((count) => count !== 0))
    issues.push({
      code: 'INVALID_RESPONSE',
      message: text(language, 'tinyfishCount'),
      details: { reason: 'result_count_mismatch' },
    });
  const data: FetchData | undefined = results.length
    ? { provider: 'tinyfish', results }
    : undefined;
  const hasInvalidArgument = failures.some((item) => item.code === 'INVALID_ARGUMENT');
  if (issues.length && !hasInvalidArgument) {
    const outcome = invalidResult(issues, context, language, data);
    if (failures.length && outcome.result.error) {
      if (input.urls.length === 1 && failures.length === 1) {
        const { url, details: own, ...cause } = failures[0];
        (outcome.result.error.details!.causes ??= []).push({ ...cause, details: { url, ...own } });
      } else outcome.result.error.details!.failures = failures;
    }
    return outcome;
  }
  if (!failures.length) return success(data!);
  const own = details(context, !!data);
  if (issues.length) own.causes = issues;
  if (input.urls.length === 1 && failures.length === 1) {
    const { url, details: reason, ...error } = failures[0];
    return {
      result: {
        status: 'error',
        ...(data ? { data } : {}),
        error: { ...error, details: { ...own, url, ...reason } },
      },
      exitCode: hasInvalidArgument ? 2 : 4,
    };
  }
  own.failures = failures;
  if (!hasInvalidArgument && data && results.some((page) => page.text))
    return {
      result: {
        status: 'partial',
        data,
        error: { code: 'PARTIAL_FAILURE', message: text(language, 'exaPartial'), details: own },
      },
      exitCode: 6,
    };
  let code: PublicError['code'] = 'UPSTREAM_ERROR';
  if (hasInvalidArgument) code = 'INVALID_ARGUMENT';
  else if (failures.every((item) => item.code === failures[0].code)) code = failures[0].code;
  return {
    result: {
      status: 'error',
      ...(data ? { data } : {}),
      error: {
        code,
        message: text(language, hasInvalidArgument ? 'tinyfishArgument' : 'exaAllContentFailed'),
        details: own,
      },
    },
    exitCode: hasInvalidArgument ? 2 : 4,
  };
}
