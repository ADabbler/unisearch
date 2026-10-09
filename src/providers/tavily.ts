import { fieldAt, isObject, parseInput } from '../config/fields.js';
import type { ResolvedField } from '../config/resolve.js';
import { operationConfig } from '../config/status.js';
import type { OperationDefinition } from '../config/status.js';
import { AppError, failure } from '../errors.js';
import type { AttemptContext, AttemptResult } from '../execution.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { success } from '../result.js';
import type { JsonObject, Outcome, PublicError } from '../result.js';
import { domainList } from './exa.js';
import { validPageUrl } from './firecrawl-response.js';
import { configuredSecrets, redactDiagnostics, transportError } from './transport.js';

const settings = {
  search: { limit: 'limit', searchDepth: 'search_depth' },
  extract: { extractDepth: 'extract_depth' },
  map: { limit: 'limit' },
} as const;
export type TavilyOperation = keyof typeof settings;
export const tavilyRequestLimits = { search: 30, extract: 60, map: 160 } as const;
export const tavilyOperations: OperationDefinition[] = Object.entries(settings).map(
  ([operation, fields]) => ({
    provider: 'tavily',
    operation,
    required: [
      'providers.tavily.api_key',
      'providers.tavily.base_url',
      'execution.timeout_seconds',
      'execution.retries',
      ...Object.values(fields).map((field) => `providers.tavily.${operation}.${field}`),
    ],
  }),
);

interface CommonOptions {
  timeout?: number;
}
export interface TavilySearchOptions extends CommonOptions {
  limit?: string;
  searchDepth?: string;
  topic?: string;
  timeRange?: string;
  startDate?: string;
  endDate?: string;
  includeDomains?: string;
  excludeDomains?: string;
  includeText?: boolean;
}
export interface ExtractOptions extends CommonOptions {
  extractDepth?: string;
  query?: string;
  chunksPerSource?: string;
}
export interface MapOptions extends CommonOptions {
  limit?: string;
  maxDepth?: string;
  maxBreadth?: string;
  allowExternal?: boolean;
  instructions?: string;
  selectPath?: string[];
  excludePath?: string[];
  selectDomain?: string[];
  excludeDomain?: string[];
}
interface TavilyRequest {
  operation: TavilyOperation;
  url: string;
  apiKey: string;
  secrets: string[];
  body: JsonObject;
  timeout: number;
  retries: number;
}
export interface TavilySearchRequest extends TavilyRequest {
  operation: 'search';
  includeText: boolean;
}
export interface ExtractRequest extends TavilyRequest {
  operation: 'extract';
  urls: string[];
  contentType: 'page' | 'snippets';
}
export interface MapRequest extends TavilyRequest {
  operation: 'map';
}
export type TavilySearchResult = JsonObject & {
  url: string;
  title?: string;
  content?: string;
  published_date?: string;
  score?: number;
  text?: string;
  missing_content?: string[];
};
export type TavilySearchData = JsonObject & { provider: 'tavily'; results: TavilySearchResult[] };
export type ExtractData = JsonObject & {
  provider: 'tavily';
  content_type: 'page' | 'snippets';
  results: { url: string; text: string }[];
};
export type MapData = JsonObject & { provider: 'tavily'; results: string[] };

function invalid(key: MessageKey, option: string): never {
  throw new AppError('INVALID_ARGUMENT', key, { option });
}
function nonempty(value: string, option: string): string {
  if (!value.trim()) invalid('tavilyNonempty', option);
  return value;
}
function inputUrl(value: string): void {
  if (!validPageUrl(value)) invalid('tavilyUrl', 'URL');
}
function date(value: string, option: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    invalid('tavilyDate', option);
  return value;
}

function prepare(
  operation: TavilyOperation,
  options: CommonOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): TavilyRequest {
  const overrides: Record<string, ResolvedField> = {};
  const entries = options as Record<string, unknown>;
  for (const [key, leaf] of Object.entries(settings[operation])) {
    const input = entries[key];
    if (input === undefined) continue;
    const path = `providers.tavily.${operation}.${leaf}`;
    const field = fieldAt(path);
    try {
      overrides[path] = {
        field,
        value: parseInput(field, String(input)),
        source: 'cli',
        problems: [],
      };
    } catch (error) {
      if (error instanceof AppError)
        throw new AppError('INVALID_ARGUMENT', error.key, {
          option: `--${key.replace(/[A-Z]/g, (v) => `-${v.toLowerCase()}`)}`,
        });
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
  const config = operationConfig(
    values,
    env,
    language,
    tavilyOperations.find((item) => item.operation === operation)!,
    overrides,
  );
  const value = (path: string) => config[path].value!;
  return {
    operation,
    url: `${(value('providers.tavily.base_url') as string).replace(/\/+$/, '')}/${operation}`,
    apiKey: value('providers.tavily.api_key') as string,
    secrets: configuredSecrets(values, env),
    timeout: value('execution.timeout_seconds') as number,
    retries: value('execution.retries') as number,
    body: Object.fromEntries(
      Object.values(settings[operation]).map((leaf) => [
        leaf,
        value(`providers.tavily.${operation}.${leaf}`),
      ]),
    ),
  };
}

export function prepareTavilySearch(
  query: string,
  options: TavilySearchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): TavilySearchRequest {
  if (!query.trim()) throw new AppError('INVALID_ARGUMENT', 'emptyQuery');
  const filters: JsonObject = {};
  if (options.timeRange !== undefined) {
    if (!['day', 'week', 'month', 'year'].includes(options.timeRange))
      invalid('tavilyTime', '--time-range');
    filters.time_range = options.timeRange;
  }
  if (options.startDate !== undefined) filters.start_date = date(options.startDate, '--start-date');
  if (options.endDate !== undefined) filters.end_date = date(options.endDate, '--end-date');
  if (
    (options.timeRange !== undefined &&
      (options.startDate !== undefined || options.endDate !== undefined)) ||
    (options.startDate !== undefined &&
      options.endDate !== undefined &&
      options.startDate > options.endDate)
  )
    invalid('tavilyDateConflict', '--time-range/--start-date/--end-date');
  if (options.includeDomains !== undefined) {
    filters.include_domains = domainList(
      options.includeDomains,
      '--include-domains',
      300,
      'tavilyIncludeDomains',
    );
    filters.include_domains_mode = 'restrict';
  }
  if (options.excludeDomains !== undefined)
    filters.exclude_domains = domainList(
      options.excludeDomains,
      '--exclude-domains',
      150,
      'tavilyExcludeDomains',
    );
  const topic = options.topic ?? 'general';
  if (!['general', 'news', 'finance'].includes(topic)) invalid('tavilyTopic', '--topic');
  const request = prepare('search', options, values, env, language);
  const { limit, ...body } = request.body;
  return {
    ...request,
    operation: 'search',
    includeText: options.includeText ?? false,
    body: {
      query,
      topic,
      ...body,
      max_results: limit,
      ...filters,
      include_raw_content: options.includeText ? 'markdown' : false,
      include_answer: false,
      auto_parameters: false,
      include_images: false,
      include_favicon: false,
      include_usage: false,
    },
  };
}
export function prepareExtract(
  urls: string[],
  options: ExtractOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): ExtractRequest {
  if (!urls.length || urls.length > 20) invalid('tavilyUrls', 'URL');
  urls.forEach(inputUrl);
  const query = options.query === undefined ? undefined : nonempty(options.query, '--query');
  if (
    options.chunksPerSource !== undefined &&
    (query === undefined || !/^[1-5]$/.test(options.chunksPerSource))
  )
    invalid('tavilyChunks', '--chunks-per-source');
  const request = prepare('extract', options, values, env, language);
  return {
    ...request,
    operation: 'extract',
    urls: [...urls],
    contentType: query === undefined ? 'page' : 'snippets',
    body: {
      ...request.body,
      urls: [...urls],
      format: 'markdown',
      timeout: request.body.extract_depth === 'advanced' ? 30 : 10,
      include_images: false,
      include_favicon: false,
      include_usage: false,
      ...(query === undefined
        ? {}
        : { query, chunks_per_source: Number(options.chunksPerSource ?? 3) }),
    },
  };
}
export function prepareMap(
  url: string,
  options: MapOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): MapRequest {
  inputUrl(url);
  const filters: JsonObject = {};
  for (const [key, name, maximum, defaultValue, invalidMessage] of [
    ['maxDepth', 'max_depth', 5, 1, 'tavilyMaxDepth'],
    ['maxBreadth', 'max_breadth', 500, 20, 'tavilyMaxBreadth'],
  ] as const) {
    const input = options[key];
    const option = `--${name.replaceAll('_', '-')}`;
    try {
      filters[name] =
        input === undefined
          ? defaultValue
          : parseInput(
              { path: option, kind: 'integer', minimum: 1, maximum, invalidMessage },
              input,
            );
    } catch (error) {
      if (error instanceof AppError) invalid(error.key, option);
      throw error;
    }
  }
  filters.allow_external = options.allowExternal ?? false;
  if (options.instructions !== undefined)
    filters.instructions = nonempty(options.instructions, '--instructions');
  for (const [key, target, flag] of [
    ['selectPath', 'select_paths', '--select-path'],
    ['excludePath', 'exclude_paths', '--exclude-path'],
    ['selectDomain', 'select_domains', '--select-domain'],
    ['excludeDomain', 'exclude_domains', '--exclude-domain'],
  ] as const)
    if (options[key] !== undefined) filters[target] = options[key].map((v) => nonempty(v, flag));
  const request = prepare('map', options, values, env, language);
  return {
    ...request,
    operation: 'map',
    body: { ...request.body, url, ...filters, timeout: 150, include_usage: false },
  };
}

function responseError(key: MessageKey = 'tavilyInvalidResponse'): AppError {
  return new AppError('INVALID_RESPONSE', key, { provider: 'tavily', http_status: 200 });
}
function resultsArray(body: unknown): unknown[] {
  if (!isObject(body) || !Array.isArray(body.results)) throw responseError('tavilyInvalidResults');
  return body.results;
}
export function tavilySearchData(body: unknown, includeText: boolean): TavilySearchData {
  const results = resultsArray(body).map((item): TavilySearchResult => {
    if (!isObject(item) || !validPageUrl(item.url)) throw responseError();
    const result: TavilySearchResult = { url: item.url };
    for (const key of ['title', 'content', 'published_date'] as const) {
      const value = item[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string') throw responseError();
      if (key !== 'content' || value.trim()) result[key] = value;
    }
    if (item.score !== undefined && item.score !== null) {
      if (typeof item.score !== 'number' || !Number.isFinite(item.score)) throw responseError();
      result.score = item.score;
    }
    if (includeText) {
      if (
        item.raw_content !== undefined &&
        item.raw_content !== null &&
        typeof item.raw_content !== 'string'
      )
        throw responseError();
      if (typeof item.raw_content === 'string' && item.raw_content.trim())
        result.text = item.raw_content;
      else result.missing_content = ['text'];
    }
    return result;
  });
  return { provider: 'tavily', results };
}
export function mapData(body: unknown): MapData {
  const results = resultsArray(body);
  if (!results.every(validPageUrl)) throw responseError();
  return { provider: 'tavily', results };
}
type UrlFailure = PublicError & { url: string };
function urlFailure(
  url: string,
  key: MessageKey,
  language: Language,
  reason?: string,
  upstream?: string,
): UrlFailure {
  const code =
    key === 'tavilyRawInvalid' || key === 'tavilyFailureInvalid'
      ? 'INVALID_RESPONSE'
      : 'UPSTREAM_ERROR';
  const message = text(language, key);
  const details = {
    ...(reason ? { reason } : {}),
    ...(upstream && upstream !== message ? { upstream_message: upstream } : {}),
  };
  return { url, code, message, ...(Object.keys(details).length ? { details } : {}) };
}
export function extractResult(
  body: unknown,
  request: ExtractRequest,
  language: Language,
): Outcome<ExtractData> {
  const entries = resultsArray(body);
  if (!isObject(body) || !Array.isArray(body.failed_results)) throw responseError();
  const results: ExtractData['results'] = [];
  const failures: UrlFailure[] = [];
  const safe = (value: string) => redactDiagnostics(value, request.secrets) as string;
  for (const item of entries) {
    if (!isObject(item) || !validPageUrl(item.url)) throw responseError();
    if (typeof item.raw_content !== 'string')
      failures.push(urlFailure(safe(item.url), 'tavilyRawInvalid', language));
    else if (!item.raw_content.trim())
      failures.push(
        urlFailure(
          safe(item.url),
          request.contentType === 'page' ? 'tavilyEmpty' : 'tavilyEmptySnippets',
          language,
          'empty_content',
        ),
      );
    else results.push({ url: item.url, text: item.raw_content });
  }
  for (const item of body.failed_results) {
    if (!isObject(item) || !validPageUrl(item.url)) throw responseError();
    failures.push(
      typeof item.error === 'string' && item.error.trim()
        ? urlFailure(
            safe(item.url),
            'tavilyExtractFailed',
            language,
            'extraction_failed',
            safe(item.error),
          )
        : urlFailure(safe(item.url), 'tavilyFailureInvalid', language),
    );
  }
  const data: ExtractData = { provider: 'tavily', content_type: request.contentType, results };
  const mismatch = entries.length + body.failed_results.length !== request.urls.length;
  if (!mismatch && !failures.length) return success(data);
  const details = {
    ...(results.length ? {} : { provider: 'tavily' }),
    ...(failures.length ? { failures } : {}),
    ...(mismatch ? { reason: 'result_count_mismatch' } : {}),
  };
  if (mismatch) {
    const outcome = failure<ExtractData>(
      new AppError('INVALID_RESPONSE', 'tavilyCount', details),
      language,
    );
    if (results.length) outcome.result.data = data;
    return outcome;
  }
  if (results.length)
    return {
      result: {
        status: 'partial',
        data,
        error: { code: 'PARTIAL_FAILURE', message: text(language, 'tavilyPartial'), details },
      },
      exitCode: 6,
    };
  if (request.urls.length === 1) {
    const { url, details: own, ...error } = failures[0];
    return {
      result: {
        status: 'error',
        error: { ...error, details: { provider: 'tavily', url, ...own } },
      },
      exitCode: 4,
    };
  }
  return failure(
    new AppError(
      failures.every((item) => item.code === 'INVALID_RESPONSE')
        ? 'INVALID_RESPONSE'
        : 'UPSTREAM_ERROR',
      'tavilyExtractFailed',
      details,
    ),
    language,
  );
}

export function httpError(status: number): {
  code: AppError['code'];
  key: MessageKey;
  retry: boolean;
} {
  if (status === 400 || status === 422)
    return { code: 'INVALID_ARGUMENT', key: 'tavilyArgument', retry: false };
  if (status === 401) return { code: 'AUTHENTICATION_ERROR', key: 'tavilyAuth', retry: false };
  if (status === 403) return { code: 'ACCESS_DENIED', key: 'tavilyAccess', retry: false };
  if (status === 432 || status === 433)
    return { code: 'QUOTA_EXCEEDED', key: 'tavilyQuota', retry: false };
  if (status === 408 || status === 504)
    return { code: 'TIMEOUT', key: 'requestTimeout', retry: true };
  if (status === 429) return { code: 'RATE_LIMITED', key: 'tavilyRate', retry: true };
  return { code: 'UPSTREAM_ERROR', key: 'tavilyUpstream', retry: [500, 502, 503].includes(status) };
}
async function requestJson<T extends JsonObject>(
  request: TavilyRequest,
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
          Authorization: `Bearer ${request.apiKey}`,
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
      const mapped = transportError(error, context, 'tavily', 'tavilyNetwork', safe);
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
    if (
      isObject(body) &&
      body.request_id !== undefined &&
      body.request_id !== null &&
      body.request_id !== ''
    ) {
      if (typeof body.request_id !== 'string') invalidBody = true;
      else context.requestId = safe(body.request_id);
    }
    if (response.status === 200) {
      if (invalidBody) throw responseError();
      const outcome = parse(body);
      if (outcome.result.error) context.retryAllowed = false;
      if (context.requestId && outcome.result.error)
        outcome.result.error.details = {
          ...outcome.result.error.details,
          request_id: context.requestId,
        };
      return { outcome, retry: false };
    }
    const details: JsonObject = { provider: 'tavily', http_status: response.status };
    const detail = isObject(body) ? body.detail : undefined;
    if (isObject(detail) && typeof detail.error === 'string' && detail.error.trim())
      details.upstream_message = safe(detail.error);
    else if (response.status === 422 && Array.isArray(detail) && detail.length) {
      const messages: string[] = [];
      for (const item of detail) {
        if (
          !isObject(item) ||
          !Array.isArray(item.loc) ||
          !item.loc.every((part) => typeof part === 'string' || typeof part === 'number') ||
          typeof item.msg !== 'string' ||
          typeof item.type !== 'string'
        ) {
          invalidBody = true;
          continue;
        }
        messages.push(`${item.loc.join('.')}: ${item.msg} (${item.type})`);
      }
      if (messages.length) details.upstream_message = safe(messages.join('\n'));
    } else invalidBody = true;
    if (response.status === 400 && isObject(detail) && Array.isArray(detail.failed_results)) {
      const failures: UrlFailure[] = [];
      for (const item of detail.failed_results) {
        if (
          isObject(item) &&
          validPageUrl(item.url) &&
          typeof item.error === 'string' &&
          item.error.trim()
        )
          failures.push(
            urlFailure(
              safe(item.url),
              'tavilyExtractFailed',
              language,
              'extraction_failed',
              safe(item.error),
            ),
          );
        else invalidBody = true;
      }
      if (failures.length) details.failures = failures;
    }
    const mapped = httpError(response.status);
    if (
      request.operation === 'map' &&
      response.status === 403 &&
      isObject(detail) &&
      detail.error === '[403] URL is not supported'
    ) {
      mapped.code = 'UPSTREAM_ERROR';
      mapped.key = 'tavilyUpstream';
      details.reason = 'url_unsupported';
    }
    if (mapped.code === 'TIMEOUT') details.timeout_scope = 'request';
    if (context.requestId) details.request_id = context.requestId;
    if (invalidBody) details.reason = 'error_body_invalid';
    const outcome = failure<T>(new AppError(mapped.code, mapped.key, details), language);
    if (outcome.result.error) {
      if (details.upstream_message === outcome.result.error.message)
        delete details.upstream_message;
      if (invalidBody)
        outcome.result.error.message += `${language === 'zh' ? '' : ' '}${text(language, 'errorBodyInvalid')}`;
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
export function requestTavilySearch(
  request: TavilySearchRequest,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<TavilySearchData>> {
  return requestJson(
    request,
    context,
    language,
    (body) => success(tavilySearchData(body, request.includeText)),
    transport,
  );
}
export function requestExtract(
  request: ExtractRequest,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<ExtractData>> {
  return requestJson(
    request,
    context,
    language,
    (body) => extractResult(body, request, language),
    transport,
  );
}
export function requestMap(
  request: MapRequest,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<MapData>> {
  return requestJson(request, context, language, (body) => success(mapData(body)), transport);
}
