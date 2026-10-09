import { AppError, failure } from './errors.js';
import { clock, executeRequest, retryAfterSeconds } from './execution.js';
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
import { requestModel, searchInstructions } from './providers/model.js';
import type { ModelAttempt } from './providers/model.js';
import type { ModelAnswer } from './providers/model-response.js';
import { configuredSecrets, redactDiagnostics as redact } from './providers/transport.js';
import { success } from './result.js';
import type { JsonObject, JsonValue, Outcome, PublicError } from './result.js';
import type { ModelCandidate } from './config/fields.js';
import {
  prepareTavilySearch,
  requestTavilySearch,
  tavilyRequestLimits,
} from './providers/tavily.js';
import type { TavilySearchRequest, TavilySearchData } from './providers/tavily.js';

export interface SearchPlan {
  model: ModelRequest;
  extraSources: ExtraPlan[];
  secrets: string[];
}
type ExtraPlan =
  | { provider: 'zhipu'; request: zhipu.Request<'search'> }
  | { provider: 'tinyfish'; request: tinyfish.SearchRequest }
  | { provider: 'zhipu-mcp'; request: zhipuMcp.Request }
  | { provider: 'anysearch'; request: anysearch.Request<'search'> }
  | { provider: 'exa'; request: SearchRequest }
  | { provider: 'firecrawl'; request: firecrawl.SearchRequest }
  | { provider: 'jina'; request: jina.SearchRequest }
  | { provider: 'tavily'; request: TavilySearchRequest };
type ExtraData =
  | SearchData
  | FirecrawlData
  | TavilySearchData
  | JinaData
  | anysearch.SearchData
  | ZhipuData
  | TinyfishData
  | zhipuMcp.Data;
type ExtraSource =
  | { provider: 'zhipu'; data: Omit<ZhipuData, 'provider'> }
  | { provider: 'tinyfish'; data: Omit<TinyfishData, 'provider'> }
  | { provider: 'zhipu-mcp'; data: Omit<zhipuMcp.ToolData, 'provider'> }
  | { provider: 'jina'; data: Omit<JinaData, 'provider'> }
  | { provider: 'anysearch'; data: { results: anysearch.SearchData['results'] } }
  | { provider: 'tavily'; data: { results: TavilySearchData['results'] } }
  | { provider: 'exa'; data: { results: SearchData['results'] } }
  | { provider: 'firecrawl'; data: { results: FirecrawlData['results']; warnings?: string[] } };
export type CombinedData = JsonObject & {
  answer?: ModelAnswer;
  extra_sources?: ExtraSource[];
};

export function prepareCombinedSearch(
  query: string,
  options: ModelOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): SearchPlan {
  const sources = options.extraSources === undefined ? [] : options.extraSources.split(',');
  if (
    sources.some(
      (source) =>
        ![
          'exa',
          'firecrawl',
          'tavily',
          'jina',
          'anysearch',
          'zhipu',
          'zhipu-mcp',
          'tinyfish',
        ].includes(source),
    ) ||
    new Set(sources).size !== sources.length
  )
    throw new AppError('INVALID_ARGUMENT', 'invalidExtraSources', { option: '--extra-sources' });
  const model = prepareModel(query, options, values, env, language);
  const extraSources: ExtraPlan[] = sources.map((provider) => {
    if (provider === 'zhipu-mcp')
      return {
        provider,
        request: zhipuMcp.prepare(
          'search',
          query,
          { timeout: options.timeout },
          values,
          env,
          language,
        ),
      };
    if (provider === 'zhipu')
      return {
        provider,
        request: zhipu.prepare(
          'search',
          query,
          { timeout: options.timeout },
          values,
          env,
          language,
        ),
      };
    if (provider === 'tinyfish')
      return {
        provider,
        request: tinyfish.prepareSearch(query, { timeout: options.timeout }, values, env, language),
      };
    if (provider === 'jina')
      return {
        provider,
        request: jina.prepareSearch(query, { timeout: options.timeout }, values, env, language),
      };
    if (provider === 'anysearch')
      return {
        provider,
        request: anysearch.prepare(
          'search',
          query,
          { timeout: options.timeout },
          values,
          env,
          language,
        ),
      };
    if (provider === 'exa')
      return {
        provider,
        request: prepareSearch(query, { timeout: options.timeout }, values, env, language),
      };
    if (provider === 'tavily')
      return {
        provider,
        request: prepareTavilySearch(query, { timeout: options.timeout }, values, env, language),
      };
    return {
      provider: 'firecrawl',
      request: firecrawl.prepareSearch(query, { timeout: options.timeout }, values, env, language),
    };
  });
  return { model, extraSources, secrets: configuredSecrets(values, env) };
}

export function modelLabel(candidate: ModelCandidate): string {
  return `${candidate.id}${candidate.effort ? `(${candidate.effort})` : ''}`;
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
  const deadline = started + plan.model.timeout * 1000;
  const instructions = `${searchInstructions}\n\nCurrent UTC time: ${new Date(time.wallNow()).toISOString()}`;
  const controller = new AbortController();
  const cancel = () => controller.abort(new AppError('CANCELLED', 'cancelled'));
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  const attempts: JsonObject[] = [];
  const fallbacks: JsonObject[] = [];
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
    timeout: plan.model.timeout,
    signal: controller.signal,
    language,
    clock: time,
  };
  async function modelTask(): Promise<Outcome<ModelAnswer>> {
    if (controller.signal.aborted) return failure(controller.signal.reason, language);
    const blockedIds = new Set<string>();
    let previous: { candidate: ModelCandidate; error: PublicError; last?: JsonObject } | undefined;
    let outcome: Outcome<ModelAnswer> = failure(
      new AppError('INTERNAL_ERROR', 'internal'),
      language,
    );
    for (const candidate of plan.model.candidates) {
      if (blockedIds.has(candidate.id)) continue;
      if (controller.signal.aborted || time.now() >= deadline) break;
      let attempted = false;
      let policy: ModelAttempt['fallback'];
      let retryAfter: string | undefined;
      const localRecord: JsonObject = {};
      outcome = await executeRequest(
        async (context) => {
          const result = await requestModel(
            plan.model,
            candidate,
            instructions,
            context,
            language,
            options.transport,
          );
          policy = result.fallback;
          retryAfter = result.retry ? result.retryAfter : undefined;
          if (result.outcome.result.error) {
            result.outcome.result.error.details = {
              ...result.outcome.result.error.details,
              provider: 'model',
              model: candidate.id,
              ...(context.httpStatus === undefined ? {} : { http_status: context.httpStatus }),
              ...(context.requestId ? { request_id: context.requestId } : {}),
            };
          }
          return result;
        },
        {
          ...common,
          provider: 'model',
          retries: plan.model.retries,
          requestLimit: Infinity,
          record: localRecord,
          onAttempt: (entry) => {
            if (previous && !attempted) {
              fallbacks.push({
                from: modelLabel(previous.candidate),
                to: modelLabel(candidate),
                code: previous.error.code,
                message: previous.error.message,
              });
              if (previous.last && previous.error.details?.request_id)
                previous.last.request_id = previous.error.details.request_id;
            }
            attempted = true;
            Object.assign(entry, {
              provider: 'model',
              model: candidate.id,
              ...(candidate.effort ? { effort: candidate.effort } : {}),
            });
            attempts.push(entry);
          },
        },
      );
      stopInternal(outcome);
      const error = outcome.result.error;
      if (
        error &&
        policy &&
        retryAfter !== undefined &&
        error.details?.reason !== 'retry_wait_exceeds_budget'
      ) {
        const seconds = retryAfterSeconds(retryAfter, time.wallNow());
        if (seconds !== undefined && seconds * 1000 >= deadline - time.now()) {
          error.message += `${language === 'zh' ? '' : ' '}${text(language, 'retryBudget')}`;
          error.details = {
            ...error.details,
            reason: 'retry_wait_exceeds_budget',
            retry_after_seconds: seconds,
          };
        }
      }
      if (
        !error ||
        !policy ||
        controller.signal.aborted ||
        time.now() >= deadline ||
        error.details?.reason === 'retry_wait_exceeds_budget' ||
        error.details?.timeout_scope === 'total'
      )
        return outcome;
      if (policy === 'model') blockedIds.add(candidate.id);
      previous = { candidate, error, last: (localRecord.attempts as JsonObject[]).at(-1) };
    }
    if (controller.signal.aborted) return failure(controller.signal.reason, language, outcome);
    if (time.now() >= deadline)
      return failure(
        new AppError('TIMEOUT', 'totalTimeout', { provider: 'model', timeout_scope: 'total' }),
        language,
      );
    return outcome;
  }
  async function extraTask(source: ExtraPlan): Promise<Outcome<ExtraData>> {
    return stopInternal(
      await executeRequest<ExtraData>(
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
  async function guarded<T extends JsonValue>(
    task: () => Promise<Outcome<T>>,
  ): Promise<Outcome<T>> {
    try {
      return await task();
    } catch (error) {
      return stopInternal(failure<T>(error, language));
    }
  }
  try {
    const [model, extras] = await Promise.all([
      guarded(modelTask),
      Promise.all(plan.extraSources.map((source) => guarded(() => extraTask(source)))),
    ]);
    const data: CombinedData = {};
    if (model.result.data !== undefined) data.answer = model.result.data;
    for (const extra of extras) {
      const content = extra.result.data;
      if (content === undefined) continue;
      let source: ExtraSource;
      if (content.provider === 'zhipu-mcp') {
        const { provider, ...data } = content;
        source = { provider, data };
      } else if (content.provider === 'tinyfish') {
        const { provider, ...data } = content;
        source = { provider, data };
      } else if (content.provider === 'anysearch') {
        source = { provider: 'anysearch', data: { results: content.results } };
      } else if (content.provider === 'exa') {
        source = { provider: 'exa', data: { results: content.results } };
      } else if (content.provider === 'zhipu') {
        const { provider, ...data } = content;
        source = { provider, data };
      } else if (content.provider === 'jina') {
        const { provider, ...data } = content;
        source = { provider, data };
      } else if (content.provider === 'tavily') {
        source = { provider: 'tavily', data: { results: content.results } };
      } else {
        const sanitize = (message: string) => redact(message, plan.secrets) as string;
        const sanitizeWarnings = (warnings: string[]) => [...new Set(warnings.map(sanitize))];
        const results = content.results.map((item) => {
          const result = { ...item };
          if (item.warnings) result.warnings = sanitizeWarnings(item.warnings);
          if (item.content_error?.message)
            result.content_error = {
              ...item.content_error,
              message: sanitize(item.content_error.message),
            };
          return result;
        });
        source = {
          provider: 'firecrawl',
          data: {
            results,
            ...(content.warnings ? { warnings: sanitizeWarnings(content.warnings) } : {}),
          },
        };
      }
      (data.extra_sources ??= []).push(source);
    }
    const failures = (
      [
        ['model', model],
        ...extras.map((outcome, index) => [plan.extraSources[index].provider, outcome] as const),
      ] as const
    ).flatMap(([provider, outcome]) => {
      const error = outcome?.result.error;
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
          provider,
          code: error.code,
          message: error.message,
          ...(Object.keys(details).length ? { details } : {}),
        },
      ];
    });
    let outcome: Outcome<CombinedData>;
    const content = Object.keys(data).length ? { data } : {};
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
    } else if (model.result.error) {
      outcome = {
        result: {
          status: 'error',
          ...content,
          error: {
            code: model.result.error.code,
            message: text(language, 'modelFailed'),
            details: { failures },
          },
        },
        exitCode: model.exitCode as 2 | 3 | 4 | 5 | 130,
      };
    } else if (failures.length) {
      outcome = {
        result: {
          status: 'partial',
          data,
          error: {
            code: 'PARTIAL_FAILURE',
            message: text(language, 'modelPartial'),
            details: { failures },
          },
        },
        exitCode: 6,
      };
    } else outcome = success(data);
    if (fallbacks.length)
      outcome.result.meta = { model_fallbacks: redact(fallbacks, plan.secrets) };
    if (outcome.result.error)
      outcome.result.error = redact(outcome.result.error, plan.secrets) as PublicError;
    record.elapsed_ms = Math.max(0, Math.round(time.now() - started));
    record.attempts = redact(attempts, plan.secrets);
    return outcome;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
