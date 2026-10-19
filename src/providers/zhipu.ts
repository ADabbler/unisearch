import { fieldAt, isObject, parseInput, problemError } from '../config/fields.js';
import { resolveField } from '../config/resolve.js';
import type { ResolvedField } from '../config/resolve.js';
import { operationConfig } from '../config/status.js';
import type { OperationDefinition } from '../config/status.js';
import { AppError, failure } from '../errors.js';
import type { AttemptContext, AttemptResult } from '../execution.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import type { JsonObject, PublicError } from '../result.js';
import { validPageUrl } from './firecrawl-response.js';
import {
  configuredSecrets,
  redactDiagnostics,
  redactSecrets,
  transportError,
} from './transport.js';
import { parseResponse } from './zhipu-response.js';
import type { DataByOperation } from './zhipu-response.js';

export type Operation = 'search' | 'fetch';
export const requestLimits = { search: 30, fetch: 60 };
const connection = [
  'providers.zhipu.api_key',
  'providers.zhipu.platform',
  'providers.zhipu.base_url',
];
const execution = ['execution.timeout_seconds', 'execution.retries'];
export const operations: readonly OperationDefinition[] = [
  {
    provider: 'zhipu',
    operation: 'search',
    required: [...connection, ...execution, 'providers.zhipu.search.engine'],
    optional: ['providers.zhipu.search.limit'],
  },
  { provider: 'zhipu', operation: 'fetch', required: [...connection, ...execution] },
];
export interface SearchOptions {
  timeout?: number;
  engine?: string;
  limit?: string;
  recency?: string;
  includeDomains?: string;
  contentSize?: string;
}
export interface FetchOptions {
  timeout?: number;
  cache?: boolean;
  images?: boolean;
  includeImagesSummary?: boolean;
  includeLinksSummary?: boolean;
}
export interface Request<O extends Operation = Operation> {
  operation: O;
  platform: 'bigmodel' | 'zai';
  url: string;
  body: JsonObject;
  apiKey: string;
  secrets: string[];
  timeout: number;
  retries: number;
}

export function prepare<O extends Operation>(
  operation: O,
  input: string,
  options: SearchOptions & FetchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): Request<O> {
  const overrides: Record<string, ResolvedField> = {};
  if (options.timeout !== undefined) {
    const field = fieldAt('execution.timeout_seconds');
    overrides[field.path] = { field, value: options.timeout, source: 'cli', problems: [] };
  }
  if (operation === 'search') {
    if (!input.trim()) throw new AppError('INVALID_ARGUMENT', 'emptyQuery', { option: 'QUERY' });
    const searchFields = [
      ['engine', '--engine'],
      ['limit', '--limit'],
    ] as const;
    for (const [name, option] of searchFields) {
      const value = options[name];
      if (value === undefined) continue;
      const field = fieldAt(`providers.zhipu.search.${name}`);
      try {
        overrides[field.path] = {
          field,
          value: parseInput(field, value),
          source: 'cli',
          problems: [],
        };
      } catch (error) {
        if (error instanceof AppError)
          throw new AppError('INVALID_ARGUMENT', error.key, { option });
        throw error;
      }
    }
    if (options.contentSize !== undefined && !['medium', 'high'].includes(options.contentSize))
      throw new AppError('INVALID_ARGUMENT', 'zhipuContentSize', { option: '--content-size' });
    for (const [name, option] of searchFields) {
      const path = `providers.zhipu.search.${name}`;
      const setting = resolveField(values, env, fieldAt(path), overrides);
      const problem = setting.problems[0];
      if (!problem) continue;
      const introducedByEngine =
        name === 'limit' &&
        options.engine !== undefined &&
        !resolveField(values, env, fieldAt(path)).problems.length;
      if (problem.field === path && (overrides[path] || introducedByEngine))
        throw new AppError('INVALID_ARGUMENT', problem.message, {
          provider: 'zhipu',
          option: overrides[path] ? option : '--engine',
        });
      throw problemError(problem);
    }
    if (
      options.contentSize !== undefined &&
      resolveField(values, env, fieldAt('providers.zhipu.platform'), overrides).value === 'zai'
    )
      throw new AppError('INVALID_ARGUMENT', 'zhipuContentUnsupported', {
        option: '--content-size',
      });
  } else if (!validPageUrl(input)) {
    throw new AppError('INVALID_ARGUMENT', 'invalidPageUrl', { option: 'URL' });
  }
  const settings = operationConfig(
    values,
    env,
    language,
    operations.find((item) => item.operation === operation)!,
    overrides,
  );
  const platform = settings['providers.zhipu.platform'].value as Request['platform'];
  const body: JsonObject = {};
  if (operation === 'search') {
    if (platform === 'bigmodel' && [...input].length > 70)
      throw new AppError('INVALID_ARGUMENT', 'zhipuQueryLimit', {
        provider: 'zhipu',
        option: 'QUERY',
      });
    const engine = settings['providers.zhipu.search.engine'].value as string;
    body.search_engine = engine;
    body.search_query = input;
    if (platform === 'bigmodel') body.search_intent = false;
    const count = settings['providers.zhipu.search.limit'];
    if (count.value !== undefined) body.count = count.value;
    if (options.contentSize !== undefined) body.content_size = options.contentSize;
    if (options.recency !== undefined) {
      if (!['oneDay', 'oneWeek', 'oneMonth', 'oneYear', 'noLimit'].includes(options.recency))
        throw new AppError('INVALID_ARGUMENT', 'zhipuRecency', { option: '--recency' });
      if (options.recency !== 'noLimit') body.search_recency_filter = options.recency;
    }
    if (options.includeDomains !== undefined) {
      if (!options.includeDomains.trim())
        throw new AppError('INVALID_ARGUMENT', 'zhipuDomainEmpty', { option: '--include-domains' });
      if (engine === 'search_pro_quark')
        throw new AppError('INVALID_ARGUMENT', 'zhipuDomainUnsupported', {
          option: '--include-domains',
        });
      body.search_domain_filter = options.includeDomains;
    }
    if (engine === 'search_pro_sogou' && body.search_domain_filter && body.search_recency_filter) {
      if (count.source !== 'default' && count.source !== 'unset')
        throw new AppError('INVALID_ARGUMENT', 'zhipuFilteredCount', {
          option: options.limit !== undefined ? '--limit' : '--include-domains',
          field: count.field.path,
        });
      delete body.count;
    }
  } else {
    Object.assign(body, { url: input, return_format: 'markdown', timeout: 20 });
    if (options.cache === false) body.no_cache = true;
    if (options.images === false) body.retain_images = false;
    if (options.includeImagesSummary) body.with_images_summary = true;
    if (options.includeLinksSummary) body.with_links_summary = true;
  }
  const base = (settings['providers.zhipu.base_url'].value as string).replace(/\/+$/, '');
  return {
    operation,
    platform,
    url: `${base}/${operation === 'search' ? 'web_search' : 'reader'}`,
    body,
    apiKey: settings['providers.zhipu.api_key'].value as string,
    secrets: configuredSecrets(values, env),
    timeout: settings['execution.timeout_seconds'].value as number,
    retries: settings['execution.retries'].value as number,
  };
}

type ErrorMapping = { code: AppError['code']; key: MessageKey; retry: boolean };
function mapping(code: AppError['code'], key: MessageKey, retry = false): ErrorMapping {
  return { code, key, retry };
}
function httpError(status: number): ErrorMapping {
  switch (status) {
    case 400:
      return mapping('INVALID_ARGUMENT', 'zhipuArgument');
    case 401:
      return mapping('AUTHENTICATION_ERROR', 'zhipuAuth');
    case 403:
      return mapping('ACCESS_DENIED', 'zhipuAccess');
    case 408:
    case 504:
      return mapping('TIMEOUT', 'requestTimeout', true);
    case 429:
      return mapping('RATE_LIMITED', 'zhipuRate', true);
    default:
      return mapping('UPSTREAM_ERROR', 'zhipuUpstream', [500, 502, 503].includes(status));
  }
}
function businessError(code: string, request: Request): ErrorMapping | undefined {
  if (['1000', '1001', '1003', '1005'].includes(code))
    return mapping('AUTHENTICATION_ERROR', 'zhipuAuth');
  if (['1113', '1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321'].includes(code))
    return mapping('QUOTA_EXCEEDED', 'zhipuQuota');
  if (['1210', '1211', '1212', '1213', '1214', '1215', '1261'].includes(code))
    return mapping('INVALID_ARGUMENT', 'zhipuArgument');
  if (['1220', '1309', '1311', '1313', '1314', '1315'].includes(code))
    return mapping('ACCESS_DENIED', 'zhipuAccess');
  if (['1221', '1222', '1301'].includes(code)) return mapping('UPSTREAM_ERROR', 'zhipuUpstream');
  if (['1302', '1305'].includes(code)) return mapping('RATE_LIMITED', 'zhipuRate', true);
  if (['1200', '1230', '1234'].includes(code))
    return mapping('UPSTREAM_ERROR', 'zhipuUpstream', true);
  if (request.platform === 'bigmodel' && request.operation === 'search') {
    if (code === '1701') return mapping('RATE_LIMITED', 'zhipuRate', true);
    if (['1702', '1703'].includes(code)) return mapping('UPSTREAM_ERROR', 'zhipuUpstream');
  }
  return undefined;
}

// Keep execution policy independent of redacted display fields, without adding
// private control fields to the public error object.
const upstreamSwitchPolicy = new WeakMap<PublicError, boolean>();

export function canSwitchUpstream(error: PublicError): boolean {
  return upstreamSwitchPolicy.get(error) === true;
}

export function canSwitchInterruptedResponse(error: PublicError): boolean {
  const status = error.details?.http_status;
  if (status === undefined || status === 200) return true;
  // A failed body read cannot turn a known parameter error or unknown refusal into
  // a transient service failure eligible for switching.
  return status === 401 || status === 403 || httpError(Number(status)).retry;
}

export async function request<O extends Operation>(
  request: Request<O>,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<DataByOperation[O]>> {
  const safe = (value: string) => redactDiagnostics(value, request.secrets) as string;
  try {
    let response: Response;
    let bytes: ArrayBuffer;
    try {
      response = await transport(request.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${request.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(request.body),
        redirect: 'manual',
        signal: context.signal,
      });
      context.httpStatus = response.status;
      context.retryAllowed = response.status === 200 || httpError(response.status).retry;
      const id = response.headers.get('x-request-id');
      if (id?.trim()) context.requestId = safe(id);
      bytes = await response.arrayBuffer();
    } catch (error) {
      const mapped = transportError(error, context, 'zhipu', 'zhipuNetwork', safe);
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
    if (isObject(body)) {
      if (typeof body.request_id === 'string' && body.request_id.trim())
        context.requestId = safe(body.request_id);
      if (typeof body.id === 'string' && body.id.trim()) {
        const id = safe(body.id);
        if (id !== context.requestId) context.responseId = id;
      }
      if (request.operation === 'fetch' && typeof body.model === 'string' && body.model.trim())
        context.model = safe(body.model);
    }
    const hasError =
      isObject(body) &&
      (Object.hasOwn(body, 'error') || (request.platform === 'zai' && Object.hasOwn(body, 'code')));
    if (response.status === 200 && !hasError) {
      const outcome = parseResponse(body, request, context, language);
      if (outcome.result.error) context.retryAllowed = false;
      return { outcome, retry: false };
    }
    const nested = isObject(body) && Object.hasOwn(body, 'error');
    const raw = nested && isObject(body) ? body.error : body;
    const valid =
      isObject(raw) &&
      typeof raw.message === 'string' &&
      !!raw.message.trim() &&
      (nested
        ? typeof raw.code === 'string' && !!raw.code.trim()
        : request.platform === 'zai' && Number.isSafeInteger(raw.code));
    let mapped = httpError(response.status);
    if (valid) mapped = businessError(String(raw.code), request) ?? mapped;
    else if (response.status === 200) mapped = mapping('INVALID_RESPONSE', 'zhipuResponse');
    context.retryAllowed = mapped.retry;
    const details: JsonObject = {
      provider: 'zhipu',
      http_status: response.status,
      ...(context.requestId ? { request_id: context.requestId } : {}),
      ...(context.responseId ? { response_id: context.responseId } : {}),
      ...(mapped.code === 'TIMEOUT' ? { timeout_scope: 'request' } : {}),
    };
    if (valid) {
      details.upstream_code = redactSecrets(String(raw.code), request.secrets);
      const message = safe(raw.message as string);
      if (message !== text(language, mapped.key)) details.upstream_message = message;
    } else details.reason = 'error_body_invalid';
    const outcome = failure<DataByOperation[O]>(
      new AppError(mapped.code, mapped.key, details),
      language,
    );
    if (outcome.result.error?.code === 'UPSTREAM_ERROR')
      upstreamSwitchPolicy.set(outcome.result.error, mapped.retry);
    if (!valid && response.status !== 200 && outcome.result.error)
      outcome.result.error.message += `${language === 'zh' ? '；' : '; '}${text(language, 'errorBodyInvalid')}`;
    return {
      outcome,
      retry: mapped.retry,
      retryAfter: response.headers.get('retry-after') ?? undefined,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    context.retryAllowed = false;
    return { outcome: failure(error, language), retry: false };
  }
}
