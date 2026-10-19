import { fieldAt, isObject, parseInput } from '../config/fields.js';
import { operationConfig } from '../config/status.js';
import type { OperationDefinition } from '../config/status.js';
import type { ResolvedField } from '../config/resolve.js';
import { AppError, failure } from '../errors.js';
import type { AttemptContext, AttemptResult } from '../execution.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { configuredSecrets, redactDiagnostics, transportError } from './transport.js';
import { validPageUrl } from './firecrawl-response.js';
import { contentsData } from './exa-contents.js';
import type { FetchData } from './exa-contents.js';
export type { FetchData, ContentSource } from './exa-contents.js';
import { success } from '../result.js';
import type { JsonObject, JsonValue, Outcome } from '../result.js';

export const exaSearch: OperationDefinition = {
  provider: 'exa',
  operation: 'search',
  required: [
    'providers.exa.api_key',
    'providers.exa.base_url',
    'providers.exa.search.limit',
    'providers.exa.search.search_type',
    'execution.timeout_seconds',
    'execution.retries',
  ],
};
export const exaRequestLimit = 30;
export const exaFetch: OperationDefinition = {
  provider: 'exa',
  operation: 'fetch',
  required: [
    'providers.exa.api_key',
    'providers.exa.base_url',
    'execution.timeout_seconds',
    'execution.retries',
  ],
};
export const exaOperations = [exaSearch, exaFetch];
export interface SearchOptions {
  limit?: string;
  searchType?: string;
  includeText?: boolean;
  includeHighlights?: boolean;
  publishedAfter?: string;
  category?: string;
  includeDomains?: string;
  excludeDomains?: string;
  timeout?: number;
}
export interface SearchRequest {
  url: string;
  apiKey: string;
  body: JsonObject;
  text: boolean;
  highlights: boolean;
  timeout: number;
  retries: number;
  secrets: string[];
}
export interface FetchOptions {
  maxLength?: string;
  includeHighlights?: boolean;
  highlightsQuery?: string;
  timeout?: number;
}
export interface FetchRequest extends SearchRequest {
  urls: string[];
}
export type SearchResult = JsonObject & {
  url: string;
  title?: string;
  published_date?: string;
  author?: string;
  text?: string;
  highlights?: string[];
  missing_content?: string[];
};
export type SearchData = JsonObject & { provider: 'exa'; results: SearchResult[] };

function invalid(key: MessageKey, option: string): never {
  throw new AppError('INVALID_ARGUMENT', key, { option });
}

export function publishedDate(input: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(
      input,
    );
  if (!match) return invalid('invalidDate', '--published-after');
  const [, year, month, day, hour, minute, second, , zone] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== input.slice(0, 10) ||
    Number(hour ?? 0) > 23 ||
    Number(minute ?? 0) > 59 ||
    Number(second ?? 0) > 59 ||
    (zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  )
    return invalid('invalidDate', '--published-after');
  return hour === undefined ? date.toISOString() : new Date(input).toISOString();
}

export function domainList(
  input: string,
  option: string,
  maximum = 1200,
  message: MessageKey = 'invalidDomains',
): string[] {
  const list = input.split(',');
  if (list.length > maximum) return invalid(message, option);
  for (const item of list) {
    const hostnamePath = item.startsWith('*.') ? item.slice(2) : item;
    if (!hostnamePath || /[\s:@?#*\\]/u.test(hostnamePath) || hostnamePath.startsWith('/'))
      return invalid(message, option);
    try {
      if (!new URL(`https://${hostnamePath}`).hostname) return invalid(message, option);
    } catch {
      return invalid(message, option);
    }
  }
  return list;
}

export function prepareSearch(
  query: string,
  options: SearchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): SearchRequest {
  if (!query.trim()) throw new AppError('INVALID_ARGUMENT', 'emptyQuery');
  const overrides: Record<string, ResolvedField> = {};
  for (const [path, input, option] of [
    ['providers.exa.search.limit', options.limit, '--limit'],
    ['providers.exa.search.search_type', options.searchType, '--search-type'],
  ] as const) {
    if (input === undefined) continue;
    const field = fieldAt(path);
    let value: JsonValue;
    try {
      value = parseInput(field, input);
    } catch (error) {
      if (error instanceof AppError) throw new AppError('INVALID_ARGUMENT', error.key, { option });
      throw error;
    }
    overrides[path] = { field, value, source: 'cli', problems: [] };
  }
  if (options.timeout !== undefined)
    overrides['execution.timeout_seconds'] = {
      field: fieldAt('execution.timeout_seconds'),
      value: options.timeout,
      source: 'cli',
      problems: [],
    };
  const filters: JsonObject = {};
  if (options.publishedAfter !== undefined)
    filters.startPublishedDate = publishedDate(options.publishedAfter);
  if (options.category !== undefined) {
    if (!options.category.trim()) return invalid('invalidCategory', '--category');
    if (
      ['company', 'people'].includes(options.category) &&
      (options.publishedAfter !== undefined || options.excludeDomains !== undefined)
    )
      return invalid('categoryConflict', '--category');
    if (options.category === 'people' && options.includeDomains !== undefined)
      return invalid('peopleDomainConflict', '--category');
    filters.category = options.category;
  }
  if (options.includeDomains !== undefined)
    filters.includeDomains = domainList(options.includeDomains, '--include-domains');
  if (options.excludeDomains !== undefined)
    filters.excludeDomains = domainList(options.excludeDomains, '--exclude-domains');
  const settings = operationConfig(values, env, language, exaSearch, overrides);
  const value = (path: string) => settings[path].value!;
  const includeText = options.includeText ?? false;
  const highlights = options.includeHighlights ?? false;
  return {
    url: `${(value('providers.exa.base_url') as string).replace(/\/+$/, '')}/search`,
    apiKey: value('providers.exa.api_key') as string,
    secrets: configuredSecrets(values, env),
    timeout: value('execution.timeout_seconds') as number,
    retries: value('execution.retries') as number,
    text: includeText,
    highlights,
    body: {
      query,
      numResults: value('providers.exa.search.limit'),
      type: value('providers.exa.search.search_type'),
      contents: { text: includeText, highlights },
      ...filters,
    },
  };
}

export function prepareFetch(
  urls: string[],
  options: FetchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): FetchRequest {
  if (!urls.length || urls.length > 100) return invalid('exaUrlCount', 'URL');
  for (const url of urls) {
    if (!validPageUrl(url)) return invalid('invalidPageUrl', 'URL');
    if ([...url].length > 2048) return invalid('exaUrlLength', 'URL');
  }
  if (options.highlightsQuery !== undefined && !options.highlightsQuery.trim())
    return invalid('emptyQuery', '--highlights-query');
  const overrides: Record<string, ResolvedField> = {};
  let maxLength: number | undefined;
  if (options.maxLength !== undefined) {
    try {
      maxLength = parseInput(
        { path: '--max-length', kind: 'integer', minimum: 1, maximum: 1000000 },
        options.maxLength,
      ) as number;
    } catch (error) {
      if (error instanceof AppError) return invalid(error.key, '--max-length');
      throw error;
    }
  }
  if (options.timeout !== undefined)
    overrides['execution.timeout_seconds'] = {
      field: fieldAt('execution.timeout_seconds'),
      value: options.timeout,
      source: 'cli',
      problems: [],
    };
  const settings = operationConfig(values, env, language, exaFetch, overrides);
  const highlights = options.includeHighlights === true || options.highlightsQuery !== undefined;
  return {
    url: `${(settings['providers.exa.base_url'].value as string).replace(/\/+$/, '')}/contents`,
    apiKey: settings['providers.exa.api_key'].value as string,
    secrets: configuredSecrets(values, env),
    urls,
    text: true,
    highlights,
    timeout: settings['execution.timeout_seconds'].value as number,
    retries: settings['execution.retries'].value as number,
    body: {
      urls,
      text: maxLength === undefined ? true : { maxCharacters: maxLength },
      highlights:
        options.highlightsQuery === undefined ? highlights : { query: options.highlightsQuery },
      livecrawlTimeout: 10000,
    },
  };
}

function responseError(key: MessageKey = 'invalidResponse'): AppError {
  return new AppError('INVALID_RESPONSE', key, { provider: 'exa', http_status: 200 });
}

export function searchData(
  body: unknown,
  request: Pick<SearchRequest, 'text' | 'highlights'>,
): SearchData {
  if (!isObject(body) || !Array.isArray(body.results)) throw responseError('invalidResults');
  const results = body.results.map((item): SearchResult => {
    if (
      !isObject(item) ||
      typeof item.title !== 'string' ||
      typeof item.url !== 'string' ||
      !/^https?:\/\//.test(item.url) ||
      /\s/u.test(item.url)
    )
      throw responseError();
    try {
      if (!new URL(item.url).hostname) throw responseError();
    } catch {
      throw responseError();
    }
    const result: SearchResult = { ...(item.title ? { title: item.title } : {}), url: item.url };
    for (const [source, target] of [
      ['publishedDate', 'published_date'],
      ['author', 'author'],
    ] as const) {
      const value = item[source];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string') throw responseError();
      result[target] = value;
    }
    const missing: string[] = [];
    if (request.text) {
      if (item.text !== undefined && item.text !== null && typeof item.text !== 'string')
        throw responseError();
      if (typeof item.text === 'string' && item.text.trim()) result.text = item.text;
      else missing.push('text');
    }
    if (request.highlights) {
      const value = item.highlights;
      if (
        value !== undefined &&
        value !== null &&
        value !== '' &&
        (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
      )
        throw responseError();
      const highlights = Array.isArray(value)
        ? (value as string[]).filter((entry) => entry.trim())
        : [];
      if (highlights.length) result.highlights = highlights;
      else missing.push('highlights');
    }
    if (missing.length) result.missing_content = missing;
    return result;
  });
  return { provider: 'exa', results };
}

function httpError(
  status: number,
  tag?: string,
): { code: AppError['code']; key: MessageKey; retry: boolean } {
  if (
    status === 400 ||
    (status === 422 && (tag === 'INVALID_REQUEST_BODY' || tag === 'INVALID_REQUEST'))
  )
    return { code: 'INVALID_ARGUMENT', key: 'exaArgument', retry: false };
  if (status === 401) return { code: 'AUTHENTICATION_ERROR', key: 'exaAuth', retry: false };
  if (status === 402) return { code: 'QUOTA_EXCEEDED', key: 'exaQuota', retry: false };
  if (status === 403 && tag !== 'PROHIBITED_CONTENT' && tag !== 'CONTENT_FILTER_ERROR')
    return { code: 'ACCESS_DENIED', key: 'exaAccess', retry: false };
  if (status === 408 || status === 504)
    return { code: 'TIMEOUT', key: 'requestTimeout', retry: true };
  if (status === 429) return { code: 'RATE_LIMITED', key: 'exaRate', retry: true };
  return { code: 'UPSTREAM_ERROR', key: 'exaUpstream', retry: [500, 502, 503].includes(status) };
}

async function requestExa<T extends JsonObject>(
  request: SearchRequest,
  context: AttemptContext,
  language: Language,
  parse: (body: unknown) => Outcome<T>,
  transport: typeof fetch,
): Promise<AttemptResult<T>> {
  const safe = (value: string) => redactDiagnostics(value, request.secrets) as string;
  try {
    let response: Response;
    let bytes: ArrayBuffer;
    try {
      response = await transport(request.url, {
        method: 'POST',
        headers: {
          'x-api-key': request.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request.body),
        signal: context.signal,
        redirect: 'manual',
      });
      context.httpStatus = response.status;
      context.retryAllowed = response.status === 200 || httpError(response.status).retry;
      const id = response.headers.get('x-request-id');
      if (id) context.requestId = safe(id);
      bytes = await response.arrayBuffer();
    } catch (error) {
      if (context.signal.aborted) throw error;
      const mapped = transportError(error, context, 'exa', 'exaNetwork', safe);
      if (!mapped) throw error;
      context.retryAllowed = mapped.retry;
      return { outcome: failure(mapped.error, language), retry: mapped.retry };
    }
    let body: unknown;
    let invalidBody = false;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      invalidBody = true;
    }
    if (isObject(body) && typeof body.requestId === 'string' && body.requestId)
      context.requestId = safe(body.requestId);
    if (response.status === 200) {
      context.retryAllowed = false;
      if (invalidBody) throw responseError();
      const outcome = parse(body);
      if (outcome.result.error) {
        if (context.requestId)
          outcome.result.error.details = {
            ...outcome.result.error.details,
            request_id: context.requestId,
          };
        outcome.result.error = redactDiagnostics(
          outcome.result.error,
          request.secrets,
        ) as typeof outcome.result.error;
      }
      return { outcome, retry: false };
    }
    const details: JsonObject = { provider: 'exa', http_status: response.status };
    if (!isObject(body)) invalidBody = true;
    for (const [source, target] of [
      ['error', 'upstream_message'],
      ['tag', 'upstream_code'],
    ] as const) {
      const value = isObject(body) ? body[source] : undefined;
      if (value === undefined || value === '') continue;
      if (typeof value !== 'string') invalidBody = true;
      else details[target] = safe(value);
    }
    if (isObject(body) && body.requestId !== undefined && typeof body.requestId !== 'string')
      invalidBody = true;
    if (context.requestId) details.request_id = context.requestId;
    const mapped = httpError(
      response.status,
      isObject(body) && typeof body.tag === 'string' ? body.tag : undefined,
    );
    if (mapped.code === 'TIMEOUT') details.timeout_scope = 'request';
    if (invalidBody) details.reason = 'error_body_invalid';
    context.retryAllowed = mapped.retry;
    const outcome = failure<T>(new AppError(mapped.code, mapped.key, details), language);
    if (outcome.result.error) {
      if (details.upstream_message === outcome.result.error.message)
        delete details.upstream_message;
      if (invalidBody)
        outcome.result.error.message += `${language === 'zh' ? '；' : '; '}${text(language, 'errorBodyInvalid')}`;
    }
    return {
      outcome,
      retry: mapped.retry,
      retryAfter: response.headers.get('retry-after') ?? undefined,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    context.retryAllowed = false;
    const outcome = failure<T>(error, language);
    if (context.requestId && outcome.result.error)
      outcome.result.error.details = {
        ...outcome.result.error.details,
        request_id: context.requestId,
      };
    return { outcome, retry: false };
  }
}

export function requestSearch(
  request: SearchRequest,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<SearchData>> {
  return requestExa(
    request,
    context,
    language,
    (body) => success(searchData(body, request)),
    transport,
  );
}
export function requestFetch(
  request: FetchRequest,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<FetchData>> {
  return requestExa(
    request,
    context,
    language,
    (body) => contentsData(body, request, language),
    transport,
  );
}
