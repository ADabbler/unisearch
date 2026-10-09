import { fieldAt, isObject, parseInput, token } from '../config/fields.js';
import type { ResolvedField } from '../config/resolve.js';
import { operationConfig } from '../config/status.js';
import type { OperationDefinition } from '../config/status.js';
import { AppError, failure } from '../errors.js';
import type { AttemptContext, AttemptResult } from '../execution.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import type { JsonObject, PublicError } from '../result.js';
import { domainList, publishedDate } from './exa.js';
import { validPageUrl } from './firecrawl-response.js';
import { fetchData, searchData } from './tinyfish-response.js';
import type { FetchData, SearchData } from './tinyfish-response.js';
import { configuredSecrets, redactDiagnostics, transportError } from './transport.js';

export const requestLimits = { search: 30, fetch: 150 };
export const operations: OperationDefinition[] = ['search', 'fetch'].map((operation) => ({
  provider: 'tinyfish',
  operation,
  required: [
    'providers.tinyfish.api_key',
    `providers.tinyfish.${operation}_url`,
    'execution.timeout_seconds',
    'execution.retries',
  ],
}));

interface Options {
  timeout?: number;
  purpose?: string;
}
export interface SearchOptions extends Options {
  location?: string;
  language?: string;
  includeDomains?: string;
  excludeDomains?: string;
  recencyMinutes?: string;
  afterDate?: string;
  beforeDate?: string;
  searchType?: string;
  pubYearMin?: string;
  pubYearMax?: string;
  page?: string;
}
export interface FetchOptions extends Options {
  ttl?: string;
  perUrlTimeoutMs?: string;
  targetSelector?: string[];
  removeSelector?: string[];
  includeLinks?: boolean;
  includeImageLinks?: boolean;
  includeMetadata?: boolean;
}
interface Connection {
  url: string;
  apiKey: string;
  secrets: string[];
  timeout: number;
  retries: number;
}
export interface SearchRequest extends Connection {
  operation: 'search';
}
export interface FetchRequest extends Connection {
  operation: 'fetch';
  urls: string[];
  body: JsonObject;
}
type Request = SearchRequest | FetchRequest;

function invalid(key: MessageKey, option: string): never {
  throw new AppError('INVALID_ARGUMENT', key, { option });
}
function content(value: string, option: string, maximum = 2000): string {
  if (!value.trim() || [...value].length > maximum)
    invalid(maximum === 1000 ? 'tinyfishSelector' : 'tinyfishText', option);
  return value;
}
function integer(value: string, option: string, minimum: number, maximum: number): number {
  try {
    return parseInput({ path: option, kind: 'integer', minimum, maximum }, value) as number;
  } catch (error) {
    if (error instanceof AppError) invalid('tinyfishRange', option);
    throw error;
  }
}
function connection(
  operation: Request['operation'],
  options: Options,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
) {
  const overrides: Record<string, ResolvedField> = {};
  if (options.timeout !== undefined) {
    const field = fieldAt('execution.timeout_seconds');
    overrides[field.path] = {
      field,
      value: options.timeout,
      source: 'cli',
      problems: [],
    };
  }
  const resolved = operationConfig(
    values,
    env,
    language,
    operations.find((item) => item.operation === operation)!,
    overrides,
  );
  const base = resolved[`providers.tinyfish.${operation}_url`].value as string;
  return {
    url: `${base.replace(/\/+$/, '')}/`,
    apiKey: resolved['providers.tinyfish.api_key'].value as string,
    secrets: configuredSecrets(values, env),
    timeout: resolved['execution.timeout_seconds'].value as number,
    retries: resolved['execution.retries'].value as number,
  };
}

export function prepareSearch(
  query: string,
  options: SearchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): SearchRequest {
  content(query, 'QUERY');
  const parameters = new URLSearchParams({ query });
  if (options.purpose !== undefined)
    parameters.set('purpose', content(options.purpose, '--purpose'));
  const type = options.searchType ?? 'web';
  if (!['web', 'news', 'research_paper'].includes(type))
    invalid('tinyfishSearchType', '--search-type');
  parameters.set('domain_type', type);
  parameters.set(
    'page',
    String(options.page === undefined ? 0 : integer(options.page, '--page', 0, 10)),
  );
  for (const [key, name] of [
    ['includeDomains', 'include_domains'],
    ['excludeDomains', 'exclude_domains'],
  ] as const) {
    const value = options[key];
    if (value === undefined) continue;
    const flag = `--${name.replaceAll('_', '-')}`;
    const domains = domainList(value, flag, Number.MAX_SAFE_INTEGER);
    if (domains.some((domain) => domain.includes('/'))) invalid('invalidDomains', flag);
    parameters.set(name, domains.join(','));
  }
  for (const [key, name] of [
    ['afterDate', 'after_date'],
    ['beforeDate', 'before_date'],
  ] as const) {
    const value = options[key];
    if (value === undefined) continue;
    const flag = `--${name.replaceAll('_', '-')}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('tinyfishDate', flag);
    try {
      publishedDate(value);
    } catch (error) {
      if (error instanceof AppError) invalid('tinyfishDate', flag);
      throw error;
    }
    parameters.set(name, value);
  }
  if (
    options.afterDate !== undefined &&
    options.beforeDate !== undefined &&
    options.afterDate > options.beforeDate
  )
    invalid('tinyfishDatesOrder', '--after-date/--before-date');
  if (options.recencyMinutes !== undefined) {
    if (options.afterDate !== undefined || options.beforeDate !== undefined)
      invalid('tinyfishDateConflict', '--recency-minutes');
    parameters.set(
      'recency_minutes',
      String(integer(options.recencyMinutes, '--recency-minutes', 1, 5256000)),
    );
  }
  if (
    type === 'research_paper' &&
    (options.recencyMinutes !== undefined ||
      options.afterDate !== undefined ||
      options.beforeDate !== undefined)
  )
    invalid('tinyfishPaperDates', '--search-type');
  for (const [key, name] of [
    ['pubYearMin', 'pub_year_min'],
    ['pubYearMax', 'pub_year_max'],
  ] as const) {
    const value = options[key];
    if (value === undefined) continue;
    const flag = `--${name.replaceAll('_', '-')}`;
    if (type !== 'research_paper') invalid('tinyfishPaperYears', flag);
    parameters.set(name, String(integer(value, flag, 0, 9999)));
  }
  if (
    options.pubYearMin !== undefined &&
    options.pubYearMax !== undefined &&
    Number(options.pubYearMin) > Number(options.pubYearMax)
  )
    invalid('tinyfishDatesOrder', '--pub-year-min/--pub-year-max');
  for (const name of ['location', 'language'] as const) {
    const value = options[name];
    if (value === undefined) continue;
    if (!token(value)) invalid('invalidToken', `--${name}`);
    parameters.set(name, value);
  }
  const prepared = connection('search', options, values, env, language);
  return {
    ...prepared,
    operation: 'search',
    url: `${prepared.url}?${parameters}`,
  };
}

export function prepareFetch(
  urls: string[],
  options: FetchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): FetchRequest {
  if (!urls.length || urls.length > 10) invalid('tinyfishUrls', 'URL');
  if (urls.some((url) => !validPageUrl(url))) invalid('invalidPageUrl', 'URL');
  const body: JsonObject = { urls, format: 'markdown' };
  if (options.purpose !== undefined) body.purpose = content(options.purpose, '--purpose');
  for (const [key, name, flag] of [
    ['targetSelector', 'include_selectors', '--target-selector'],
    ['removeSelector', 'exclude_selectors', '--remove-selector'],
  ] as const) {
    const selectors = options[key];
    if (selectors === undefined) continue;
    if (!selectors.length || selectors.length > 20) invalid('tinyfishSelector', flag);
    body[name] = selectors.map((value) => content(value, flag, 1000));
  }
  for (const [key, name] of [
    ['includeLinks', 'links'],
    ['includeImageLinks', 'image_links'],
    ['includeMetadata', 'page_metadata'],
  ] as const)
    if (options[key]) body[name] = true;
  for (const [key, name, minimum, maximum, invalidMessage] of [
    ['ttl', 'ttl', 0, undefined, undefined],
    ['perUrlTimeoutMs', 'per_url_timeout_ms', 1, 110000, 'tinyfishUrlTimeout'],
  ] as const) {
    const input = options[key];
    if (input === undefined) continue;
    const option = `--${name.replaceAll('_', '-')}`;
    try {
      body[name] = parseInput(
        { path: option, kind: 'integer', minimum, maximum, invalidMessage },
        input,
      );
    } catch (error) {
      if (error instanceof AppError) invalid(error.key, option);
      throw error;
    }
  }
  const prepared = connection('fetch', options, values, env, language);
  return { ...prepared, operation: 'fetch', urls, body };
}

function httpError(status: number, operation: Request['operation'], tag?: string) {
  let code: AppError['code'] = 'UPSTREAM_ERROR';
  let key: MessageKey = 'tinyfishUpstream';
  let retry = [408, 429, 500, 502, 503, 504].includes(status);
  if ([400, 422].includes(status) || tag === 'INVALID_INPUT') {
    code = 'INVALID_ARGUMENT';
    key = 'tinyfishArgument';
    retry = false;
  } else if (
    status === 401 ||
    ['MISSING_API_KEY', 'INVALID_API_KEY', 'UNAUTHORIZED'].includes(tag ?? '')
  ) {
    code = 'AUTHENTICATION_ERROR';
    key = 'tinyfishAuth';
    retry = false;
  } else if (['INSUFFICIENT_CREDITS', 'DAILY_LIMIT_EXCEEDED'].includes(tag ?? '')) {
    code = 'QUOTA_EXCEEDED';
    key = 'tinyfishQuota';
    retry = false;
  } else if (status === 403 || (status === 402 && operation === 'search')) {
    code = 'ACCESS_DENIED';
    key = 'tinyfishAccess';
    retry = false;
  } else if (status === 429) {
    code = 'RATE_LIMITED';
    key = 'tinyfishRate';
  } else if ([408, 504].includes(status)) {
    code = 'TIMEOUT';
    key = 'requestTimeout';
  }
  return { code, key, retry };
}

export function request(
  input: SearchRequest,
  context: AttemptContext,
  language: Language,
  transport?: typeof fetch,
): Promise<AttemptResult<SearchData>>;
export function request(
  input: FetchRequest,
  context: AttemptContext,
  language: Language,
  transport?: typeof fetch,
): Promise<AttemptResult<FetchData>>;
export async function request(
  input: Request,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<SearchData | FetchData>> {
  const safe = (value: string) => redactDiagnostics(value, input.secrets) as string;
  try {
    let response: Response;
    let bytes: ArrayBuffer | undefined;
    try {
      response = await transport(input.url, {
        method: input.operation === 'search' ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          'X-API-Key': input.apiKey,
          ...(input.operation === 'fetch' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(input.operation === 'fetch' ? { body: JSON.stringify(input.body) } : {}),
        signal: context.signal,
        redirect: 'manual',
      });
      context.httpStatus = response.status;
      context.retryAllowed =
        response.status === 200 || httpError(response.status, input.operation).retry;
      const id = response.headers.get('x-request-id');
      if (id?.trim()) context.requestId = safe(id);
      try {
        bytes = await response.arrayBuffer();
      } catch (error) {
        // A broken error body does not replace the HTTP refusal already received.
        if (
          response.status === 200 ||
          !transportError(error, context, 'tinyfish', 'tinyfishNetwork', safe)
        )
          throw error;
      }
    } catch (error) {
      const mapped = transportError(error, context, 'tinyfish', 'tinyfishNetwork', safe);
      if (!mapped) throw error;
      context.retryAllowed = mapped.retry;
      return { outcome: failure(mapped.error, language), retry: mapped.retry };
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      body = undefined;
    }
    if (
      !context.requestId &&
      isObject(body) &&
      typeof body.request_id === 'string' &&
      body.request_id.trim()
    )
      context.requestId = safe(body.request_id);
    if (response.status === 200) {
      const outcome =
        input.operation === 'search'
          ? searchData(body, context, language)
          : fetchData(body, input, context, language);
      context.retryAllowed = false;
      if (context.pageLatencies)
        context.pageLatencies = context.pageLatencies.map((item) => ({
          ...item,
          url: safe(item.url),
        }));
      if (outcome.result.error)
        outcome.result.error = redactDiagnostics(
          outcome.result.error,
          input.secrets,
        ) as PublicError;
      return { outcome, retry: false };
    }
    const error = isObject(body) && isObject(body.error) ? body.error : undefined;
    const upstreamCode =
      typeof error?.code === 'string' && error.code.trim() ? error.code : undefined;
    const upstreamMessage =
      typeof error?.message === 'string' && error.message.trim() ? error.message : undefined;
    let invalidBody = upstreamCode === undefined || upstreamMessage === undefined;
    const mapped = httpError(response.status, input.operation, upstreamCode);
    const details: JsonObject = { provider: 'tinyfish', http_status: response.status };
    if (context.requestId) details.request_id = context.requestId;
    if (upstreamCode !== undefined) details.upstream_code = safe(upstreamCode);
    if (upstreamMessage !== undefined && upstreamMessage !== text(language, mapped.key))
      details.upstream_message = safe(upstreamMessage);
    if (error) {
      if (isObject(error.details)) {
        for (const name of ['limit', 'window_seconds']) {
          const value = error.details[name];
          if (value === undefined) continue;
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
            invalidBody = true;
          else details[name] = value;
        }
        if (error.details.unit !== undefined) {
          if (typeof error.details.unit !== 'string') invalidBody = true;
          else if (error.details.unit.trim()) details.unit = safe(error.details.unit);
        }
      } else if (Array.isArray(error.details)) {
        const causes: PublicError[] = [];
        for (const entry of error.details) {
          if (!isObject(entry) || typeof entry.message !== 'string') {
            invalidBody = true;
            continue;
          }
          const own: JsonObject = {};
          if (
            Array.isArray(entry.path) &&
            entry.path.every((v) => typeof v === 'string' || typeof v === 'number')
          )
            own.upstream_param = safe(entry.path.join('.'));
          if (typeof entry.code === 'string') own.upstream_code = safe(entry.code);
          causes.push({
            code: mapped.code,
            message: safe(entry.message),
            ...(Object.keys(own).length ? { details: own } : {}),
          });
        }
        if (causes.length) details.causes = causes;
      }
    }
    if (mapped.code === 'TIMEOUT') details.timeout_scope = 'request';
    if (invalidBody) details.reason = 'error_body_invalid';
    const outcome = failure<SearchData | FetchData>(
      new AppError(mapped.code, mapped.key, details),
      language,
    );
    if (invalidBody && outcome.result.error)
      outcome.result.error.message += `${language === 'zh' ? '' : ' '}${text(language, 'errorBodyInvalid')}`;
    context.retryAllowed = mapped.retry;
    return {
      outcome,
      retry: mapped.retry,
      retryAfter: response.headers.get('retry-after') ?? undefined,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    context.retryAllowed = false;
    const outcome = failure<SearchData | FetchData>(error, language);
    if (context.requestId && outcome.result.error)
      outcome.result.error.details = {
        ...outcome.result.error.details,
        request_id: context.requestId,
      };
    return { outcome, retry: false };
  }
}
