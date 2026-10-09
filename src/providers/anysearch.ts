import { fieldAt, hasNonfiniteNumber, isObject, parseInput, token } from '../config/fields.js';
import type { ResolvedField } from '../config/resolve.js';
import { operationConfig } from '../config/status.js';
import type { OperationDefinition } from '../config/status.js';
import { AppError, failure } from '../errors.js';
import type { AttemptContext, AttemptResult } from '../execution.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { success } from '../result.js';
import type { JsonObject } from '../result.js';
import { validPageUrl } from './firecrawl-response.js';
import { configuredSecrets, redactDiagnostics, transportError } from './transport.js';

export type Operation = 'search' | 'domains' | 'extract';
export const operations: OperationDefinition[] = ['search', 'domains', 'extract'].map(
  (operation) => ({
    provider: 'anysearch',
    operation,
    required: [
      'providers.anysearch.base_url',
      'execution.timeout_seconds',
      'execution.retries',
      ...(operation === 'search' ? ['providers.anysearch.search.limit'] : []),
    ],
    optional: ['providers.anysearch.api_key'],
  }),
);
export const requestLimit = 30;
// Official catalog: anysearch-ai/anysearch-skill, 9b91ee215164de60d61c7d63789c891a1948b039,
// scripts/shared/constants.json. These names do not restrict online domain queries.
export const rootDomains: readonly string[] = [
  'general',
  'resource',
  'social_media',
  'finance',
  'academic',
  'legal',
  'health',
  'business',
  'security',
  'ip',
  'code',
  'energy',
  'environment',
  'agriculture',
  'travel',
  'film',
  'gaming',
];
export type CatalogData = {
  provider: 'anysearch';
  catalog_source: 'bundled';
  domains: string[];
};
export type SearchData = {
  provider: 'anysearch';
  results: { url: string; title?: string; snippet?: string; content?: string }[];
};
export type Domain = {
  domain: string;
  description?: string;
  sub_domains: {
    sub_domain: string;
    description?: string;
    params?: Record<string, { required: boolean; description?: string }>;
  }[];
};
export type DomainsData = { provider: 'anysearch'; domains: Domain[] };
export type ExtractData = { provider: 'anysearch'; url: string; title?: string; text: string };
interface DataByOperation {
  search: SearchData;
  domains: DomainsData;
  extract: ExtractData;
}
export interface SearchOptions {
  limit?: string;
  tag?: string;
  params?: string;
  zone?: string;
  language?: string;
  timeout?: number;
}
export interface Request<O extends Operation = Operation> {
  operation: O;
  url: string;
  body?: JsonObject;
  apiKey?: string;
  secrets: string[];
  timeout: number;
  retries: number;
}

export function catalog(
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): CatalogData {
  operationConfig(values, env, language, {
    provider: 'anysearch',
    operation: 'domains',
    required: [],
  });
  return { provider: 'anysearch', catalog_source: 'bundled', domains: [...rootDomains] };
}

function validTag(value: unknown): value is string {
  return token(value) && /^[^.]+\.[^.]+$/.test(value);
}
export function prepare<O extends Operation>(
  operation: O,
  input: string,
  options: SearchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): Request<O> {
  const overrides: Record<string, ResolvedField> = {};
  const override = (path: string, value: number) => {
    overrides[path] = { field: fieldAt(path), value, source: 'cli', problems: [] };
  };
  if (options.timeout !== undefined) override('execution.timeout_seconds', options.timeout);
  let body: JsonObject | undefined;
  if (operation === 'search') {
    if (!input.trim()) throw new AppError('INVALID_ARGUMENT', 'emptyQuery', { option: 'QUERY' });
    body = { query: input, format: 'markdown' };
    if (options.limit !== undefined) {
      try {
        override(
          'providers.anysearch.search.limit',
          parseInput(fieldAt('providers.anysearch.search.limit'), options.limit) as number,
        );
      } catch (error) {
        if (error instanceof AppError)
          throw new AppError('INVALID_ARGUMENT', error.key, { option: '--limit' });
        throw error;
      }
    }
    for (const [key, valid, message] of [
      ['tag', validTag, 'anysearchTag'],
      ['zone', (value: string) => value === 'cn' || value === 'intl', 'anysearchZone'],
      ['language', token, 'invalidToken'],
    ] as const) {
      const value = options[key];
      if (value === undefined) continue;
      if (!valid(value)) throw new AppError('INVALID_ARGUMENT', message, { option: `--${key}` });
      body[key] = value;
    }
    if (options.params !== undefined) {
      let params: unknown;
      try {
        params = JSON.parse(options.params);
      } catch {
        throw new AppError('INVALID_ARGUMENT', 'anysearchParams', { option: '--params' });
      }
      if (!isObject(params) || hasNonfiniteNumber(params))
        throw new AppError('INVALID_ARGUMENT', 'anysearchParams', { option: '--params' });
      body.params = params as JsonObject;
    }
  } else if (operation === 'domains') {
    if (!token(input)) throw new AppError('INVALID_ARGUMENT', 'invalidToken', { option: 'DOMAIN' });
  } else {
    if (!validPageUrl(input))
      throw new AppError('INVALID_ARGUMENT', 'invalidPageUrl', { option: 'URL' });
    body = { url: input };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 16384)
      throw new AppError('INVALID_ARGUMENT', 'anysearchBodyLimit', { option: 'URL' });
  }
  const settings = operationConfig(
    values,
    env,
    language,
    operations.find((item) => item.operation === operation)!,
    overrides,
  );
  if (operation === 'search')
    body!.max_results = settings['providers.anysearch.search.limit'].value!;
  const base = (settings['providers.anysearch.base_url'].value as string).replace(/\/+$/, '');
  const url = new URL(`${base}/v1/${operation === 'domains' ? 'sub-domains' : operation}`);
  if (operation === 'domains') url.searchParams.set('domain', input);
  return {
    operation,
    url: url.href,
    body,
    apiKey: settings['providers.anysearch.api_key'].value as string | undefined,
    secrets: configuredSecrets(values, env),
    timeout: settings['execution.timeout_seconds'].value as number,
    retries: settings['execution.retries'].value as number,
  };
}

function invalid(): never {
  throw new AppError('INVALID_RESPONSE', 'anysearchResponse', {
    provider: 'anysearch',
    http_status: 200,
  });
}
function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : invalid();
}
function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return invalid();
  return value.trim() ? value : undefined;
}
function description(value: unknown): { description?: string } {
  const result = optionalText(value);
  return result === undefined ? {} : { description: result };
}
export function searchData(value: unknown, limit: number): SearchData {
  const body = object(value);
  if (!Array.isArray(body.results) || body.results.length > limit) return invalid();
  return {
    provider: 'anysearch',
    results: body.results.map((entry) => {
      const item = object(entry);
      if (!validPageUrl(item.url)) return invalid();
      const result: SearchData['results'][number] = { url: item.url };
      for (const key of ['title', 'snippet', 'content'] as const) {
        const value = optionalText(item[key]);
        if (value !== undefined) result[key] = value;
      }
      if (result.snippet === result.content) delete result.snippet;
      return result;
    }),
  };
}
export function domainsData(value: unknown): DomainsData {
  const body = object(value);
  if (!Array.isArray(body.domains)) return invalid();
  return {
    provider: 'anysearch',
    domains: body.domains.map((entry): Domain => {
      const item = object(entry);
      if (!token(item.domain) || !Array.isArray(item.sub_domains)) return invalid();
      return {
        domain: item.domain,
        ...description(item.description),
        sub_domains: item.sub_domains.map((entry) => {
          const sub = object(entry);
          if (!validTag(sub.sub_domain)) return invalid();
          const result: Domain['sub_domains'][number] = {
            sub_domain: sub.sub_domain,
            ...description(sub.description),
          };
          if (sub.params !== undefined) {
            const entries = Object.entries(object(sub.params)).map(([name, value]) => {
              const param = object(value);
              if (!name.trim() || typeof param.required !== 'boolean') return invalid();
              return [name, { ...description(param.description), required: param.required }];
            });
            if (entries.length) result.params = Object.fromEntries(entries);
          }
          return result;
        }),
      };
    }),
  };
}
export function extractData(value: unknown): ExtractData {
  const body = object(value);
  if (!validPageUrl(body.url) || typeof body.content !== 'string') return invalid();
  const title = optionalText(body.title);
  if (!body.content.trim())
    throw new AppError('CONTENT_UNAVAILABLE', 'anysearchUnavailable', {
      provider: 'anysearch',
      http_status: 200,
      reason: 'empty_content',
    });
  return { provider: 'anysearch', url: body.url, ...(title ? { title } : {}), text: body.content };
}

function httpError(
  status: number,
  operation: Operation,
): {
  code: AppError['code'];
  key: MessageKey;
  retry: boolean;
} {
  const common: Record<number, [AppError['code'], MessageKey]> = {
    400: ['INVALID_ARGUMENT', 'anysearchArgument'],
    401: ['AUTHENTICATION_ERROR', 'anysearchAuth'],
    402: ['QUOTA_EXCEEDED', 'anysearchQuota'],
    403: ['ACCESS_DENIED', 'anysearchAccess'],
    408: ['TIMEOUT', 'requestTimeout'],
    504: ['TIMEOUT', 'requestTimeout'],
    429: ['RATE_LIMITED', 'anysearchRate'],
  };
  const [code, key] =
    common[status] ??
    (status === 422 && operation === 'extract'
      ? ['CONTENT_UNAVAILABLE', 'anysearchUnavailable']
      : ['UPSTREAM_ERROR', 'anysearchUpstream']);
  return { code, key, retry: [408, 429, 500, 502, 503, 504].includes(status) };
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
        method: request.operation === 'domains' ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
          ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        redirect: 'manual',
        signal: context.signal,
      });
      context.httpStatus = response.status;
      context.retryAllowed =
        response.status === 200 || httpError(response.status, request.operation).retry;
      const id = response.headers.get('x-request-id');
      if (id?.trim()) context.requestId = safe(id);
      // The entire 402 body can contain newly generated credentials, even its message.
      if (response.status === 402) {
        await response.body?.cancel();
        return {
          outcome: failure(
            new AppError('QUOTA_EXCEEDED', 'anysearchQuota', {
              provider: 'anysearch',
              http_status: 402,
              ...(context.requestId ? { request_id: context.requestId } : {}),
            }),
            language,
          ),
          retry: false,
        };
      }
      bytes = await response.arrayBuffer();
    } catch (error) {
      const mapped = transportError(error, context, 'anysearch', 'anysearchNetwork', safe);
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
      if (!isObject(body) || typeof body.code !== 'number' || !Number.isFinite(body.code))
        return invalid();
      if (body.code === 0) {
        let data: DataByOperation[Operation];
        switch (request.operation) {
          case 'search':
            data = searchData(body.data, request.body!.max_results as number);
            break;
          case 'domains':
            data = domainsData(body.data);
            break;
          case 'extract':
            data = extractData(body.data);
            break;
        }
        return { outcome: success(data as DataByOperation[O]), retry: false };
      }
    }
    const mapped = httpError(response.status, request.operation);
    context.retryAllowed = mapped.retry;
    const details: JsonObject = { provider: 'anysearch', http_status: response.status };
    if (context.requestId) details.request_id = context.requestId;
    if (mapped.code === 'TIMEOUT') details.timeout_scope = 'request';
    const validBody =
      isObject(body) &&
      typeof body.code === 'number' &&
      Number.isFinite(body.code) &&
      typeof body.message === 'string' &&
      Boolean(body.message.trim());
    if (isObject(body)) {
      if (typeof body.error_code === 'string' && body.error_code.trim())
        details.upstream_code = safe(body.error_code);
      if (typeof body.message === 'string' && body.message.trim())
        details.upstream_message = safe(body.message);
    }
    if (!validBody) details.reason = 'error_body_invalid';
    const outcome = failure<DataByOperation[O]>(
      new AppError(mapped.code, mapped.key, details),
      language,
    );
    if (outcome.result.error) {
      if (details.upstream_message === outcome.result.error.message)
        delete details.upstream_message;
      if (!validBody)
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
    const outcome = failure<DataByOperation[O]>(error, language);
    if (context.requestId && outcome.result.error)
      outcome.result.error.details = {
        ...outcome.result.error.details,
        request_id: context.requestId,
      };
    return { outcome, retry: false };
  }
}
