import { fieldAt, isObject } from '../config/fields.js';
import { operationConfig } from '../config/status.js';
import type { OperationDefinition } from '../config/status.js';
import { AppError, failure } from '../errors.js';
import type { AttemptContext, AttemptResult } from '../execution.js';
import type { Language } from '../i18n/messages.js';
import type { JsonObject, PublicError } from '../result.js';
import { validPageUrl } from './firecrawl-response.js';
import { configuredSecrets, redactSecrets } from './transport.js';
import { callTool, McpError } from './zhipu-mcp-http.js';
import { toolResult } from './zhipu-mcp-response.js';
import type { Data, Operation } from './zhipu-mcp-response.js';
export type { Data, FetchData, ToolData, ToolContent, Operation } from './zhipu-mcp-response.js';

const tools = {
  search: { name: 'webSearchPrime', endpoint: 'web_search_prime' },
  fetch: { name: 'webReader', endpoint: 'web_reader' },
  docs: { name: 'search_doc', endpoint: 'zread' },
  tree: { name: 'get_repo_structure', endpoint: 'zread' },
  'read-file': { name: 'read_file', endpoint: 'zread' },
} as const;
export const operations: OperationDefinition[] = Object.keys(tools).map((operation) => ({
  provider: 'zhipu-mcp',
  operation,
  required: [
    'providers.zhipu-mcp.api_key',
    'providers.zhipu-mcp.platform',
    'providers.zhipu-mcp.base_url',
    'execution.timeout_seconds',
    'execution.retries',
  ],
}));
export const requestLimits = { search: 30, fetch: 60, docs: 60, tree: 60, 'read-file': 60 };
export interface Request {
  operation: Operation;
  target: string;
  path?: string;
  url: string;
  tool: string;
  arguments: JsonObject;
  apiKey: string;
  secrets: string[];
  timeout: number;
  retries: number;
}
export interface Options {
  query?: string;
  path?: string;
  timeout?: number;
}

export function prepare(
  operation: Operation,
  target: string,
  options: Options,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): Request {
  const args: JsonObject = {};
  if (operation === 'search' || operation === 'docs') {
    const query = operation === 'search' ? target : options.query;
    if (!query?.trim()) throw new AppError('INVALID_ARGUMENT', 'emptyQuery', { option: 'QUERY' });
    args[operation === 'search' ? 'search_query' : 'query'] = query;
  }
  if (operation === 'fetch') {
    if (!validPageUrl(target))
      throw new AppError('INVALID_ARGUMENT', 'invalidPageUrl', { option: 'URL' });
    args.url = target;
  }
  if (['docs', 'tree', 'read-file'].includes(operation)) {
    if (!/^[^/]+\/[^/]+$/u.test(target) || /[\s\p{Cc}?#]/u.test(target))
      throw new AppError('INVALID_ARGUMENT', 'mcpRepoInvalid', { option: 'REPO' });
    args.repo_name = target;
  }
  if (operation === 'read-file' || (operation === 'tree' && options.path !== undefined)) {
    if (!options.path?.trim() || /\p{Cc}/u.test(options.path))
      throw new AppError('INVALID_ARGUMENT', 'mcpPathInvalid', {
        option: operation === 'tree' ? '--path' : 'PATH',
      });
    args[operation === 'tree' ? 'dir_path' : 'file_path'] = options.path;
  }
  const settings = operationConfig(
    values,
    env,
    language,
    operations.find((item) => item.operation === operation)!,
    options.timeout === undefined
      ? {}
      : {
          'execution.timeout_seconds': {
            field: fieldAt('execution.timeout_seconds'),
            value: options.timeout,
            source: 'cli',
            problems: [],
          },
        },
  );
  return {
    operation,
    target,
    ...(options.path === undefined ? {} : { path: options.path }),
    url: `${(settings['providers.zhipu-mcp.base_url'].value as string).replace(/\/+$/, '')}/${tools[operation].endpoint}/mcp`,
    tool: tools[operation].name,
    arguments: args,
    apiKey: settings['providers.zhipu-mcp.api_key'].value as string,
    secrets: configuredSecrets(values, env),
    timeout: settings['execution.timeout_seconds'].value as number,
    retries: settings['execution.retries'].value as number,
  };
}

function redactFields(value: JsonObject, fields: readonly string[], secrets: string[]): JsonObject {
  const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
  const result = redactSecrets(extra, secrets);
  for (const key of fields)
    if (Object.hasOwn(value, key)) result[key] = redactSecrets(value[key], secrets);
  return result;
}

function redactBlock(block: JsonObject, secrets: string[]): JsonObject {
  const result = redactFields(
    block,
    [
      'type',
      'text',
      'data',
      'mimeType',
      'uri',
      'name',
      'title',
      'description',
      'size',
      'icons',
      'resource',
      'annotations',
      '_meta',
    ],
    secrets,
  );
  // Validated protocol tags and field names are not copies of credentials.
  result.type = block.type;
  if (block.type === 'resource' && isObject(block.resource))
    result.resource = redactFields(
      block.resource as JsonObject,
      ['uri', 'text', 'blob', 'mimeType', '_meta'],
      secrets,
    );
  if (isObject(block.annotations)) {
    const annotations = redactFields(
      block.annotations as JsonObject,
      ['audience', 'priority', 'lastModified'],
      secrets,
    );
    if (Array.isArray(block.annotations.audience))
      annotations.audience = [...block.annotations.audience];
    result.annotations = annotations;
  }
  return result;
}

function redactData(data: Data, secrets: string[]): Data {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (key === 'provider') return [key, value];
      if (key === 'content')
        return [key, data.content!.map((block) => redactBlock(block, secrets))];
      if (key === 'results' && 'results' in data)
        return [
          key,
          data.results.map((page) =>
            Object.fromEntries(
              Object.entries(page).map(([field, item]) => [field, redactSecrets(item, secrets)]),
            ),
          ),
        ];
      return [key, redactSecrets(value, secrets)];
    }),
  ) as Data;
}

function redactToolError(error: PublicError, secrets: string[]): PublicError {
  const result: PublicError = {
    ...error,
    message: redactSecrets(error.message, secrets),
  };
  const details = error.details;
  if (!details) return result;
  result.details = Object.fromEntries(
    Object.entries(details).map(([key, value]) => {
      if (key === 'provider') return [key, value];
      if (key === 'causes')
        return [key, details.causes!.map((cause) => redactToolError(cause, secrets))];
      if (key === 'upstream_content')
        return [key, (value as JsonObject[]).map((block) => redactBlock(block, secrets))];
      return [key, redactSecrets(value, secrets)];
    }),
  );
  return result;
}

export async function request(
  request: Request,
  context: AttemptContext,
  language: Language,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<Data>> {
  try {
    const { result, secrets } = await callTool(request, context, transport);
    const outcome = toolResult(result, request, language);
    if (outcome.result.data) outcome.result.data = redactData(outcome.result.data, secrets);
    if (outcome.result.error) {
      context.retryAllowed = false;
      outcome.result.error = redactToolError(
        {
          ...outcome.result.error,
          details: {
            ...outcome.result.error.details,
            ...(context.httpStatus === undefined ? {} : { http_status: context.httpStatus }),
            ...(context.requestId ? { request_id: context.requestId } : {}),
          },
        },
        secrets,
      );
    }
    return { outcome, retry: false };
  } catch (error) {
    context.signal.throwIfAborted();
    const retry = error instanceof McpError && error.retry;
    context.retryAllowed = retry;
    return {
      outcome: failure<Data>(error, language),
      retry,
      ...(error instanceof McpError && error.retryAfter !== undefined
        ? { retryAfter: error.retryAfter }
        : {}),
    };
  }
}
