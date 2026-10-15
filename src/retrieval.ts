import { assertValid, fieldAt, parseInput } from './config/fields.js';
import { inspectConfig, resolveField } from './config/resolve.js';
import type { ResolvedField } from './config/resolve.js';
import { operationConfig } from './config/status.js';
import { AppError, failure } from './errors.js';
import { clock, executeRequest } from './execution.js';
import type { AttemptContext, AttemptResult, ExecutionClock } from './execution.js';
import { text } from './i18n/messages.js';
import type { Language } from './i18n/messages.js';
import * as tavily from './providers/tavily.js';
import * as firecrawl from './providers/firecrawl.js';
import * as exa from './providers/exa.js';
import * as jina from './providers/jina.js';
import * as zhipu from './providers/zhipu.js';
import * as zhipuMcp from './providers/zhipu-mcp.js';
import type { Page as JinaPage } from './providers/jina-response.js';
import * as anysearch from './providers/anysearch.js';
import * as tinyfish from './providers/tinyfish.js';
import type { Page as TinyfishPage } from './providers/tinyfish-response.js';
import type { MapLink, ScrapeData } from './providers/firecrawl-response.js';
import { validPageUrl } from './providers/firecrawl-response.js';
import { configuredSecrets, redactDiagnostics } from './providers/transport.js';
import type { FailureExitCode, JsonObject, Outcome, PublicError } from './result.js';

export type RetrievalOperation = 'fetch' | 'map';
const operations = {
  tavily: { definitions: tavily.tavilyOperations, fetch: 'extract' },
  firecrawl: { definitions: firecrawl.operations, fetch: 'scrape' },
  exa: { definitions: exa.exaOperations, fetch: 'fetch' },
  jina: { definitions: jina.operations, fetch: 'fetch' },
  zhipu: { definitions: zhipu.operations, fetch: 'fetch' },
  'zhipu-mcp': { definitions: zhipuMcp.operations, fetch: 'fetch' },
  anysearch: { definitions: anysearch.operations, fetch: 'extract' },
  tinyfish: { definitions: tinyfish.operations, fetch: 'fetch' },
};
type Provider = keyof typeof operations;
type Page = Pick<
  ScrapeData,
  'url' | 'title' | 'final_url' | 'content_type' | 'content_truncation'
> &
  Pick<
    JinaPage,
    'text' | 'description' | 'published_date' | 'num_pages' | 'metadata' | 'external' | 'warnings'
  > &
  Pick<
    TinyfishPage,
    | 'language'
    | 'links'
    | 'image_links'
    | 'page_metadata'
    | 'unmatched_selectors'
    | 'missing_content'
    | 'etag'
    | 'last_modified'
    | 'not_modified'
  > & { author?: string };
export type FetchData = {
  provider: Provider;
  results: Page[];
  content_sources?: exa.ContentSource[];
  warnings?: string[];
  content?: JsonObject[];
  structured_content?: JsonObject;
  metadata?: JsonObject;
};
export type MapData = { provider: Provider; links: MapLink[]; warnings?: string[] };
export type RetrievalData = FetchData | MapData;
export interface RetrievalOptions {
  timeout?: number;
  limit?: string;
  fallback?: boolean;
}
interface Candidate {
  provider: Provider;
  requestLimit: number;
  run(
    context: AttemptContext,
    language: Language,
    transport: typeof fetch,
  ): Promise<AttemptResult<RetrievalData>>;
}
export interface RetrievalPlan {
  operation: RetrievalOperation;
  candidates: Candidate[];
  timeout: number;
  retries: number;
  secrets: string[];
}

function mapAttempt<T extends JsonObject>(
  attempt: AttemptResult<T>,
  convert: (data: T) => RetrievalData,
): AttemptResult<RetrievalData> {
  const { outcome } = attempt;
  return {
    ...attempt,
    outcome: {
      ...outcome,
      result: {
        ...outcome.result,
        ...(outcome.result.data === undefined ? {} : { data: convert(outcome.result.data) }),
      },
    } as Outcome<RetrievalData>,
  };
}

export function prepareRetrieval(
  operation: RetrievalOperation,
  url: string,
  options: RetrievalOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): RetrievalPlan {
  if (!validPageUrl(url))
    throw new AppError('INVALID_ARGUMENT', 'invalidPageUrl', { option: 'URL' });
  let limit: number | undefined;
  if (options.limit !== undefined) {
    try {
      limit = parseInput(fieldAt('providers.tavily.map.limit'), options.limit) as number;
    } catch (error) {
      if (error instanceof AppError)
        throw new AppError('INVALID_ARGUMENT', error.key, { option: '--limit' });
      throw error;
    }
  }
  const resolve = (path: string) => {
    const setting = resolveField(values, env, fieldAt(path));
    assertValid(setting.problems, language);
    return setting;
  };
  assertValid(inspectConfig(values, env, operation).problems, language);
  const selection = resolve(`${operation}.providers`);
  const timeout = options.timeout ?? (resolve('execution.timeout_seconds').value as number);
  const retries = resolve('execution.retries').value as number;
  const fallback = options.fallback ?? (resolve('execution.fallback').value as boolean);
  const candidates: Candidate[] = [];
  const providers = selection.value as Provider[];
  for (const provider of providers) {
    const entry = operations[provider];
    const providerOperation = operation === 'fetch' ? entry.fetch : operation;
    const definition = entry.definitions.find((item) => item.operation === providerOperation)!;
    const overrides: Record<string, ResolvedField> = {
      'execution.timeout_seconds': {
        field: fieldAt('execution.timeout_seconds'),
        value: timeout,
        source: 'cli',
        problems: [],
      },
    };
    if (limit !== undefined) {
      const path = `providers.${provider}.map.limit`;
      // Check availability before applying this candidate's upper limit. A missing
      // service must not restrict the parameters of the services actually used.
      overrides[path] = { field: fieldAt(path), value: limit, source: 'cli', problems: [] };
    }
    try {
      operationConfig(values, env, language, definition, overrides);
      if (provider === 'zhipu') {
        const request = zhipu.prepare('fetch', url, { timeout }, values, env, language);
        candidates.push({
          provider,
          requestLimit: zhipu.requestLimits.fetch,
          run: (context, ui, transport) => zhipu.request(request, context, ui, transport),
        });
      } else if (provider === 'zhipu-mcp') {
        const request = zhipuMcp.prepare('fetch', url, { timeout }, values, env, language);
        candidates.push({
          provider,
          requestLimit: zhipuMcp.requestLimits.fetch,
          run: async (context, ui, transport) =>
            mapAttempt(
              await zhipuMcp.request(request, context, ui, transport),
              (data) => data as FetchData,
            ),
        });
      } else if (provider === 'anysearch') {
        const request = anysearch.prepare('extract', url, { timeout }, values, env, language);
        candidates.push({
          provider,
          requestLimit: anysearch.requestLimit,
          run: async (context, ui, transport) =>
            mapAttempt(
              await anysearch.request(request, context, ui, transport),
              ({ provider, ...page }) => ({ provider, results: [page] }),
            ),
        });
      } else if (provider === 'exa') {
        const request = exa.prepareFetch([url], { timeout }, values, env, language);
        candidates.push({
          provider,
          requestLimit: exa.exaRequestLimit,
          // Without requested highlights, the parser retains only pages with text.
          run: (context, ui, transport) => exa.requestFetch(request, context, ui, transport),
        });
      } else if (provider === 'tinyfish') {
        const request = tinyfish.prepareFetch([url], { timeout }, values, env, language);
        candidates.push({
          provider,
          requestLimit: tinyfish.requestLimits.fetch,
          run: (context, ui, transport) => tinyfish.request(request, context, ui, transport),
        });
      } else if (provider === 'jina') {
        const request = jina.prepareFetch(url, { timeout }, values, env, language);
        candidates.push({
          provider,
          requestLimit: jina.requestLimit,
          run: (context, ui, transport) => jina.request(request, context, ui, transport),
        });
      } else if (provider === 'tavily' && operation === 'fetch') {
        const request = tavily.prepareExtract([url], { timeout }, values, env, language);
        candidates.push({
          provider,
          requestLimit: tavily.tavilyRequestLimits.extract,
          run: async (context, ui, transport) =>
            mapAttempt(await tavily.requestExtract(request, context, ui, transport), (data) => ({
              provider: 'tavily',
              results: data.results,
            })),
        });
      } else if (provider === 'tavily') {
        const request = tavily.prepareMap(
          url,
          { timeout, limit: options.limit },
          values,
          env,
          language,
        );
        candidates.push({
          provider,
          requestLimit: tavily.tavilyRequestLimits.map,
          run: async (context, ui, transport) =>
            mapAttempt(await tavily.requestMap(request, context, ui, transport), (data) => ({
              provider: 'tavily',
              links: data.results.map((url) => ({ url })),
            })),
        });
      } else if (operation === 'fetch') {
        const request = firecrawl.prepareScrape(url, { timeout }, values, env, language);
        candidates.push({
          provider,
          requestLimit: firecrawl.requestLimits.scrape,
          run: async (context, ui, transport) =>
            mapAttempt(
              await firecrawl.requestScrape(request, context, ui, transport),
              ({ provider, warnings, ...page }) => ({
                provider,
                results: [page],
                ...(warnings ? { warnings } : {}),
              }),
            ),
        });
      } else {
        const request = firecrawl.prepareMap(
          url,
          { timeout, limit: options.limit },
          values,
          env,
          language,
        );
        candidates.push({
          provider,
          requestLimit: firecrawl.requestLimits.map,
          run: (context, ui, transport) => firecrawl.requestMap(request, context, ui, transport),
        });
      }
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === 'MISSING_CONFIG' || error.code === 'SERVICE_DISABLED') continue;
        throw new AppError(error.code, error.key, { ...error.details, provider });
      }
      throw error;
    }
    if (!fallback) break;
  }
  if (!candidates.length)
    throw new AppError(
      'MISSING_CONFIG',
      providers.length ? 'noRetrievalProvider' : 'emptyRetrievalProviders',
      { field: `${operation}.providers` },
    );
  return { operation, candidates, timeout, retries, secrets: configuredSecrets(values, env) };
}

function canSwitch(
  provider: Provider,
  operation: RetrievalOperation,
  error: PublicError,
  retryable: boolean,
): boolean {
  if (
    provider === 'zhipu' &&
    ['NETWORK_ERROR', 'TIMEOUT'].includes(error.code) &&
    !zhipu.canSwitchInterruptedResponse(error)
  )
    return false;
  switch (error.code) {
    case 'AUTHENTICATION_ERROR':
    case 'ACCESS_DENIED':
    case 'QUOTA_EXCEEDED':
    case 'NETWORK_ERROR':
    case 'RATE_LIMITED':
    case 'INVALID_RESPONSE':
      return true;
    case 'TIMEOUT':
      return error.details?.timeout_scope === 'request';
    case 'CONTENT_UNAVAILABLE':
      return (
        operation === 'fetch' &&
        error.details?.page_status !== 404 &&
        error.details?.page_status !== 410
      );
    case 'UPSTREAM_ERROR':
      if (provider === 'zhipu') return zhipu.canSwitchUpstream(error);
      // The request classified cancellation before redacting the upstream code.
      if (provider === 'firecrawl') return retryable;
      if (
        provider === 'tavily' &&
        ((operation === 'fetch' &&
          ['empty_content', 'extraction_failed'].includes(String(error.details?.reason))) ||
          (operation === 'map' && error.details?.reason === 'url_unsupported'))
      )
        return true;
      return [500, 502, 503].includes(Number(error.details?.http_status));
    default:
      return false;
  }
}

function hasText(data: RetrievalData | undefined): boolean {
  return (
    data !== undefined && 'results' in data && data.results.some((page) => !!page.text?.trim())
  );
}

export async function retrieve(
  plan: RetrievalPlan,
  signal: AbortSignal,
  language: Language,
  record: JsonObject,
  options: { clock?: ExecutionClock; transport?: typeof fetch } = {},
): Promise<Outcome<RetrievalData>> {
  const time = options.clock ?? clock;
  const started = time.now();
  const deadline = started + plan.timeout * 1000;
  const attempts: JsonObject[] = [];
  const failures: (PublicError & { provider: Provider })[] = [];
  const exits: FailureExitCode[] = [];
  const switches: JsonObject[] = [];
  let retained: RetrievalData | undefined;
  let final: Outcome<RetrievalData> = failure(new AppError('INTERNAL_ERROR', 'internal'), language);
  let recordedError: PublicError | undefined;
  try {
    for (const candidate of plan.candidates) {
      if (signal.aborted) throw new AppError('CANCELLED', 'cancelled');
      if (time.now() >= deadline)
        throw new AppError('TIMEOUT', 'totalTimeout', { timeout_scope: 'total' });
      let attempted = false;
      let retryable = false;
      const localRecord: JsonObject = {};
      final = await executeRequest(
        async (context) => {
          const attempt = await candidate.run(context, language, options.transport ?? fetch);
          retryable = attempt.retry;
          return attempt;
        },
        {
          provider: candidate.provider,
          timeout: plan.timeout,
          retries: plan.retries,
          requestLimit: candidate.requestLimit,
          deadline,
          signal,
          language,
          clock: time,
          record: localRecord,
          onAttempt(entry) {
            const previous = failures.at(-1);
            if (!attempted && previous)
              switches.push({
                from: previous.provider,
                to: candidate.provider,
                code: previous.code,
                message: previous.message,
              });
            attempted = true;
            entry.provider = candidate.provider;
            attempts.push(entry);
          },
        },
      );
      const data = final.result.data;
      if (data !== undefined && (!final.result.error || hasText(data) || !hasText(retained)))
        retained = data;
      const error = final.result.error;
      if (!error) break;
      if (attempted) {
        const details = { ...error.details };
        delete details.provider;
        failures.push({
          provider: candidate.provider,
          code: error.code,
          message: error.message,
          ...(Object.keys(details).length ? { details } : {}),
        });
        recordedError = error;
        exits.push(final.exitCode as FailureExitCode);
        const last = (localRecord.attempts as JsonObject[]).at(-1)!;
        if (error.details?.request_id) last.request_id = error.details.request_id;
        if (error.details?.response_id) last.response_id = error.details.response_id;
      }
      if (!canSwitch(candidate.provider, plan.operation, error, retryable)) break;
    }
  } catch (error) {
    final = failure(error, language);
  }
  if (signal.aborted && final.exitCode !== 130)
    final = failure(new AppError('CANCELLED', 'cancelled'), language);
  const result = final.result;
  if (result.error) {
    if (retained !== undefined) result.data = retained;
    const terminal =
      final.exitCode === 2 ||
      ['INVALID_CONFIG', 'MISSING_CONFIG', 'SERVICE_DISABLED'].includes(result.error.code) ||
      final.exitCode === 5 ||
      final.exitCode === 130 ||
      result.error.details?.timeout_scope === 'total';
    if (failures.length > 1 || (terminal && failures.length && result.error !== recordedError)) {
      if (!terminal) {
        final = {
          result: {
            status: 'error',
            ...(retained ? { data: retained } : {}),
            error: {
              code: 'ALL_PROVIDERS_FAILED',
              message: text(language, plan.operation === 'fetch' ? 'fetchFailed' : 'mapFailed'),
              details: { failures },
            },
          },
          exitCode: exits.every((exit) => exit === exits[0]) ? exits[0] : 4,
        };
      } else {
        const details = result.error === recordedError ? {} : result.error.details;
        result.error = { ...result.error, details: { ...details, failures } };
      }
    }
    // Request IDs are retained internally until the final public error is known.
    for (const entry of attempts) {
      const error = failures.find((item) => item.provider === entry.provider);
      if (entry.request_id && error?.details?.request_id === entry.request_id)
        delete entry.request_id;
      if (entry.response_id && error?.details?.response_id === entry.response_id)
        delete entry.response_id;
    }
  } else if (switches.length)
    result.meta = { service_fallbacks: redactDiagnostics(switches, plan.secrets) };
  if (final.result.error)
    final.result.error = redactDiagnostics(final.result.error, plan.secrets) as PublicError;
  if (final.result.data?.warnings)
    final.result.data.warnings = [
      ...new Set(
        final.result.data.warnings.map(
          (message) => redactDiagnostics(message, plan.secrets) as string,
        ),
      ),
    ];
  record.elapsed_ms = Math.max(0, Math.round(time.now() - started));
  record.attempts = redactDiagnostics(attempts, plan.secrets);
  return final;
}
