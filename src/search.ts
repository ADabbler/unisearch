import { AppError, failure } from './errors.js';
import { clock, executeRequest } from './execution.js';
import type { ExecutionClock } from './execution.js';
import { text } from './i18n/messages.js';
import type { Language } from './i18n/messages.js';
import { exaRequestLimit, prepareSearch, requestSearch } from './providers/exa.js';
import type { SearchRequest, SearchData } from './providers/exa.js';
import * as firecrawl from './providers/firecrawl.js';
import * as jina from './providers/jina.js';
import * as zhipu from './providers/zhipu.js';
import type { SearchData as ZhipuData } from './providers/zhipu-response.js';
import * as zhipuMcp from './providers/zhipu-mcp.js';
import type { SearchData as JinaData } from './providers/jina-response.js';
import * as anysearch from './providers/anysearch.js';
import * as tinyfish from './providers/tinyfish.js';
import type { SearchData as TinyfishData } from './providers/tinyfish-response.js';
import type { SearchData as FirecrawlData } from './providers/firecrawl-response.js';
import { prepareModel } from './providers/model-config.js';
import type { ModelOptions, ModelRequest } from './providers/model-config.js';
import { searchModel } from './model-search.js';
import type { ModelAnswer } from './providers/model-response.js';
import { configuredSecrets, redactDiagnostics as redact } from './providers/transport.js';
import { success } from './result.js';
import type { JsonObject, JsonValue, Outcome, PublicError } from './result.js';
import { assertValid, fieldAt, validate } from './config/fields.js';
import type { Provider } from './config/fields.js';
import { inspectConfig, resolveField } from './config/resolve.js';
import {
  prepareTavilySearch,
  requestTavilySearch,
  tavilyRequestLimits,
} from './providers/tavily.js';
import type { TavilySearchRequest, TavilySearchData } from './providers/tavily.js';
import * as deepseek from './providers/deepseek.js';
import type { SearchData as DeepseekData } from './providers/deepseek-response.js';

export interface SearchOptions extends ModelOptions {
  sources?: string;
}
export interface SearchPlan {
  sources: SourcePlan[];
  timeout: number;
  secrets: string[];
}
type SourcePlan =
  | { provider: 'model'; request: ModelRequest }
  | { provider: 'zhipu'; request: zhipu.Request<'search'> }
  | { provider: 'tinyfish'; request: tinyfish.SearchRequest }
  | { provider: 'zhipu-mcp'; request: zhipuMcp.Request }
  | { provider: 'anysearch'; request: anysearch.Request<'search'> }
  | { provider: 'exa'; request: SearchRequest }
  | { provider: 'firecrawl'; request: firecrawl.SearchRequest }
  | { provider: 'jina'; request: jina.SearchRequest }
  | { provider: 'tavily'; request: TavilySearchRequest }
  | { provider: 'deepseek'; request: deepseek.SearchRequest };
type SourceData =
  | SearchData
  | FirecrawlData
  | TavilySearchData
  | JinaData
  | anysearch.SearchData
  | ZhipuData
  | TinyfishData
  | DeepseekData
  | zhipuMcp.Data;
type SearchSource =
  | { provider: 'model'; data: ModelAnswer }
  | { provider: 'zhipu'; data: Omit<ZhipuData, 'provider'> }
  | { provider: 'tinyfish'; data: Omit<TinyfishData, 'provider'> }
  | { provider: 'zhipu-mcp'; data: Omit<zhipuMcp.ToolData, 'provider'> }
  | { provider: 'jina'; data: Omit<JinaData, 'provider'> }
  | { provider: 'anysearch'; data: Omit<anysearch.SearchData, 'provider'> }
  | { provider: 'tavily'; data: Pick<TavilySearchData, 'results'> }
  | { provider: 'exa'; data: Pick<SearchData, 'results'> }
  | { provider: 'firecrawl'; data: Pick<FirecrawlData, 'results' | 'warnings'> }
  | { provider: 'deepseek'; data: Pick<DeepseekData, 'results'> };
export type CombinedData = JsonObject & {
  sources: SearchSource[];
};

export function prepareCombinedSearch(
  query: string,
  options: SearchOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): SearchPlan {
  if (!query.trim()) throw new AppError('INVALID_ARGUMENT', 'emptyQuery');
  const field = fieldAt('search.providers');
  let selected: Exclude<Provider, 'ctx7'>[];
  if (options.sources !== undefined) {
    selected = options.sources.split(',') as Exclude<Provider, 'ctx7'>[];
    const invalid = validate(field, selected);
    if (invalid) throw new AppError('INVALID_ARGUMENT', invalid.message, { option: '--sources' });
  } else {
    const inspected = inspectConfig(values, env, 'search');
    assertValid(inspected.problems, language);
    selected = inspected.resolved[0].value as Exclude<Provider, 'ctx7'>[];
  }
  if (!selected.includes('model')) {
    for (const [key, option] of [
      ['model', '--model'],
      ['effort', '--effort'],
      ['stream', '--stream/--no-stream'],
      ['fallback', '--no-fallback'],
    ] as const) {
      if (options[key] !== undefined)
        throw new AppError('INVALID_ARGUMENT', 'modelSourceRequired', { option });
    }
  }
  const setting = resolveField(values, env, fieldAt('execution.timeout_seconds'));
  if (options.timeout === undefined) assertValid(setting.problems, language);
  const timeout = options.timeout ?? (setting.value as number);
  const sources: SourcePlan[] = selected.map((provider) => {
    switch (provider) {
      case 'model':
        return {
          provider,
          request: prepareModel(query, { ...options, timeout }, values, env, language),
        };
      case 'zhipu-mcp':
        return {
          provider,
          request: zhipuMcp.prepare('search', query, { timeout }, values, env, language),
        };
      case 'zhipu':
        return {
          provider,
          request: zhipu.prepare('search', query, { timeout }, values, env, language),
        };
      case 'tinyfish':
        return {
          provider,
          request: tinyfish.prepareSearch(query, { timeout }, values, env, language),
        };
      case 'jina':
        return { provider, request: jina.prepareSearch(query, { timeout }, values, env, language) };
      case 'anysearch':
        return {
          provider,
          request: anysearch.prepare('search', query, { timeout }, values, env, language),
        };
      case 'exa':
        return { provider, request: prepareSearch(query, { timeout }, values, env, language) };
      case 'tavily':
        return {
          provider,
          request: prepareTavilySearch(query, { timeout }, values, env, language),
        };
      case 'deepseek':
        return {
          provider,
          request: deepseek.prepareSearch(query, { timeout }, values, env, language),
        };
      case 'firecrawl':
        return {
          provider,
          request: firecrawl.prepareSearch(query, { timeout }, values, env, language),
        };
    }
  });
  return { sources, timeout, secrets: configuredSecrets(values, env) };
}

export async function combinedSearch(
  plan: SearchPlan,
  signal: AbortSignal,
  language: Language,
  record: JsonObject,
  options: { clock?: ExecutionClock; transport?: typeof fetch } = {},
): Promise<Outcome<CombinedData>> {
  const time = options.clock ?? clock;
  const started = time.now();
  const deadline = started + plan.timeout * 1000;
  const controller = new AbortController();
  const cancel = () => controller.abort(new AppError('CANCELLED', 'cancelled'));
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  const attempts: JsonObject[] = [];
  let internal: Outcome | undefined;
  const stopInternal = <T extends JsonValue>(outcome: Outcome<T>): Outcome<T> => {
    if (outcome.exitCode === 5 && !internal) {
      internal = outcome;
      controller.abort(new AppError('INTERNAL_ERROR', 'internal'));
    }
    return outcome;
  };
  const common = {
    deadline,
    timeout: plan.timeout,
    signal: controller.signal,
    language,
    clock: time,
  };
  async function sourceTask(
    source: Exclude<SourcePlan, { provider: 'model' }>,
  ): Promise<Outcome<SourceData>> {
    return stopInternal(
      await executeRequest<SourceData>(
        (context) => {
          switch (source.provider) {
            case 'zhipu':
              return zhipu.request(source.request, context, language, options.transport);
            case 'zhipu-mcp':
              return zhipuMcp.request(source.request, context, language, options.transport);
            case 'anysearch':
              return anysearch.request(source.request, context, language, options.transport);
            case 'tinyfish':
              return tinyfish.request(source.request, context, language, options.transport);
            case 'exa':
              return requestSearch(source.request, context, language, options.transport);
            case 'jina':
              return jina.request(source.request, context, language, options.transport);
            case 'tavily':
              return requestTavilySearch(source.request, context, language, options.transport);
            case 'firecrawl':
              return firecrawl.requestSearch(source.request, context, language, options.transport);
            case 'deepseek':
              return deepseek.request(source.request, context, language, options.transport);
          }
        },
        {
          ...common,
          provider: source.provider,
          retries: source.request.retries,
          requestLimit: {
            zhipu: zhipu.requestLimits.search,
            'zhipu-mcp': zhipuMcp.requestLimits.search,
            anysearch: anysearch.requestLimit,
            tinyfish: tinyfish.requestLimits.search,
            exa: exaRequestLimit,
            jina: jina.requestLimit,
            tavily: tavilyRequestLimits.search,
            firecrawl: firecrawl.requestLimits.search,
            deepseek: deepseek.requestLimits.search,
          }[source.provider],
          record: {},
          onAttempt: (entry) => {
            entry.provider = source.provider;
            attempts.push(entry);
          },
        },
      ),
    );
  }

  async function run(source: SourcePlan): Promise<Outcome<ModelAnswer | SourceData>> {
    try {
      if (source.provider === 'model')
        return stopInternal(
          await searchModel(source.request, {
            ...common,
            transport: options.transport,
            onAttempt: (entry) => attempts.push(entry),
          }),
        );
      return await sourceTask(source);
    } catch (error) {
      return stopInternal(failure(error, language));
    }
  }
  try {
    const outcomes = await Promise.all(plan.sources.map(run));
    const data: CombinedData = { sources: [] };
    for (const [index, outcome] of outcomes.entries()) {
      const content = outcome.result.data;
      if (content === undefined) continue;
      let source: SearchSource;
      if (plan.sources[index].provider === 'model') {
        const { searchedSources, ...answer } = content as ModelAnswer;
        source = { provider: 'model', data: answer };
        if (searchedSources?.length)
          record.searched_sources = redact(searchedSources, plan.secrets);
      } else {
        const { provider, ...sourceData } = content as SourceData;
        if (provider === 'firecrawl') {
          const firecrawlData = sourceData as Pick<FirecrawlData, 'results' | 'warnings'>;
          const sanitize = (message: string) => redact(message, plan.secrets) as string;
          const warnings = (items: string[]) => [...new Set(items.map(sanitize))];
          source = {
            provider,
            data: {
              ...firecrawlData,
              results: firecrawlData.results.map((item) => {
                const result = { ...item };
                if (item.warnings) result.warnings = warnings(item.warnings);
                if (item.content_error?.message)
                  result.content_error = {
                    ...item.content_error,
                    message: sanitize(item.content_error.message),
                  };
                return result;
              }),
              ...(firecrawlData.warnings ? { warnings: warnings(firecrawlData.warnings) } : {}),
            },
          };
        } else source = { provider, data: sourceData } as SearchSource;
      }
      data.sources.push(source);
    }
    const failures = outcomes.flatMap((outcome, index) => {
      const error = outcome.result.error;
      if (
        !error ||
        error.code === 'CANCELLED' ||
        (internal && error.code === 'INTERNAL_ERROR' && outcome !== internal)
      )
        return [];
      const details = { ...error.details };
      delete details.provider;
      return [
        {
          provider: plan.sources[index].provider,
          code: error.code,
          message: error.message,
          ...(Object.keys(details).length ? { details } : {}),
        },
      ];
    });
    let outcome: Outcome<CombinedData>;
    const content = data.sources.length ? { data } : {};
    if (signal.aborted || internal) {
      outcome = failure(
        new AppError(
          signal.aborted ? 'CANCELLED' : 'INTERNAL_ERROR',
          signal.aborted ? 'cancelled' : 'internal',
          failures.length ? { failures } : undefined,
        ),
        language,
      );
      Object.assign(outcome.result, content);
    } else if (outcomes.every((item) => item.result.status === 'error')) {
      const first = outcomes[0];
      outcome = {
        result: {
          status: 'error',
          ...content,
          error: {
            code: outcomes.length === 1 ? first.result.error!.code : 'ALL_PROVIDERS_FAILED',
            message: text(language, 'searchFailed'),
            details: { failures },
          },
        },
        exitCode: (outcomes.every((item) => item.exitCode === first.exitCode)
          ? first.exitCode
          : 4) as 2 | 3 | 4 | 5 | 130,
      };
    } else if (failures.length) {
      outcome = {
        result: {
          status: 'partial',
          data,
          error: {
            code: 'PARTIAL_FAILURE',
            message: text(language, 'searchPartial'),
            details: { failures },
          },
        },
        exitCode: 6,
      };
    } else outcome = success(data);
    const modelMeta = outcomes.find((_, index) => plan.sources[index].provider === 'model')?.result
      .meta;
    if (modelMeta) outcome.result.meta = redact(modelMeta, plan.secrets) as JsonObject;
    if (outcome.result.error)
      outcome.result.error = redact(outcome.result.error, plan.secrets) as PublicError;
    record.elapsed_ms = Math.max(0, Math.round(time.now() - started));
    record.attempts = redact(attempts, plan.secrets);
    return outcome;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
