import { fieldAt, isObject } from '../config/fields.js';
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

export type Operation = 'library' | 'docs';
export const operations: OperationDefinition[] = ['library', 'docs'].map((operation) => ({
  provider: 'ctx7',
  operation,
  required: ['providers.ctx7.base_url', 'execution.timeout_seconds', 'execution.retries'],
  optional: ['providers.ctx7.api_key'],
}));
export const requestLimit = 30;
export interface Request {
  operation: Operation;
  url: string;
  libraryId?: string;
  apiKey?: string;
  secrets: string[];
  timeout: number;
  retries: number;
}
export type Library = JsonObject & {
  id: string;
  title?: string;
  description?: string;
  versions?: string[];
  total_snippets?: number;
  trust_score?: number;
  benchmark_score?: number;
  state?: string;
};
export type LibraryData = {
  provider: 'ctx7';
  results: Library[];
  search_filter_applied?: boolean;
};
export type CodeSnippet = JsonObject & {
  url: string;
  title?: string;
  description?: string;
  examples?: { language?: string; code: string }[];
  is_dynamic?: boolean;
  source_file?: string;
};
export type InfoSnippet = JsonObject & { content: string; url?: string; breadcrumb?: string };
export type DocsData = {
  provider: 'ctx7';
  library_id: string;
  code_snippets: CodeSnippet[];
  info_snippets: InfoSnippet[];
  rules?: { global?: string[]; library_own?: string[]; library_team?: string[] };
};
export type Data = LibraryData | DocsData;

export function validLibraryId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^\/[^/]+\/[^/]+([/@][^/]+)?$/.test(value) && !/\s/u.test(value)
  );
}
export function prepare(
  operation: Operation,
  target: string,
  query: string,
  timeout: number | undefined,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): Request {
  for (const [value, option] of [
    [target, operation === 'library' ? 'NAME' : 'LIBRARY_ID'],
    [query, 'QUERY'],
  ]) {
    if (!value.trim() || [...value].length > 500)
      throw new AppError('INVALID_ARGUMENT', 'ctx7Input', { option });
  }
  if (operation === 'docs' && !validLibraryId(target))
    throw new AppError('INVALID_ARGUMENT', 'ctx7InvalidId', { option: 'LIBRARY_ID' });
  const settings = operationConfig(
    values,
    env,
    language,
    operations.find((item) => item.operation === operation)!,
    timeout === undefined
      ? {}
      : {
          'execution.timeout_seconds': {
            field: fieldAt('execution.timeout_seconds'),
            value: timeout,
            source: 'cli',
            problems: [],
          },
        },
  );
  const base = (settings['providers.ctx7.base_url'].value as string).replace(/\/+$/, '');
  const url = new URL(`${base}${operation === 'library' ? '/v2/libs/search' : '/v2/context'}`);
  url.searchParams.set(operation === 'library' ? 'libraryName' : 'libraryId', target);
  url.searchParams.set('query', query);
  if (operation === 'docs') url.searchParams.set('type', 'json');
  url.searchParams.set('fast', 'false');
  return {
    operation,
    url: url.href,
    ...(operation === 'docs' ? { libraryId: target } : {}),
    apiKey: settings['providers.ctx7.api_key'].value as string | undefined,
    secrets: configuredSecrets(values, env),
    timeout: settings['execution.timeout_seconds'].value as number,
    retries: settings['execution.retries'].value as number,
  };
}
function invalid(): never {
  throw new AppError('INVALID_RESPONSE', 'ctx7Response', { provider: 'ctx7', http_status: 200 });
}
function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : invalid();
}
function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return invalid();
  return value.trim() ? value : undefined;
}
function requiredText(value: unknown): string | undefined {
  if (typeof value !== 'string') return invalid();
  return optionalText(value);
}
function strings(value: unknown, allowBlank: boolean): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return invalid();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || (!allowBlank && !item.trim())) return invalid();
    if (item.trim()) result.push(item);
  }
  return result.length ? result : undefined;
}
export function libraryData(value: unknown): LibraryData {
  const body = object(value);
  if (!Array.isArray(body.results) || typeof body.searchFilterApplied !== 'boolean')
    return invalid();
  const results = body.results.map((entry): Library => {
    const item = object(entry);
    if (!validLibraryId(item.id)) return invalid();
    const result: Library = { id: item.id };
    for (const key of ['title', 'description', 'state'] as const) {
      const value = optionalText(item[key]);
      if (value !== undefined) result[key] = value;
    }
    if (result.title === result.description) delete result.description;
    const versions = strings(item.versions, false);
    if (versions) result.versions = versions;
    for (const [source, target, max, integer] of [
      ['totalSnippets', 'total_snippets', Number.MAX_SAFE_INTEGER, true],
      ['trustScore', 'trust_score', 10, false],
      ['benchmarkScore', 'benchmark_score', 100, false],
    ] as const) {
      const value = item[source];
      if (value === undefined || value === null) continue;
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > max ||
        (integer && !Number.isSafeInteger(value))
      )
        return invalid();
      result[target] = value;
    }
    return result;
  });
  return {
    provider: 'ctx7',
    results,
    ...(body.searchFilterApplied ? { search_filter_applied: true } : {}),
  };
}
export function docsData(value: unknown, libraryId: string): DocsData {
  const body = object(value);
  if (!Array.isArray(body.codeSnippets) || !Array.isArray(body.infoSnippets)) return invalid();
  const code_snippets = body.codeSnippets.map((entry): CodeSnippet => {
    const item = object(entry);
    const title = requiredText(item.codeTitle);
    const description = requiredText(item.codeDescription);
    if (!validPageUrl(item.codeId) || !Array.isArray(item.codeList)) return invalid();
    const examples = item.codeList.map((entry) => {
      const example = object(entry);
      const language = requiredText(example.language);
      const code = requiredText(example.code);
      if (!code) return invalid();
      return { ...(language ? { language } : {}), code };
    });
    if (!examples.length && !description) return invalid();
    const result: CodeSnippet = { url: item.codeId };
    if (title && (examples.length || title !== description)) result.title = title;
    if (description && (!examples.length || title !== description))
      result.description = description;
    if (examples.length) result.examples = examples;
    if (item.isDynamic !== undefined && item.isDynamic !== null) {
      if (typeof item.isDynamic !== 'boolean') return invalid();
      if (item.isDynamic) result.is_dynamic = true;
    }
    const source = optionalText(item.sourceFile);
    if (source) result.source_file = source;
    return result;
  });
  const info_snippets = body.infoSnippets.map((entry): InfoSnippet => {
    const item = object(entry);
    const content = requiredText(item.content);
    if (!content) return invalid();
    const result: InfoSnippet = { content };
    if (item.pageId !== undefined && item.pageId !== null) {
      if (!validPageUrl(item.pageId)) return invalid();
      result.url = item.pageId;
    }
    const breadcrumb = optionalText(item.breadcrumb);
    if (breadcrumb) result.breadcrumb = breadcrumb;
    return result;
  });
  const result: DocsData = {
    provider: 'ctx7',
    library_id: libraryId,
    code_snippets,
    info_snippets,
  };
  if (body.rules !== undefined && body.rules !== null) {
    const rules = object(body.rules);
    const mapped: NonNullable<DocsData['rules']> = {};
    for (const [source, target] of [
      ['global', 'global'],
      ['libraryOwn', 'library_own'],
      ['libraryTeam', 'library_team'],
    ] as const) {
      const entries = strings(rules[source], true);
      if (entries) mapped[target] = entries;
    }
    if (Object.keys(mapped).length) result.rules = mapped;
  }
  return result;
}
function httpError(
  status: number,
  operation: Operation,
  tag?: string,
): { code: AppError['code']; key: MessageKey; retry: boolean } {
  const common: Record<number, [AppError['code'], MessageKey]> = {
    400: ['INVALID_ARGUMENT', 'ctx7Argument'],
    401: ['AUTHENTICATION_ERROR', 'ctx7Auth'],
    402: ['QUOTA_EXCEEDED', 'ctx7Quota'],
    403: ['ACCESS_DENIED', 'ctx7Access'],
    408: ['TIMEOUT', 'requestTimeout'],
    504: ['TIMEOUT', 'requestTimeout'],
    429: ['RATE_LIMITED', 'ctx7Rate'],
  };
  const unavailable: Record<number, string[]> = {
    202: ['library_not_finalized'],
    404: ['library_not_found', 'tag_not_found', 'no_snippets_found'],
    422: ['library_too_large', 'no_code_found'],
  };
  let mapped = common[status];
  if (!mapped) {
    if (operation === 'docs' && unavailable[status]?.includes(tag ?? ''))
      mapped = ['CONTENT_UNAVAILABLE', 'ctx7Unavailable'];
    else if (status === 301 && tag === 'library_redirected')
      mapped = ['UPSTREAM_ERROR', 'ctx7Redirect'];
    else mapped = ['UPSTREAM_ERROR', 'ctx7Upstream'];
  }
  const [code, key] = mapped;
  return { code, key, retry: [408, 429, 500, 502, 503, 504].includes(status) };
}
export async function request(
  request: Request,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<Data>> {
  const safe = (value: string) => redactDiagnostics(value, request.secrets) as string;
  try {
    let response: Response;
    let bytes: ArrayBuffer;
    try {
      response = await transport(request.url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
        },
        redirect: 'manual',
        signal: context.signal,
      });
      context.httpStatus = response.status;
      context.retryAllowed =
        response.status === 200 || httpError(response.status, request.operation).retry;
      const id = [
        response.headers.get('x-request-id'),
        response.headers.get('x-context7-request-id'),
      ].find((value) => value?.trim());
      if (id) context.requestId = safe(id);
      bytes = await response.arrayBuffer();
    } catch (error) {
      const mapped = transportError(error, context, 'ctx7', 'ctx7Network', safe);
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
    if (response.status === 200)
      return {
        outcome: success(
          request.operation === 'library' ? libraryData(body) : docsData(body, request.libraryId!),
        ),
        retry: false,
      };
    const details: JsonObject = { provider: 'ctx7', http_status: response.status };
    let invalidBody = false;
    for (const [source, target] of [
      ['error', 'upstream_code'],
      ['message', 'upstream_message'],
    ] as const) {
      const value = isObject(body) ? body[source] : undefined;
      if (typeof value !== 'string' || !value.trim()) invalidBody = true;
      else details[target] = safe(value);
    }
    const tag = isObject(body) && typeof body.error === 'string' ? body.error : undefined;
    if (tag === 'library_redirected' && isObject(body)) {
      if (validLibraryId(body.redirectUrl)) details.redirect_library_id = safe(body.redirectUrl);
      else invalidBody = true;
    }
    const mapped = httpError(response.status, request.operation, tag);
    if (mapped.code === 'TIMEOUT') details.timeout_scope = 'request';
    if (context.requestId) details.request_id = context.requestId;
    if (invalidBody) details.reason = 'error_body_invalid';
    const outcome = failure<Data>(new AppError(mapped.code, mapped.key, details), language);
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
    const outcome = failure<Data>(error, language);
    if (context.requestId && outcome.result.error)
      outcome.result.error.details = {
        ...outcome.result.error.details,
        request_id: context.requestId,
      };
    return { outcome, retry: false };
  }
}
