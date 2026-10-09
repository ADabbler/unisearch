import { AppError } from '../errors.js';
import { isDeepStrictEqual } from 'node:util';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import type { JsonObject, JsonValue } from '../result.js';

// Registry order is shared by service lists in configuration and the CLI.
const providerEnvironments = {
  model: 'UNISEARCH_MODEL',
  exa: 'UNISEARCH_EXA',
  tavily: 'UNISEARCH_TAVILY',
  firecrawl: 'UNISEARCH_FIRECRAWL',
  ctx7: 'UNISEARCH_CTX7',
  jina: 'UNISEARCH_JINA',
  zhipu: 'UNISEARCH_ZHIPU',
  'zhipu-mcp': 'UNISEARCH_ZHIPU_MCP',
  anysearch: 'UNISEARCH_ANYSEARCH',
  tinyfish: 'UNISEARCH_TINYFISH',
};
export type Provider = keyof typeof providerEnvironments;
export const providers = Object.keys(providerEnvironments) as Provider[];

export interface Field {
  path: string;
  kind:
    | 'boolean'
    | 'credential'
    | 'integer'
    | 'providers'
    | 'language'
    | 'url'
    | 'searchType'
    | 'token'
    | 'protocol'
    | 'models'
    | 'tools';
  choices?: readonly JsonValue[];
  variants?: {
    field: string;
    cases: Record<string, Pick<Field, 'default' | 'choices' | 'invalidMessage'>>;
  };
  invalidMessage?: MessageKey;
  environment?: string;
  default?: JsonValue;
  minimum?: number;
  maximum?: number;
  supported?: readonly Provider[];
}

export const fields: readonly Field[] = [
  {
    path: 'providers.zhipu.platform',
    kind: 'token',
    default: 'bigmodel',
    choices: ['bigmodel', 'zai'],
    invalidMessage: 'zhipuPlatform',
    environment: 'UNISEARCH_ZHIPU_PLATFORM',
  },
  {
    path: 'providers.zhipu.base_url',
    kind: 'url',
    environment: 'UNISEARCH_ZHIPU_BASE_URL',
    variants: {
      field: 'providers.zhipu.platform',
      cases: {
        bigmodel: { default: 'https://open.bigmodel.cn/api/paas/v4' },
        zai: { default: 'https://api.z.ai/api/paas/v4' },
      },
    },
  },
  {
    path: 'providers.zhipu.search.engine',
    kind: 'token',
    choices: ['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark', 'search-prime'],
    invalidMessage: 'zhipuEngine',
    variants: {
      field: 'providers.zhipu.platform',
      cases: {
        bigmodel: {
          default: 'search_std',
          choices: ['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'],
        },
        zai: { default: 'search-prime', choices: ['search-prime'] },
      },
    },
  },
  {
    path: 'providers.zhipu.search.limit',
    kind: 'integer',
    minimum: 1,
    maximum: 50,
    default: 10,
    invalidMessage: 'zhipuLimit',
    variants: {
      field: 'providers.zhipu.search.engine',
      cases: {
        search_pro_sogou: {
          default: 10,
          choices: [10, 20, 30, 40, 50],
          invalidMessage: 'zhipuSogouLimit',
        },
        search_pro_quark: {
          default: undefined,
          choices: [],
          invalidMessage: 'zhipuCountUnsupported',
        },
      },
    },
  },
  { path: 'providers.model.base_url', kind: 'url', environment: 'UNISEARCH_MODEL_BASE_URL' },
  {
    path: 'providers.model.protocol',
    kind: 'protocol',
    default: 'responses',
    environment: 'UNISEARCH_MODEL_PROTOCOL',
  },
  { path: 'providers.model.model.id', kind: 'token', environment: 'UNISEARCH_MODEL_ID' },
  { path: 'providers.model.model.effort', kind: 'token', environment: 'UNISEARCH_MODEL_EFFORT' },
  { path: 'providers.model.fallback_models', kind: 'models', default: [] },
  { path: 'providers.model.tools', kind: 'tools', default: [] },
  {
    path: 'providers.model.stream',
    kind: 'boolean',
    default: false,
    environment: 'UNISEARCH_MODEL_STREAM',
  },
  {
    path: 'providers.exa.base_url',
    kind: 'url',
    default: 'https://api.exa.ai',
    environment: 'UNISEARCH_EXA_BASE_URL',
  },
  { path: 'providers.exa.search.limit', kind: 'integer', minimum: 1, maximum: 100, default: 5 },
  { path: 'providers.exa.search.search_type', kind: 'searchType', default: 'auto' },
  {
    path: 'providers.zhipu-mcp.platform',
    kind: 'token',
    choices: ['bigmodel', 'zai'],
    default: 'bigmodel',
    invalidMessage: 'zhipuPlatform',
    environment: 'UNISEARCH_ZHIPU_MCP_PLATFORM',
  },
  {
    path: 'providers.zhipu-mcp.base_url',
    kind: 'url',
    environment: 'UNISEARCH_ZHIPU_MCP_BASE_URL',
    variants: {
      field: 'providers.zhipu-mcp.platform',
      cases: {
        bigmodel: { default: 'https://open.bigmodel.cn/api/mcp' },
        zai: { default: 'https://api.z.ai/api/mcp' },
      },
    },
  },
  {
    path: 'providers.ctx7.base_url',
    kind: 'url',
    default: 'https://context7.com/api',
    environment: 'UNISEARCH_CTX7_BASE_URL',
  },
  {
    path: 'providers.jina.reader_url',
    kind: 'url',
    default: 'https://r.jina.ai',
    environment: 'UNISEARCH_JINA_READER_URL',
  },
  {
    path: 'providers.jina.search_url',
    kind: 'url',
    default: 'https://s.jina.ai',
    environment: 'UNISEARCH_JINA_SEARCH_URL',
  },
  {
    path: 'providers.jina.search.limit',
    kind: 'integer',
    minimum: 1,
    maximum: 20,
    default: 5,
    invalidMessage: 'jinaLimitInvalid',
  },
  {
    path: 'providers.anysearch.base_url',
    kind: 'url',
    default: 'https://api.anysearch.com',
    environment: 'UNISEARCH_ANYSEARCH_BASE_URL',
  },
  {
    path: 'providers.anysearch.search.limit',
    kind: 'integer',
    minimum: 1,
    maximum: 10,
    default: 5,
    invalidMessage: 'anysearchLimit',
  },
  {
    path: 'providers.tinyfish.search_url',
    kind: 'url',
    default: 'https://api.search.tinyfish.ai',
    environment: 'UNISEARCH_TINYFISH_SEARCH_URL',
  },
  {
    path: 'providers.tinyfish.fetch_url',
    kind: 'url',
    default: 'https://api.fetch.tinyfish.ai',
    environment: 'UNISEARCH_TINYFISH_FETCH_URL',
  },
  {
    path: 'providers.tavily.base_url',
    kind: 'url',
    default: 'https://api.tavily.com',
    environment: 'UNISEARCH_TAVILY_BASE_URL',
  },
  {
    path: 'providers.tavily.search.limit',
    kind: 'integer',
    minimum: 1,
    maximum: 20,
    default: 5,
    invalidMessage: 'tavilyLimit',
  },
  {
    path: 'providers.tavily.search.search_depth',
    kind: 'token',
    choices: ['basic', 'advanced', 'fast', 'ultra-fast'],
    default: 'basic',
    invalidMessage: 'tavilySearchDepth',
  },
  {
    path: 'providers.tavily.extract.extract_depth',
    kind: 'token',
    choices: ['basic', 'advanced'],
    default: 'basic',
    invalidMessage: 'tavilyExtractDepth',
  },
  { path: 'providers.tavily.map.limit', kind: 'integer', minimum: 1, default: 50 },
  {
    path: 'providers.firecrawl.base_url',
    kind: 'url',
    default: 'https://api.firecrawl.dev/v2',
    environment: 'UNISEARCH_FIRECRAWL_BASE_URL',
  },
  {
    path: 'providers.firecrawl.search.limit',
    kind: 'integer',
    minimum: 1,
    maximum: 100,
    default: 5,
  },
  {
    path: 'providers.firecrawl.map.limit',
    kind: 'integer',
    minimum: 1,
    maximum: 100000,
    default: 50,
    invalidMessage: 'invalidMapLimit',
  },
  {
    path: 'providers.firecrawl.map.sitemap',
    kind: 'token',
    choices: ['include', 'skip', 'only'],
    default: 'include',
    invalidMessage: 'invalidSitemap',
  },
  ...providers.flatMap((provider) => [
    {
      path: `providers.${provider}.enabled`,
      kind: 'boolean' as const,
      default: true,
    },
    {
      path: `providers.${provider}.api_key`,
      kind: 'credential' as const,
      environment: `${providerEnvironments[provider]}_API_KEY`,
    },
  ]),
  {
    path: 'fetch.providers',
    kind: 'providers',
    default: ['firecrawl', 'exa', 'tavily', 'jina', 'zhipu', 'zhipu-mcp', 'tinyfish', 'anysearch'],
    supported: [
      'exa',
      'anysearch',
      'tavily',
      'jina',
      'zhipu',
      'zhipu-mcp',
      'firecrawl',
      'tinyfish',
    ],
  },
  {
    path: 'map.providers',
    kind: 'providers',
    default: ['tavily', 'firecrawl'],
    supported: ['tavily', 'firecrawl'],
  },
  {
    path: 'execution.timeout_seconds',
    kind: 'integer',
    minimum: 1,
    default: 300,
    environment: 'UNISEARCH_TIMEOUT_SECONDS',
  },
  {
    path: 'execution.retries',
    kind: 'integer',
    minimum: 0,
    default: 2,
    environment: 'UNISEARCH_RETRIES',
  },
  { path: 'execution.fallback', kind: 'boolean', default: true, environment: 'UNISEARCH_FALLBACK' },
  { path: 'language', kind: 'language', default: 'auto', environment: 'UNISEARCH_LANG' },
];

export const sections = new Set(
  fields.flatMap((field) => {
    const parts = field.path.split('.');
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('.'));
  }),
);

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function within(path: string, scope: string): boolean {
  return !scope || path === scope || path.startsWith(`${scope}.`);
}

export function knownPath(path: string): boolean {
  return sections.has(path) || fields.some((field) => field.path === path);
}

export function knownAncestor(path: string): string | undefined {
  const parts = path.split('.');
  while (parts.length) {
    const key = parts.join('.');
    if (knownPath(key)) return key;
    parts.pop();
  }
  return undefined;
}

export function invalidKey(path: string): AppError {
  const field = knownAncestor(path);
  return new AppError('INVALID_ARGUMENT', 'unknownField', field ? { field } : undefined);
}

export function fieldAt(path: string): Field {
  const field = fields.find((field) => field.path === path);
  if (!field) throw invalidKey(path);
  return field;
}

export function valueAt(values: Record<string, unknown>, path: string): unknown {
  let value: unknown = values;
  for (const part of path.split('.')) {
    if (!isObject(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

export function putValue(values: JsonObject, path: string, value: JsonValue): void {
  const parts = path.split('.');
  const leaf = parts.pop()!;
  let parent = values;
  for (const part of parts) {
    if (!Object.hasOwn(parent, part))
      Object.defineProperty(parent, part, {
        value: {},
        enumerable: true,
        writable: true,
        configurable: true,
      });
    parent = parent[part] as JsonObject;
  }
  Object.defineProperty(parent, leaf, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export type ProblemCode =
  | 'UNKNOWN_FIELD'
  | 'INVALID_TYPE'
  | 'INVALID_VALUE'
  | 'MISSING_REQUIRED'
  | 'UNKNOWN_PROVIDER'
  | 'UNSUPPORTED_OPERATION';
export interface Problem {
  field?: string;
  source: string;
  environment?: string;
  code: ProblemCode;
  message: MessageKey;
}

type Invalid = Pick<Problem, 'code' | 'message'>;

export type ModelCandidate = JsonObject & { id: string; effort?: string };
export function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/u.test(value);
}
export function modelIdentity(model: ModelCandidate): string {
  return JSON.stringify([model.id, model.effort === 'default' ? undefined : model.effort]);
}
export function expandTools(value: JsonValue[]): JsonObject[] {
  return value.map((item) => (typeof item === 'string' ? { type: item } : (item as JsonObject)));
}

export function hasNonfiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonfiniteNumber);
  return isObject(value) && Object.values(value).some(hasNonfiniteNumber);
}

export function validate(field: Field, value: unknown): Invalid | undefined {
  if (field.choices && !field.choices.includes(value as JsonValue))
    return { code: 'INVALID_VALUE', message: field.invalidMessage! };
  switch (field.kind) {
    case 'token':
      if (!token(value)) return { code: 'INVALID_VALUE', message: 'invalidToken' };
      break;
    case 'protocol':
      if (value !== 'responses' && value !== 'chat-completions')
        return { code: 'INVALID_VALUE', message: 'invalidProtocol' };
      break;
    case 'models': {
      if (
        !Array.isArray(value) ||
        value.some(
          (item) =>
            !isObject(item) ||
            !token(item.id) ||
            (item.effort !== undefined && !token(item.effort)) ||
            Object.keys(item).some((key) => key !== 'id' && key !== 'effort'),
        )
      )
        return { code: 'INVALID_VALUE', message: 'invalidModels' };
      const identities = value.map((item) => modelIdentity(item as ModelCandidate));
      if (new Set(identities).size !== identities.length)
        return { code: 'INVALID_VALUE', message: 'duplicateModel' };
      break;
    }
    case 'tools': {
      if (hasNonfiniteNumber(value)) return { code: 'INVALID_VALUE', message: 'nonfiniteConfig' };
      if (
        !Array.isArray(value) ||
        value.some((item) =>
          typeof item === 'string' ? !token(item) : !isObject(item) || !token(item.type),
        )
      )
        return { code: 'INVALID_VALUE', message: 'invalidTools' };
      const expanded = expandTools(value);
      if (
        expanded.some((item, index) =>
          expanded.slice(0, index).some((other) => isDeepStrictEqual(item, other)),
        )
      )
        return { code: 'INVALID_VALUE', message: 'duplicateTool' };
      break;
    }
    case 'url': {
      if (typeof value !== 'string' || /[\s?#]/u.test(value) || !/^https?:\/\//.test(value))
        return { code: 'INVALID_VALUE', message: 'invalidBaseUrl' };
      try {
        const url = new URL(value);
        if (!url.hostname || url.username || url.password || value.split('/')[2].includes('@'))
          return { code: 'INVALID_VALUE', message: 'invalidBaseUrl' };
      } catch {
        return { code: 'INVALID_VALUE', message: 'invalidBaseUrl' };
      }
      break;
    }
    case 'searchType':
      if (value !== 'auto' && value !== 'fast' && value !== 'instant')
        return { code: 'INVALID_VALUE', message: 'invalidSearchType' };
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return { code: 'INVALID_TYPE', message: 'booleanRequired' };
      break;
    case 'credential':
      if (typeof value !== 'string') return { code: 'INVALID_TYPE', message: 'stringRequired' };
      if (!value.length) return { code: 'INVALID_VALUE', message: 'credentialEmpty' };
      if (/\s/u.test(value)) return { code: 'INVALID_VALUE', message: 'credentialWhitespace' };
      break;
    case 'integer':
      if (
        field.maximum !== undefined &&
        (typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value < field.minimum! ||
          value > field.maximum)
      )
        return { code: 'INVALID_VALUE', message: field.invalidMessage ?? 'invalidLimit' };
      if (typeof value !== 'number')
        return {
          code: 'INVALID_TYPE',
          message: field.minimum === 0 ? 'nonnegativeInteger' : 'positiveInteger',
        };
      if (!Number.isSafeInteger(value) || value < field.minimum!)
        return {
          code: 'INVALID_VALUE',
          message: field.minimum === 0 ? 'nonnegativeInteger' : 'positiveInteger',
        };
      break;
    case 'language':
      if (value !== 'zh' && value !== 'en' && value !== 'auto')
        return { code: 'INVALID_VALUE', message: 'invalidLanguage' };
      break;
    case 'providers':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
        return { code: 'INVALID_TYPE', message: 'providerArray' };
      if (value.some((item) => !Object.hasOwn(providerEnvironments, item)))
        return { code: 'UNKNOWN_PROVIDER', message: 'unknownProvider' };
      if (value.some((item) => !field.supported!.includes(item)))
        return { code: 'UNSUPPORTED_OPERATION', message: 'unsupportedProvider' };
      if (new Set(value).size !== value.length)
        return { code: 'INVALID_VALUE', message: 'duplicateProvider' };
      break;
  }
}

export function parseLiteral(field: Field, input: string): unknown {
  if (field.kind === 'boolean') {
    if (input === 'true') return true;
    if (input === 'false') return false;
    return input;
  }
  if (field.kind === 'integer') return /^(?:0|[1-9][0-9]*)$/.test(input) ? Number(input) : input;
  if (['providers', 'models', 'tools'].includes(field.kind)) {
    try {
      return JSON.parse(input);
    } catch {
      return input;
    }
  }
  return input;
}

export function parseInput(field: Field, input: string): JsonValue {
  const value = parseLiteral(field, input);
  const invalid = validate(field, value);
  if (invalid)
    throw new AppError('INVALID_ARGUMENT', invalid.message, {
      field: field.path,
      reason: invalid.code,
    });
  return value as JsonValue;
}

export function redact(field: Field, value: JsonValue): JsonValue {
  return field.kind === 'credential' ? '[REDACTED]' : structuredClone(value);
}

export function issue(problem: Problem, language: Language): JsonObject {
  return {
    ...(problem.field ? { field: problem.field } : {}),
    ...(problem.environment ? { environment: problem.environment } : {}),
    code: problem.code,
    message: text(language, problem.message),
  };
}

export function problemError(problem: Problem): AppError {
  return new AppError('INVALID_CONFIG', problem.message, {
    ...(problem.field ? { field: problem.field } : {}),
    source: problem.source,
    ...(problem.environment ? { environment: problem.environment } : {}),
    reason: problem.code,
  });
}

export function assertValid(problems: Problem[], language: Language): void {
  if (!problems.length) return;
  if (problems.length === 1) throw problemError(problems[0]);
  throw new AppError('INVALID_CONFIG', 'invalidFields', {
    causes: problems.map((problem) => problemError(problem).public(language)),
  });
}
