import { fieldAt, isObject, parseInput } from '../config/fields.js';
import type { ResolvedField } from '../config/resolve.js';
import { operationConfig } from '../config/status.js';
import type { OperationDefinition } from '../config/status.js';
import { AppError, failure } from '../errors.js';
import type { AttemptContext, AttemptResult } from '../execution.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { success } from '../result.js';
import type { JsonObject } from '../result.js';
import { domainList, publishedDate } from './exa.js';
import { validPageUrl } from './firecrawl-response.js';
import { fetchData, searchData } from './deepseek-response.js';
import type { FetchData, SearchData } from './deepseek-response.js';
import { configuredSecrets, redactDiagnostics, transportError } from './transport.js';

export const requestLimits = { search: 30, fetch: 30 };
export const operations: OperationDefinition[] = ['search', 'fetch'].map((operation) => ({
  provider: 'deepseek',
  operation,
  required: [
    'providers.deepseek.api_key',
    'providers.deepseek.base_url',
    'execution.timeout_seconds',
    'execution.retries',
    ...(operation === 'search' ? ['providers.deepseek.search.limit'] : []),
  ],
}));

export interface SearchOptions {
  limit?: string;
  includeText?: boolean;
  question?: string;
  includeDomains?: string;
  excludeDomains?: string;
  language?: string;
  afterDate?: string;
  beforeDate?: string;
  timeout?: number;
}
export interface FetchOptions {
  timeout?: number;
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
  body: JsonObject;
}
export interface FetchRequest extends Connection {
  operation: 'fetch';
  body: JsonObject;
}
type Request = SearchRequest | FetchRequest;

const queryLimit = 128;

function invalid(key: MessageKey, option: string): never {
  throw new AppError('INVALID_ARGUMENT', key, { option });
}
function cliOverride(path: string, value: number): ResolvedField {
  return { field: fieldAt(path), value, source: 'cli', problems: [] };
}

// Values reach the query verbatim, so anything the API's site: operator cannot express would
// silently change what the search matches.
function sites(value: string, option: string, maximum: number): string[] {
  const domains = domainList(value, option, maximum);
  for (const domain of domains)
    if (/[/:"\\]/u.test(domain) || !validDomain(domain)) invalid('deepseekDomains', option);
  return domains;
}
function validDomain(value: string): boolean {
  return value
    .split('.')
    .every((label) => /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label));
}

function languages(value: string, option: string): string[] {
  const codes = value.split(',');
  for (const code of codes)
    if (!code.trim() || /[\s\u0000-\u001f\u007f-\u009f]/u.test(code))
      invalid('deepseekLanguageCode', option);
  return codes;
}

function date(value: string, option: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) invalid('deepseekDate', option);
  try {
    publishedDate(value);
  } catch (error) {
    if (error instanceof AppError) invalid('deepseekDate', option);
    throw error;
  }
  return value;
}

export function prepareSearch(
  query: string,
  options: SearchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): SearchRequest {
  if (!query.trim()) invalid('emptyQuery', 'QUERY');
  const filters: { text: string; flag: string }[] = [];
  if (options.includeDomains !== undefined) {
    const domains = sites(options.includeDomains, '--include-domains', Number.MAX_SAFE_INTEGER);
    filters.push({
      flag: '--include-domains',
      text: domains.map((domain) => `site:${domain}`).join(' OR '),
    });
  }
  if (options.excludeDomains !== undefined) {
    const domains = sites(options.excludeDomains, '--exclude-domains', Number.MAX_SAFE_INTEGER);
    // Exclusion takes plain space separation; `OR` would turn it into an alternative query.
    for (const domain of domains)
      filters.push({ flag: '--exclude-domains', text: `-site:${domain}` });
  }
  if (options.language !== undefined) {
    const codes = languages(options.language, '--language');
    filters.push({ flag: '--language', text: `lang:${codes.join(',')}` });
  }
  for (const [key, flag] of [
    ['afterDate', '--after-date'],
    ['beforeDate', '--before-date'],
  ] as const) {
    const value = options[key];
    if (value === undefined) continue;
    filters.push({
      flag,
      text: `${key === 'afterDate' ? 'after' : 'before'}:${date(value, flag)}`,
    });
  }
  if (
    options.afterDate !== undefined &&
    options.beforeDate !== undefined &&
    options.afterDate > options.beforeDate
  )
    invalid('deepseekDatesOrder', '--after-date/--before-date');
  const composed = filters.length
    ? `${query} ${filters.map((item) => item.text).join(' ')}`
    : query;
  if ([...composed].length > queryLimit) {
    // Naming one filter would be arbitrary when several together pushed the query over.
    const flags = [...new Set(filters.map((item) => item.flag))].join('/');
    invalid('deepseekQueryLimit', [...query].length > queryLimit ? 'QUERY' : flags);
  }
  if (
    options.question !== undefined &&
    (!options.question.trim() || [...options.question].length > queryLimit)
  )
    invalid('deepseekQuestionInvalid', '--question');
  const overrides: Record<string, ResolvedField> = {};
  if (options.timeout !== undefined)
    overrides['execution.timeout_seconds'] = cliOverride(
      'execution.timeout_seconds',
      options.timeout,
    );
  if (options.limit !== undefined) {
    try {
      overrides['providers.deepseek.search.limit'] = cliOverride(
        'providers.deepseek.search.limit',
        parseInput(fieldAt('providers.deepseek.search.limit'), options.limit) as number,
      );
    } catch (error) {
      if (error instanceof AppError)
        throw new AppError('INVALID_ARGUMENT', error.key, { option: '--limit' });
      throw error;
    }
  }
  const settings = operationConfig(
    values,
    env,
    language,
    operations.find((item) => item.operation === 'search')!,
    overrides,
  );
  const body: JsonObject = {
    query: composed,
    count: settings['providers.deepseek.search.limit'].value as number,
    need_content: options.includeText === true,
  };
  if (options.question !== undefined) body.ori_question = options.question;
  return {
    ...connection('search', settings, values, env),
    operation: 'search',
    body,
  };
}

export function prepareFetch(
  url: string,
  options: FetchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): FetchRequest {
  if (!validPageUrl(url)) invalid('invalidPageUrl', 'URL');
  const overrides: Record<string, ResolvedField> = {};
  if (options.timeout !== undefined)
    overrides['execution.timeout_seconds'] = cliOverride(
      'execution.timeout_seconds',
      options.timeout,
    );
  const settings = operationConfig(
    values,
    env,
    language,
    operations.find((item) => item.operation === 'fetch')!,
    overrides,
  );
  return {
    ...connection('fetch', settings, values, env),
    operation: 'fetch',
    body: { url },
  };
}

function connection(
  operation: Request['operation'],
  settings: ReturnType<typeof operationConfig>,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
) {
  const base = (settings['providers.deepseek.base_url'].value as string).replace(/\/+$/, '');
  return {
    url: `${base}/v1/tools/${operation}`,
    apiKey: settings['providers.deepseek.api_key'].value as string,
    secrets: configuredSecrets(values, env),
    timeout: settings['execution.timeout_seconds'].value as number,
    retries: settings['execution.retries'].value as number,
  };
}

export function httpError(
  status: number,
  operation?: Request['operation'],
): {
  code: AppError['code'];
  key: MessageKey;
  retry: boolean;
} {
  if (status === 400 || status === 413)
    return { code: 'INVALID_ARGUMENT', key: 'deepseekArgument', retry: false };
  if (status === 401) return { code: 'AUTHENTICATION_ERROR', key: 'deepseekAuth', retry: false };
  if (status === 402) return { code: 'QUOTA_EXCEEDED', key: 'deepseekQuota', retry: false };
  if (status === 403) return { code: 'ACCESS_DENIED', key: 'deepseekAccess', retry: false };
  // 404 documents a refused page read, which search never performs.
  if (status === 404 && operation === 'fetch')
    return { code: 'CONTENT_UNAVAILABLE', key: 'deepseekUnavailable', retry: false };
  if (status === 408 || status === 504)
    return { code: 'TIMEOUT', key: 'requestTimeout', retry: true };
  if (status === 429) return { code: 'RATE_LIMITED', key: 'deepseekRate', retry: true };
  return { code: 'UPSTREAM_ERROR', key: 'deepseekUpstream', retry: status >= 500 };
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
    let bytes: ArrayBuffer;
    try {
      response = await transport(input.url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify(input.body),
        redirect: 'manual',
        signal: context.signal,
      });
      context.httpStatus = response.status;
      context.retryAllowed =
        response.status === 200 || httpError(response.status, input.operation).retry;
      const id = response.headers.get('x-request-id');
      if (id?.trim()) context.requestId = safe(id);
      bytes = await response.arrayBuffer();
    } catch (error) {
      const mapped = transportError(error, context, 'deepseek', 'deepseekNetwork', safe);
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
    if (response.status === 200) {
      if (input.operation === 'search')
        return {
          outcome: success(searchData(body, input.body.count as number)),
          retry: false,
        };
      return { outcome: success(fetchData(body, input.body.url as string)), retry: false };
    }
    const mapped = httpError(response.status, input.operation);
    context.retryAllowed = mapped.retry;
    const details: JsonObject = { provider: 'deepseek', http_status: response.status };
    if (context.requestId) details.request_id = context.requestId;
    if (mapped.code === 'TIMEOUT') details.timeout_scope = 'request';
    const error = isObject(body) && isObject(body.error) ? body.error : undefined;
    let validBody = false;
    if (error && typeof error.message === 'string' && error.message.trim()) {
      validBody = true;
      details.upstream_message = safe(error.message);
      for (const [field, key] of [
        ['type', 'upstream_type'],
        ['code', 'upstream_code'],
        ['param', 'upstream_param'],
      ] as const) {
        const value = error[field];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string') validBody = false;
        else details[key] = safe(value);
      }
    }
    if (!validBody) details.reason = 'error_body_invalid';
    const outcome = failure<SearchData | FetchData>(
      new AppError(mapped.code, mapped.key, details),
      language,
    );
    if (outcome.result.error) {
      if (details.upstream_message === outcome.result.error.message)
        delete details.upstream_message;
      if (!validBody)
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
    const outcome = failure<SearchData | FetchData>(error, language);
    if (context.requestId && outcome.result.error)
      outcome.result.error.details = {
        ...outcome.result.error.details,
        request_id: context.requestId,
      };
    return { outcome, retry: false };
  }
}
