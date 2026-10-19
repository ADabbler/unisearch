import { fieldAt, isObject, parseInput } from '../config/fields.js';
import type { ResolvedField } from '../config/resolve.js';
import { operationConfig } from '../config/status.js';
import type { OperationDefinition } from '../config/status.js';
import { AppError, failure, normalizeDetails } from '../errors.js';
import type { AttemptContext, AttemptResult } from '../execution.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { success } from '../result.js';
import type { JsonObject, JsonValue } from '../result.js';
import { mapData, scrapeData, searchData, validPageUrl } from './firecrawl-response.js';
import type { MapData, ScrapeData, SearchData } from './firecrawl-response.js';
import { configuredSecrets, redactDiagnostics, transportError } from './transport.js';

export const requestLimits = { search: 60, scrape: 90, map: 60 } as const;
type Operation = keyof typeof requestLimits;
const operationFields = {
  search: ['limit'],
  scrape: [],
  map: ['limit', 'sitemap'],
} as const;
export const operations: OperationDefinition[] = (['search', 'scrape', 'map'] as const).map(
  (operation) => ({
    provider: 'firecrawl',
    operation,
    required: [
      'providers.firecrawl.api_key',
      'providers.firecrawl.base_url',
      ...operationFields[operation].map((field) => `providers.firecrawl.${operation}.${field}`),
      'execution.timeout_seconds',
      'execution.retries',
    ],
  }),
);

interface RequestBase {
  operation: Operation;
  url: string;
  apiKey: string;
  secrets: string[];
  body: JsonObject;
  timeout: number;
  retries: number;
}
export interface SearchRequest extends RequestBase {
  includeText: boolean;
  limit: number;
}
export interface ScrapeRequest extends RequestBase {
  target: string;
}
export interface MapRequest extends RequestBase {
  limit: number;
}
export interface SearchOptions {
  limit?: string;
  includeText?: boolean;
  categories?: string;
  tbs?: string;
  location?: string;
  country?: string;
  timeout?: number;
}
export interface ScrapeOptions {
  onlyMainContent?: boolean;
  maxAge?: string;
  waitFor?: string;
  includeTag?: string[];
  excludeTag?: string[];
  timeout?: number;
}
export interface MapOptions {
  limit?: string;
  search?: string;
  sitemap?: string;
  includeSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
  ignoreCache?: boolean;
  timeout?: number;
}
type Override = readonly [field: string, input: string | undefined, option: string];
function invalid(key: MessageKey, option: string): never {
  throw new AppError('INVALID_ARGUMENT', key, { option });
}
function nonempty(value: string, option: string): string {
  if (!value.trim()) return invalid('nonemptyOption', option);
  return value;
}
function targetUrl(value: string): string {
  if (!validPageUrl(value)) return invalid('invalidPageUrl', 'URL');
  return value;
}
function resolveSettings(
  operation: Operation,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
  timeout: number | undefined,
  inputs: Override[],
) {
  const overrides: Record<string, ResolvedField> = {};
  for (const [name, input, option] of inputs) {
    if (input === undefined) continue;
    const path = `providers.firecrawl.${operation}.${name}`;
    const field = fieldAt(path);
    try {
      overrides[path] = {
        field,
        value: parseInput(field, input),
        source: 'cli',
        problems: [],
      };
    } catch (error) {
      if (error instanceof AppError) return invalid(error.key, option);
      throw error;
    }
  }
  if (timeout !== undefined)
    overrides['execution.timeout_seconds'] = {
      field: fieldAt('execution.timeout_seconds'),
      value: timeout,
      source: 'cli',
      problems: [],
    };
  const definition = operations.find((item) => item.operation === operation)!;
  const config = operationConfig(values, env, language, definition, overrides);
  const connection = {
    operation,
    url: `${(config['providers.firecrawl.base_url'].value as string).replace(/\/+$/, '')}/${operation}`,
    apiKey: config['providers.firecrawl.api_key'].value as string,
    secrets: configuredSecrets(values, env),
    timeout: config['execution.timeout_seconds'].value as number,
    retries: config['execution.retries'].value as number,
  };
  const value = (name: string) => config[`providers.firecrawl.${operation}.${name}`].value!;
  return { connection, value };
}

export function prepareSearch(
  query: string,
  options: SearchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): SearchRequest {
  if (!query.trim()) throw new AppError('INVALID_ARGUMENT', 'emptyQuery');
  if ([...query].length > 500) return invalid('firecrawlQuery', 'QUERY');
  const filters: JsonObject = {};
  if (options.categories !== undefined) {
    if (options.categories !== 'developer' && options.categories !== 'pdf')
      return invalid('firecrawlCategory', '--categories');
    filters.categories = [options.categories];
  }
  if (options.tbs !== undefined) filters.tbs = nonempty(options.tbs, '--tbs');
  if (options.location !== undefined) filters.location = nonempty(options.location, '--location');
  if (options.country !== undefined) {
    if (!/^[A-Z]{2}$/.test(options.country)) return invalid('firecrawlCountry', '--country');
    filters.country = options.country;
  }
  const { connection, value } = resolveSettings('search', values, env, language, options.timeout, [
    ['limit', options.limit, '--limit'],
  ]);
  const includeText = options.includeText ?? false;
  const limit = value('limit') as number;
  if (
    options.categories === 'developer' &&
    (includeText ||
      options.tbs !== undefined ||
      options.location !== undefined ||
      options.country !== undefined)
  )
    return invalid('developerConflict', '--categories');
  const body: JsonObject = {
    query,
    limit,
    sources: ['web'],
    timeout: 60000,
    ignoreInvalidURLs: false,
    highlights: false,
    ...filters,
  };
  if (includeText)
    body.scrapeOptions = {
      formats: ['markdown'],
      onlyMainContent: true,
      waitFor: 0,
      maxAge: 172800000,
      timeout: 60000,
    };
  return { ...connection, includeText, limit, body };
}

export function prepareScrape(
  url: string,
  options: ScrapeOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): ScrapeRequest {
  const target = targetUrl(url);
  let waitFor = 0;
  if (options.waitFor !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(options.waitFor) || Number(options.waitFor) > 30)
      return invalid('invalidWaitFor', '--wait-for');
    waitFor = Number(options.waitFor) * 1000;
  }
  const tags: JsonObject = {};
  for (const [input, field, option] of [
    [options.includeTag, 'includeTags', '--include-tag'],
    [options.excludeTag, 'excludeTags', '--exclude-tag'],
  ] as const) {
    if (input !== undefined) tags[field] = input.map((value) => nonempty(value, option));
  }
  let maxAge = 172800;
  if (options.maxAge !== undefined) {
    try {
      maxAge = parseInput(
        {
          path: '--max-age',
          kind: 'integer',
          minimum: 0,
          maximum: Math.floor(Number.MAX_SAFE_INTEGER / 1000),
          invalidMessage: 'invalidMaxAge',
        },
        options.maxAge,
      ) as number;
    } catch (error) {
      if (error instanceof AppError) invalid(error.key, '--max-age');
      throw error;
    }
  }
  const { connection } = resolveSettings('scrape', values, env, language, options.timeout, []);
  return {
    ...connection,
    target,
    body: {
      url: target,
      formats: ['markdown'],
      onlyMainContent: options.onlyMainContent ?? true,
      maxAge: maxAge * 1000,
      waitFor,
      ...tags,
      timeout: 60000,
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
  const target = targetUrl(url);
  const search = options.search === undefined ? undefined : nonempty(options.search, '--search');
  const { connection, value } = resolveSettings('map', values, env, language, options.timeout, [
    ['limit', options.limit, '--limit'],
    ['sitemap', options.sitemap, '--sitemap'],
  ]);
  if (value('sitemap') === 'only' && search !== undefined)
    return invalid('sitemapConflict', '--search');
  const limit = value('limit') as number;
  return {
    ...connection,
    limit,
    body: {
      url: target,
      limit,
      ...(search === undefined ? {} : { search }),
      sitemap: value('sitemap'),
      includeSubdomains: options.includeSubdomains ?? false,
      ignoreQueryParameters: options.ignoreQueryParameters ?? true,
      ignoreCache: options.ignoreCache ?? false,
      timeout: 60000,
    },
  };
}

const pageErrors = new Set([
  'SCRAPE_ALL_ENGINES_FAILED',
  'SCRAPE_SSL_ERROR',
  'SCRAPE_SITE_ERROR',
  'SCRAPE_DNS_RESOLUTION_ERROR',
  'SCRAPE_UNSUPPORTED_FILE_ERROR',
]);
export function classify(
  status: number,
  operation: Operation | 'credit_usage',
  code?: string,
  message?: string,
): { code: AppError['code']; key: MessageKey; retry: boolean } {
  if (status === 401) return { code: 'AUTHENTICATION_ERROR', key: 'firecrawlAuth', retry: false };
  if (status === 402 || /\b(?:Insufficient credits|Payment Required)\b/i.test(message ?? ''))
    return { code: 'QUOTA_EXCEEDED', key: 'firecrawlQuota', retry: false };
  if (status === 403) return { code: 'ACCESS_DENIED', key: 'firecrawlAccess', retry: false };
  if (operation === 'scrape' && code !== undefined && pageErrors.has(code))
    return { code: 'CONTENT_UNAVAILABLE', key: 'firecrawlPage', retry: false };
  if (status === 408 || status === 504 || code === 'SCRAPE_TIMEOUT' || code === 'MAP_TIMEOUT')
    return { code: 'TIMEOUT', key: 'requestTimeout', retry: true };
  if (
    status === 400 ||
    status === 413 ||
    (status === 422 &&
      ['INVALID_REQUEST', 'INVALID_REQUEST_BODY', 'VALIDATION_ERROR', 'BAD_REQUEST'].includes(
        code ?? '',
      ))
  )
    return { code: 'INVALID_ARGUMENT', key: 'firecrawlArgument', retry: false };
  if (status === 429) return { code: 'RATE_LIMITED', key: 'firecrawlRate', retry: true };
  return {
    code: 'UPSTREAM_ERROR',
    key: 'firecrawlUpstream',
    retry: code !== 'SCRAPE_JOB_CANCELLED' && [500, 502, 503].includes(status),
  };
}

async function request<T extends JsonValue>(
  prepared: RequestBase,
  context: AttemptContext,
  language: Language,
  normalize: (body: unknown, safe: (value: string) => string) => T,
  transport: typeof fetch,
): Promise<AttemptResult<T>> {
  const safe = (value: string) => redactDiagnostics(value, prepared.secrets) as string;
  const details = (): JsonObject => ({
    provider: 'firecrawl',
    operation: prepared.operation,
    ...(context.httpStatus === undefined ? {} : { http_status: context.httpStatus }),
    ...(context.requestId ? { request_id: context.requestId } : {}),
  });
  try {
    let response: Response;
    let bytes: ArrayBuffer;
    try {
      response = await transport(prepared.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${prepared.apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(prepared.body),
        signal: context.signal,
        redirect: 'manual',
      });
      context.httpStatus = response.status;
      context.retryAllowed =
        response.status === 200 || classify(response.status, prepared.operation).retry;
      const id = response.headers.get('x-request-id');
      if (id) context.requestId = safe(id);
      bytes = await response.arrayBuffer();
    } catch (error) {
      if (context.signal.aborted) throw error;
      const mapped = transportError(error, context, 'firecrawl', 'firecrawlNetwork', safe);
      if (!mapped) throw error;
      context.retryAllowed = mapped.retry;
      mapped.error.details!.operation = prepared.operation;
      return { outcome: failure(mapped.error, language), retry: mapped.retry };
    }
    let body: unknown;
    let invalidBody = false;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      invalidBody = true;
    }
    const responseBody = isObject(body) ? body : undefined;
    if (response.status === 200 && responseBody?.success !== false)
      return { outcome: success(normalize(body, safe)), retry: false };
    const info = details();
    if (!responseBody) invalidBody = true;
    for (const [source, target] of [
      ['error', 'upstream_message'],
      ['code', 'upstream_code'],
    ] as const) {
      const value = responseBody?.[source];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string') invalidBody = true;
      else info[target] = safe(value);
    }
    const mapped = classify(
      response.status,
      prepared.operation,
      typeof responseBody?.code === 'string' ? responseBody.code : undefined,
      typeof responseBody?.error === 'string' ? responseBody.error : undefined,
    );
    context.retryAllowed = mapped.retry;
    if (mapped.code === 'TIMEOUT') info.timeout_scope = 'request';
    if (mapped.code === 'CONTENT_UNAVAILABLE') info.reason = 'page_error';
    if (invalidBody) info.reason = 'error_body_invalid';
    const outcome = failure<T>(new AppError(mapped.code, mapped.key, info), language);
    if (outcome.result.error) {
      if (info.upstream_message === outcome.result.error.message) delete info.upstream_message;
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
    if (outcome.result.error)
      outcome.result.error.details = normalizeDetails({
        ...outcome.result.error.details,
        ...details(),
      });
    return { outcome, retry: false };
  }
}

export function requestSearch(
  prepared: SearchRequest,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<SearchData>> {
  return request(
    prepared,
    context,
    language,
    (body, safe) => searchData(body, prepared, safe),
    transport,
  );
}
export function requestScrape(
  prepared: ScrapeRequest,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<ScrapeData>> {
  return request(
    prepared,
    context,
    language,
    (body, safe) => scrapeData(body, prepared.target, safe),
    transport,
  );
}
export function requestMap(
  prepared: MapRequest,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<MapData>> {
  return request(
    prepared,
    context,
    language,
    (body, safe) => mapData(body, prepared.limit, safe),
    transport,
  );
}
