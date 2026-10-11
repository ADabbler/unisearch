import { isObject } from './config/fields.js';
import { AppError, failure } from './errors.js';
import type { AttemptContext, AttemptResult } from './execution.js';
import type { Language } from './i18n/messages.js';
import { success } from './result.js';
import type { JsonObject } from './result.js';
import { httpError as modelError } from './providers/model.js';
import { httpError as tavilyError } from './providers/tavily.js';
import { classify as firecrawlError } from './providers/firecrawl.js';
import { redactDiagnostics, transportError } from './providers/transport.js';

export type MetadataProvider = 'model' | 'tavily' | 'firecrawl';
export interface MetadataRequest {
  provider: MetadataProvider;
  url: string;
  apiKey: string;
  model?: string;
  secrets: string[];
}
function invalid(provider: string, field: string): never {
  throw new AppError('INVALID_RESPONSE', 'doctorResponse', { provider, field });
}
function object(value: unknown, provider: string, field: string): Record<string, unknown> {
  if (!isObject(value)) return invalid(provider, field);
  return value;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function integer(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value >= 0;
}

function nullableInteger(value: unknown): value is number | null {
  return value === null || integer(value);
}

export function parseMetadata(request: MetadataRequest, value: unknown): JsonObject | undefined {
  const { provider } = request;
  const body = object(value, provider, 'response');
  if (provider === 'model') {
    if (!Array.isArray(body.data)) return invalid(provider, 'data');
    for (const item of body.data)
      if (!isObject(item) || typeof item.id !== 'string' || !item.id.trim())
        return invalid(provider, 'data.id');
    if (!body.data.some((item) => item.id === request.model))
      throw new AppError('MODEL_UNAVAILABLE', 'doctorModelMissing', {
        provider,
        model: request.model!,
      });
    return;
  }
  if (provider === 'tavily') {
    const key = object(body.key, provider, 'key'),
      account = object(body.account, provider, 'account');
    if (!integer(key.usage)) return invalid(provider, 'key.usage');
    if (key.limit !== null && !integer(key.limit)) return invalid(provider, 'key.limit');
    const quota: JsonObject = { key: { usage: key.usage, limit: key.limit } };
    const values: JsonObject = {};
    for (const field of ['plan_usage', 'paygo_usage']) {
      if (account[field] === undefined) continue;
      if (!integer(account[field])) return invalid(provider, `account.${field}`);
      values[field] = account[field];
    }
    if (account.plan_limit !== undefined) {
      if (!integer(account.plan_limit)) return invalid(provider, 'account.plan_limit');
      values.plan_limit = account.plan_limit;
    }
    if (account.paygo_limit !== undefined) {
      if (!nullableInteger(account.paygo_limit)) return invalid(provider, 'account.paygo_limit');
      values.paygo_limit = account.paygo_limit;
    }
    if (account.current_plan !== undefined) {
      if (typeof account.current_plan !== 'string')
        return invalid(provider, 'account.current_plan');
      values.current_plan = account.current_plan;
    }
    if (Object.keys(values).length) quota.account = values;
    if (key.limit !== null && key.usage >= key.limit)
      throw new AppError('QUOTA_EXCEEDED', 'tavilyQuota', {
        provider,
        usage: key.usage,
        limit: key.limit,
      });
    const planExhausted =
      integer(values.plan_usage) &&
      integer(values.plan_limit) &&
      values.plan_usage >= values.plan_limit;
    const paygoExhausted =
      integer(values.paygo_usage) &&
      integer(values.paygo_limit) &&
      values.paygo_usage >= values.paygo_limit;
    const paygoUnavailable = values.paygo_limit === null;
    if (
      (planExhausted && (paygoUnavailable || paygoExhausted)) ||
      (values.plan_limit === undefined && paygoExhausted)
    )
      throw new AppError('QUOTA_EXCEEDED', 'tavilyQuota', { provider, ...values });
    return quota;
  }
  if (body.success !== true) return invalid(provider, 'success');
  const data = object(body.data, provider, 'data');
  if (!finite(data.remainingCredits)) return invalid(provider, 'data.remainingCredits');
  const quota: JsonObject = { remaining_credits: data.remainingCredits };
  for (const [field, key] of [
    ['planCredits', 'plan_credits'],
    ['billingPeriodStart', 'billing_period_start'],
    ['billingPeriodEnd', 'billing_period_end'],
  ]) {
    const value = data[field];
    if (value === undefined) continue;
    if (field === 'planCredits' ? !finite(value) : typeof value !== 'string' || !value.trim())
      return invalid(provider, `data.${field}`);
    quota[key] = value as string | number;
  }
  if (data.remainingCredits <= 0)
    throw new AppError('QUOTA_EXCEEDED', 'firecrawlQuota', {
      provider,
      remaining_credits: data.remainingCredits,
    });
  return quota;
}

export async function requestMetadata(
  request: MetadataRequest,
  context: AttemptContext,
  language: Language,
  check: JsonObject,
  transport: typeof fetch = fetch,
): Promise<AttemptResult<JsonObject>> {
  const { provider } = request;
  const safe = (value: string) => redactDiagnostics(value, request.secrets) as string;
  try {
    const response = await transport(request.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${request.apiKey}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: context.signal,
    });
    context.httpStatus = response.status;
    const id = response.headers.get('x-request-id');
    if (id) context.requestId = safe(id);
    const bytes = await response.arrayBuffer();
    let body: unknown;
    let invalidBody = false;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      invalidBody = true;
    }
    if (
      response.status !== 200 ||
      (provider === 'firecrawl' && isObject(body) && body.success === false)
    ) {
      let mapped: ReturnType<typeof modelError>;
      let error: Record<string, unknown> | undefined;
      if (provider === 'model') {
        error = isObject(body) && isObject(body.error) ? body.error : undefined;
        mapped = modelError(response.status, error);
      } else if (provider === 'tavily') {
        error = isObject(body) && isObject(body.detail) ? body.detail : undefined;
        mapped = tavilyError(response.status);
      } else {
        error = isObject(body) ? body : undefined;
        mapped = firecrawlError(
          response.status,
          'credit_usage',
          typeof error?.code === 'string' ? error.code : undefined,
          typeof error?.error === 'string' ? error.error : undefined,
        );
      }
      const details: JsonObject = { provider, http_status: response.status };
      for (const [field, key] of [
        ['message', 'upstream_message'],
        ['error', 'upstream_message'],
        ['code', 'upstream_code'],
        ['type', 'upstream_type'],
        ['param', 'upstream_param'],
      ]) {
        const value = error?.[field];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string') invalidBody = true;
        else details[key] = safe(value);
      }
      if (!error || invalidBody) details.reason = 'error_body_invalid';
      if (mapped.code === 'TIMEOUT') details.timeout_scope = 'request';
      throw new AppError(mapped.code, mapped.key, details);
    }
    if (invalidBody) invalid(provider, 'response');
    const quota = parseMetadata(request, body);
    if (quota) check.quota = redactDiagnostics(quota, request.secrets);
    return {
      outcome: success({ provider, ...(request.model ? { model: request.model } : {}) }),
      retry: false,
    };
  } catch (error) {
    context.signal.throwIfAborted();
    const mapped = transportError(error, context, provider, 'doctorNetwork', safe);
    const outcome = failure<JsonObject>(mapped?.error ?? error, language);
    if (outcome.result.error) {
      outcome.result.error.details = {
        ...outcome.result.error.details,
        provider,
        ...(context.httpStatus === undefined ? {} : { http_status: context.httpStatus }),
        ...(context.requestId ? { request_id: context.requestId } : {}),
      };
      outcome.result.error = redactDiagnostics(
        outcome.result.error,
        request.secrets,
      ) as typeof outcome.result.error;
    }
    return { outcome, retry: false };
  }
}
