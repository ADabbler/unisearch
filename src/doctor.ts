import { assertValid, fieldAt, providers, isObject, valueAt } from './config/fields.js';
import type { Provider } from './config/fields.js';
import { resolveField } from './config/resolve.js';
import { operationConfig } from './config/status.js';
import { AppError, failure } from './errors.js';
import { clock, executeRequest } from './execution.js';
import type { AttemptContext, AttemptResult } from './execution.js';
import type { Language } from './i18n/messages.js';
import { text } from './i18n/messages.js';
import type { FailureExitCode, JsonObject, JsonValue, Outcome, PublicError } from './result.js';
import { success } from './result.js';
import * as exa from './providers/exa.js';
import * as ctx7 from './providers/context7.js';
import * as anysearch from './providers/anysearch.js';
import * as jina from './providers/jina.js';
import * as zhipu from './providers/zhipu.js';
import * as mcp from './providers/zhipu-mcp.js';
import * as tinyfish from './providers/tinyfish.js';
import { discoverTool } from './providers/zhipu-mcp-http.js';
import { configuredSecrets, redactDiagnostics } from './providers/transport.js';
import { requestMetadata } from './doctor-metadata.js';

export interface DoctorPlan {
  provider: Provider;
  timeout: number;
  retries: number;
  requestLimit: number;
  check: JsonObject;
  request(context: AttemptContext): Promise<AttemptResult<JsonObject>>;
}

type DoctorState = 'disabled' | 'missing' | 'invalid' | 'passed' | 'failed' | 'not_started';
export type DoctorService = JsonObject & {
  provider: Provider;
  state: DoctorState;
  model?: string;
  error?: PublicError;
};
export type DoctorData = JsonObject & { services: DoctorService[] };
export interface DoctorBatchPlan {
  timeout: number;
  services: DoctorService[];
  checks: DoctorPlan[];
}

export function prepareDoctorBatch(
  timeout: number | undefined,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
  transport: typeof fetch = fetch,
): DoctorBatchPlan {
  const budget = resolveField(values, env, fieldAt('execution.timeout_seconds'));
  if (timeout === undefined) assertValid(budget.problems, language);
  const plan: DoctorBatchPlan = {
    timeout: timeout ?? (budget.value as number),
    services: [],
    checks: [],
  };
  for (const provider of providers) {
    try {
      const enabled = resolveField(values, env, fieldAt(`providers.${provider}.enabled`));
      assertValid(enabled.problems, language);
      if (enabled.value === false) {
        plan.services.push({ provider, state: 'disabled' });
        continue;
      }
      plan.checks.push(prepareDoctor(provider, plan.timeout, values, env, language, transport));
      plan.services.push({ provider, state: 'not_started' });
    } catch (error) {
      if (!(error instanceof AppError) || error.exitCode !== 3) throw error;
      plan.services.push({
        provider,
        state: error.code === 'MISSING_CONFIG' ? 'missing' : 'invalid',
        error: error.public(language),
      });
    }
  }
  return plan;
}

export async function diagnoseAll(
  plan: DoctorBatchPlan,
  signal: AbortSignal,
  language: Language,
  record: JsonObject,
): Promise<Outcome<DoctorData>> {
  const started = clock.now();
  const deadline = started + plan.timeout * 1000;
  const controller = new AbortController();
  const cancel = () => controller.abort(new AppError('CANCELLED', 'cancelled'));
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  const services = plan.services.map((service) => ({ ...service }));
  const data: DoctorData = { services };
  const details: JsonObject[] = [];
  const failures: FailureExitCode[] = [];
  let internal: PublicError | undefined;
  try {
    await Promise.all(
      plan.checks.map(async (check) => {
        const detail: JsonObject = { provider: check.provider, check: check.check };
        details.push(detail);
        const outcome = await executeRequest((context) => check.request(context), {
          ...check,
          deadline,
          signal: controller.signal,
          language,
          record: detail,
        });
        const service = services.find((item) => item.provider === check.provider)!;
        if (outcome.result.status === 'success') {
          service.state = 'passed';
          if (typeof outcome.result.data?.model === 'string')
            service.model = outcome.result.data.model;
        } else {
          service.state = (detail.attempts as JsonObject[]).length ? 'failed' : 'not_started';
          service.error = outcome.result.error;
          failures.push(outcome.exitCode as FailureExitCode);
          if (outcome.exitCode === 5 && !internal) {
            internal = outcome.result.error;
            controller.abort(new AppError('INTERNAL_ERROR', 'internal'));
          }
        }
      }),
    );
  } finally {
    signal.removeEventListener('abort', cancel);
    record.elapsed_ms = Math.max(0, Math.round(clock.now() - started));
    record.services = details;
  }
  if (signal.aborted)
    return failure(new AppError('CANCELLED', 'cancelled'), language, success(data));
  if (internal) return { result: { status: 'error', data, error: internal }, exitCode: 5 };
  for (const service of services) {
    if (service.state === 'invalid') failures.push(3);
  }
  if (!failures.length) return success(data);
  const error: PublicError = {
    code: 'DOCTOR_CHECKS_FAILED',
    message: text(language, 'doctorChecksFailed'),
  };
  if (services.some((service) => service.state === 'passed'))
    return { result: { status: 'partial', data, error }, exitCode: 6 };
  const exits = new Set(failures);
  return {
    result: { status: 'error', data, error },
    exitCode: exits.size === 1 ? failures[0]! : 4,
  };
}

export function prepareDoctor(
  provider: string,
  timeout: number | undefined,
  values: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
  language: Language,
  transport: typeof fetch = fetch,
): DoctorPlan {
  if (!providers.includes(provider as Provider))
    throw new AppError('INVALID_ARGUMENT', 'doctorProvider', { provider });
  // Doctor's fixed policy overrides the business retry setting only for this preparation.
  const env = { ...environment, [fieldAt('execution.retries').environment!]: '0' };
  const finish = <T extends JsonValue>(
    request: { url: string; timeout: number },
    operation: string,
    limit: number,
    run: (context: AttemptContext) => Promise<AttemptResult<T>>,
  ): DoctorPlan => ({
    provider: provider as Provider,
    timeout: request.timeout,
    retries: 0,
    requestLimit: limit,
    check: {
      operation,
      endpoint: redactDiagnostics(request.url, configuredSecrets(values, environment)),
    },
    async request(context) {
      const attempt = await run(context);
      const result = attempt.outcome.result;
      let outcome: Outcome<JsonObject>;
      if (result.status === 'success') outcome = success({ provider });
      else if (result.status === 'partial')
        outcome = { result: { status: 'error', error: result.error }, exitCode: 4 };
      else
        outcome = {
          result: { status: 'error', error: result.error },
          exitCode: attempt.outcome.exitCode as 2 | 3 | 4 | 5 | 130,
        };
      return { outcome, retry: false };
    },
  });
  switch (provider) {
    case 'exa': {
      const request = exa.prepareSearch(
        'UniSearch',
        { timeout, limit: '1', searchType: 'fast' },
        values,
        env,
        language,
      );
      delete request.body.contents;
      return finish(request, 'search', exa.exaRequestLimit, (context) =>
        exa.requestSearch(request, context, language, transport),
      );
    }
    case 'ctx7': {
      const request = ctx7.prepare('library', 'react', 'hooks', timeout, values, env, language);
      return finish(request, 'library', ctx7.requestLimit, (context) =>
        ctx7.request(request, context, language, transport),
      );
    }
    case 'anysearch': {
      const request = anysearch.prepare('domains', 'general', { timeout }, values, env, language);
      return finish(request, 'domains', anysearch.requestLimit, (context) =>
        anysearch.request(request, context, language, transport),
      );
    }
    case 'jina': {
      const request = jina.prepareFetch('https://example.com', { timeout }, values, env, language);
      return finish(request, 'fetch', jina.requestLimit, (context) =>
        jina.request(request, context, language, transport),
      );
    }
    case 'tinyfish': {
      const request = tinyfish.prepareSearch('UniSearch', { timeout }, values, env, language);
      return finish(request, 'search', tinyfish.requestLimits.search, (context) =>
        tinyfish.request(request, context, language, transport),
      );
    }
    case 'zhipu': {
      const engine = resolveField(values, env, fieldAt('providers.zhipu.search.engine')).value;
      const diagnosticValues = structuredClone(values);
      if (engine === 'search_pro_quark') {
        const search = valueAt(diagnosticValues, 'providers.zhipu.search');
        if (isObject(search)) delete search.limit;
      }
      const request = zhipu.prepare(
        'search',
        'UniSearch',
        {
          timeout,
          ...(engine === 'search_pro_quark'
            ? {}
            : { limit: engine === 'search_pro_sogou' ? '10' : '1' }),
        },
        diagnosticValues,
        env,
        language,
      );
      return finish(request, 'search', zhipu.requestLimits.search, (context) =>
        zhipu.request(request, context, language, transport),
      );
    }
    case 'zhipu-mcp': {
      const request = mcp.prepare('search', 'UniSearch', { timeout }, values, env, language);
      return finish(request, 'tools/list', 30, async (context) => {
        await discoverTool(request, context, transport);
        return { outcome: success({ provider }), retry: false };
      });
    }
    case 'model':
    case 'tavily':
    case 'firecrawl':
    case 'deepseek': {
      const endpoints = {
        model: 'models',
        tavily: 'usage',
        firecrawl: 'team/credit-usage',
        // The balance endpoint sits at the API root, outside the /v1 prefix the tools use.
        deepseek: 'user/balance',
      } as const;
      // Operation names the user recognises; endpoint paths are an implementation detail.
      const checkNames: Partial<Record<Provider, string>> = {
        firecrawl: 'credit_usage',
        deepseek: 'usage',
      };
      const settings = operationConfig(
        values,
        environment,
        language,
        {
          provider,
          operation: 'doctor',
          required: [
            `providers.${provider}.api_key`,
            `providers.${provider}.base_url`,
            ...(provider === 'model' ? ['providers.model.model.id'] : []),
            'execution.timeout_seconds',
          ],
        },
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
      const base = settings[`providers.${provider}.base_url`].value as string;
      const suffix = endpoints[provider];
      const request = {
        provider,
        url: `${base.replace(/\/+$/, '')}/${suffix}`,
        apiKey: settings[`providers.${provider}.api_key`].value as string,
        ...(provider === 'model'
          ? { model: settings['providers.model.model.id'].value as string }
          : {}),
        secrets: configuredSecrets(values, environment),
      };
      const check: JsonObject = {
        operation: checkNames[provider] ?? suffix,
        endpoint: redactDiagnostics(request.url, request.secrets),
      };
      return {
        provider,
        timeout: settings['execution.timeout_seconds'].value as number,
        retries: 0,
        requestLimit: 30,
        check,
        request: (context) => requestMetadata(request, context, language, check, transport),
      };
    }
  }
  throw new AppError('INTERNAL_ERROR', 'internal');
}
