import { fieldAt, isObject, parseInput } from '../config/fields.js';
import type { ResolvedField } from '../config/resolve.js';
import { operationConfig } from '../config/status.js';
import type { OperationDefinition } from '../config/status.js';
import { AppError, failure } from '../errors.js';
import type { AttemptContext, AttemptResult } from '../execution.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import type { JsonObject, PublicError } from '../result.js';
import { validPageUrl } from './firecrawl-response.js';
import { parseResponse, readUsage } from './jina-response.js';
import type { Data, FetchData, SearchData, SearchType } from './jina-response.js';
import { configuredSecrets, redactDiagnostics, transportError } from './transport.js';

export const requestLimit = 60;
export const operations: OperationDefinition[] = [
  {
    provider: 'jina',
    operation: 'fetch',
    required: ['providers.jina.reader_url', 'execution.timeout_seconds', 'execution.retries'],
    optional: ['providers.jina.api_key'],
  },
  {
    provider: 'jina',
    operation: 'search',
    required: [
      'providers.jina.search_url',
      'providers.jina.api_key',
      'providers.jina.search.limit',
      'execution.timeout_seconds',
      'execution.retries',
    ],
  },
];
export interface FetchOptions {
  timeout?: number;
  maxTokens?: string;
  targetSelector?: string;
  removeSelector?: string;
  waitForSelector?: string;
  cache?: boolean;
}
export interface SearchOptions {
  timeout?: number;
  limit?: string;
  includeText?: boolean;
  country?: string;
  language?: string;
  searchType?: string;
}
interface Connection {
  url: string;
  body: JsonObject;
  apiKey?: string;
  secrets: string[];
  timeout: number;
  retries: number;
}
export interface FetchRequest extends Connection {
  operation: 'fetch';
}
export interface SearchRequest extends Connection {
  operation: 'search';
  limit: number;
  searchType: SearchType;
  includeText: boolean;
}
export type Request = FetchRequest | SearchRequest;

function prepareConnection(
  operation: Request['operation'],
  options: FetchOptions & SearchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): Connection {
  const overrides: Record<string, ResolvedField> = {};
  for (const [path, value, option] of [
    ['execution.timeout_seconds', options.timeout, '--timeout'],
    ['providers.jina.search.limit', operation === 'search' ? options.limit : undefined, '--limit'],
  ] as const) {
    if (value === undefined) continue;
    const field = fieldAt(path);
    try {
      overrides[path] = {
        field,
        value: typeof value === 'string' ? parseInput(field, value) : value,
        source: 'cli',
        problems: [],
      };
    } catch (error) {
      if (error instanceof AppError) throw new AppError('INVALID_ARGUMENT', error.key, { option });
      throw error;
    }
  }
  const body: JsonObject =
    operation === 'search' && !options.includeText ? {} : { respondWith: 'content' };
  if (operation === 'fetch' && options.maxTokens !== undefined) {
    try {
      body.maxTokens = parseInput(
        {
          path: '--max-tokens',
          kind: 'integer',
          minimum: 500,
          maximum: Number.MAX_SAFE_INTEGER,
          invalidMessage: 'jinaMaxTokensInvalid',
        },
        options.maxTokens,
      );
    } catch (error) {
      if (error instanceof AppError)
        throw new AppError('INVALID_ARGUMENT', error.key, { option: '--max-tokens' });
      throw error;
    }
  }
  const settings = operationConfig(
    values,
    env,
    language,
    operations.find((item) => item.operation === operation)!,
    overrides,
  );
  const base = settings[`providers.jina.${operation === 'fetch' ? 'reader_url' : 'search_url'}`]
    .value as string;
  if (operation === 'search') body.num = settings['providers.jina.search.limit'].value!;
  return {
    url: `${base.replace(/\/+$/, '')}/${operation === 'search' ? 'search' : ''}`,
    body,
    apiKey: settings['providers.jina.api_key'].value as string | undefined,
    secrets: configuredSecrets(values, env),
    timeout: settings['execution.timeout_seconds'].value as number,
    retries: settings['execution.retries'].value as number,
  };
}
export function prepareFetch(
  url: string,
  options: FetchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): FetchRequest {
  if (!validPageUrl(url))
    throw new AppError('INVALID_ARGUMENT', 'invalidPageUrl', { option: 'URL' });
  for (const [key, flag] of [
    ['targetSelector', '--target-selector'],
    ['removeSelector', '--remove-selector'],
    ['waitForSelector', '--wait-for-selector'],
  ] as const) {
    const value = options[key];
    if (value !== undefined && (!value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)))
      throw new AppError('INVALID_ARGUMENT', 'jinaSelectorInvalid', { option: flag });
  }
  const request = prepareConnection('fetch', options, values, env, language);
  request.body.url = url;
  for (const key of ['targetSelector', 'removeSelector', 'waitForSelector'] as const)
    if (options[key] !== undefined) request.body[key] = [options[key]];
  if (options.targetSelector !== undefined || options.removeSelector !== undefined)
    request.body.respondWith = 'markdown';
  if (options.cache === false) request.body.noCache = true;
  return { ...request, operation: 'fetch' };
}
export function prepareSearch(
  query: string,
  options: SearchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): SearchRequest {
  if (!query.trim())
    throw new AppError('INVALID_ARGUMENT', 'jinaQueryInvalid', { option: 'QUERY' });
  if (options.country !== undefined && !/^[a-z]{2}$/i.test(options.country))
    throw new AppError('INVALID_ARGUMENT', 'jinaCountryInvalid', { option: '--country' });
  if (
    options.language !== undefined &&
    (!options.language || /[\s\u0000-\u001f\u007f-\u009f]/u.test(options.language))
  )
    throw new AppError('INVALID_ARGUMENT', 'jinaLanguageInvalid', { option: '--language' });
  const searchType = options.searchType ?? 'web';
  if (searchType !== 'web' && searchType !== 'news' && searchType !== 'images')
    throw new AppError('INVALID_ARGUMENT', 'jinaTypeInvalid', { option: '--search-type' });
  const request = prepareConnection('search', options, values, env, language);
  Object.assign(request.body, { q: query, type: searchType, fallback: false });
  if (options.country !== undefined) request.body.gl = options.country;
  if (options.language !== undefined) request.body.hl = options.language;
  return {
    ...request,
    operation: 'search',
    searchType,
    limit: request.body.num as number,
    includeText: options.includeText === true,
  };
}

function httpError(
  status: number,
  operation: Request['operation'],
  tag?: number,
): { code: AppError['code']; key: MessageKey; retry: boolean } {
  const common: Record<number, [AppError['code'], MessageKey]> = {
    400: ['INVALID_ARGUMENT', 'jinaArgument'],
    401: ['AUTHENTICATION_ERROR', 'jinaAuth'],
    402: ['QUOTA_EXCEEDED', 'jinaQuota'],
    403: ['ACCESS_DENIED', 'jinaAccess'],
    408: ['TIMEOUT', 'requestTimeout'],
    429: ['RATE_LIMITED', 'jinaRate'],
    504: ['TIMEOUT', 'requestTimeout'],
  };
  let mapped = common[status];
  if (status === 402 && tag === 40202) mapped = ['ACCESS_DENIED', 'jinaAccess'];
  if (tag === 42203) mapped = ['INVALID_ARGUMENT', 'jinaArgument'];
  if (
    operation === 'fetch' &&
    tag !== undefined &&
    [40902, 41302, 42205, 42206, 45101].includes(tag)
  )
    mapped = ['CONTENT_UNAVAILABLE', 'jinaTargetFailed'];
  const [code, key] = mapped ?? ['UPSTREAM_ERROR', 'jinaUpstream'];
  return { code, key, retry: [408, 429, 500, 502, 503, 504].includes(status) };
}

export function request(
  input: FetchRequest,
  context: AttemptContext,
  language: Language,
  transport?: typeof fetch,
): Promise<AttemptResult<FetchData>>;
export function request(
  input: SearchRequest,
  context: AttemptContext,
  language: Language,
  transport?: typeof fetch,
): Promise<AttemptResult<SearchData>>;
export async function request(
  input: Request,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<Data>> {
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
          ...(input.operation === 'search' && !input.includeText
            ? { 'X-Respond-With': 'no-content' }
            : {}),
          ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body: JSON.stringify(input.body),
        signal: context.signal,
        redirect: 'manual',
      });
      context.httpStatus = response.status;
      context.retryAllowed =
        response.status === 200 || httpError(response.status, input.operation).retry;
      const id = response.headers.get('x-request-id');
      if (id?.trim()) context.requestId = safe(id);
      bytes = await response.arrayBuffer();
    } catch (error) {
      const mapped = transportError(error, context, 'jina', 'jinaNetwork', safe);
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
      const outcome = parseResponse(body, input, context, language, safe);
      context.retryAllowed = !outcome.result.error;
      if (outcome.result.error)
        outcome.result.error = redactDiagnostics(
          outcome.result.error,
          input.secrets,
        ) as PublicError;
      return { outcome, retry: false };
    }
    const validEnvelope =
      isObject(body) &&
      body.code === response.status &&
      Number.isSafeInteger(body.status) &&
      Math.floor((body.status as number) / 100) === response.status;
    let invalidBody = !validEnvelope || !readUsage(body, context);
    const details: JsonObject = { provider: 'jina', http_status: response.status };
    const tag = validEnvelope && isObject(body) ? (body.status as number) : undefined;
    if (tag !== undefined) details.upstream_code = tag;
    if (isObject(body)) {
      for (const [source, target] of [
        ['message', 'upstream_message'],
        ['readableMessage', 'upstream_readable_message'],
      ] as const) {
        const value = body[source];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') invalidBody = true;
        else if (value.trim()) details[target] = safe(value);
      }
    }
    if (details.upstream_readable_message === details.upstream_message)
      delete details.upstream_readable_message;
    const mapped = httpError(response.status, input.operation, invalidBody ? undefined : tag);
    context.retryAllowed = mapped.retry;
    if (mapped.code === 'TIMEOUT') details.timeout_scope = 'request';
    if (context.requestId) details.request_id = context.requestId;
    if (invalidBody) details.reason = 'error_body_invalid';
    const outcome = failure<Data>(new AppError(mapped.code, mapped.key, details), language);
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
    const outcome = failure<Data>(error, language);
    if (context.requestId && outcome.result.error)
      outcome.result.error.details = {
        ...outcome.result.error.details,
        request_id: context.requestId,
      };
    return { outcome, retry: false };
  }
}
