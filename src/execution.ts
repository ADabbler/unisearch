import { setTimeout as delay } from 'node:timers/promises';
import { AppError, failure } from './errors.js';
import { text } from './i18n/messages.js';
import type { Language } from './i18n/messages.js';
import type { JsonObject, JsonValue, Outcome } from './result.js';

export interface AttemptContext {
  signal: AbortSignal;
  httpStatus?: number;
  requestId?: string;
  responseId?: string;
  model?: string;
  operation?: string;
  billedTokens?: number;
  pageLatencies?: { url: string; latency_ms: number }[];
  retryAllowed?: boolean;
  markStreamProgress?: () => void;
}
export interface AttemptResult<T extends JsonValue> {
  outcome: Outcome<T>;
  retry: boolean;
  retryAfter?: string;
}
export interface ExecutionClock {
  now(): number;
  wallNow(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  schedule(ms: number, callback: () => void): () => void;
}
export const clock: ExecutionClock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  async sleep(ms, signal) {
    const end = performance.now() + ms;
    while (performance.now() < end)
      await delay(Math.min(2_147_483_647, Math.max(1, end - performance.now())), undefined, {
        signal,
      });
    signal.throwIfAborted();
  },
  schedule(ms, callback) {
    const end = performance.now() + ms;
    const tick = () => {
      if (performance.now() >= end) callback();
      else
        timer = setTimeout(
          tick,
          Math.min(2_147_483_647, Math.max(1, Math.ceil(end - performance.now()))),
        );
    };
    let timer = setTimeout(tick, Math.min(2_147_483_647, Math.max(1, Math.ceil(ms))));
    return () => clearTimeout(timer);
  },
};

export function retryAfterSeconds(value: string, now: number): number | undefined {
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  // HTTP-date accepts IMF-fixdate and the two obsolete HTTP wire formats.
  if (
    !/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(
      value,
    )
  )
    return undefined;
  const date = Date.parse(value.endsWith('GMT') ? value : `${value} GMT`);
  if (!Number.isFinite(date)) return undefined;
  const parts = /(?:, (\d{2})[ -]([A-Z][a-z]{2})|^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +([\d]{1,2}))/.exec(
    value,
  )!;
  const time = /(\d{2}):(\d{2}):(\d{2})/.exec(value)!;
  const parsed = new Date(date);
  if (
    parsed.getUTCDate() !== Number(parts[1] ?? parts[4]) ||
    parsed.getUTCMonth() !==
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(
        parts[2] ?? parts[3],
      ) ||
    parsed.getUTCHours() !== Number(time[1]) ||
    parsed.getUTCMinutes() !== Number(time[2]) ||
    parsed.getUTCSeconds() !== Number(time[3])
  )
    return undefined;
  return Math.max(0, (date - now) / 1000);
}

export interface ExecutionOptions {
  provider: string;
  timeout: number;
  retries: number;
  signal: AbortSignal;
  language: Language;
  record: JsonObject;
  clock?: ExecutionClock;
  deadline?: number;
  requestLimit: number;
  onAttempt?: (entry: JsonObject) => void;
  /**
   * Ending the request instead of waiting when this returns true reports
   * `retry_wait_exceeds_share`. A wait reaching the whole budget ends it anyway.
   */
  declineRetryWait?: (wait: number, budget: number) => boolean;
}

function abortError(signal: AbortSignal): AppError {
  return signal.reason instanceof AppError ? signal.reason : new AppError('CANCELLED', 'cancelled');
}

export async function executeRequest<T extends JsonValue>(
  operation: (context: AttemptContext) => Promise<AttemptResult<T>>,
  options: ExecutionOptions,
): Promise<Outcome<T>> {
  const time = options.clock ?? clock;
  const started = time.now();
  const deadline = options.deadline ?? started + options.timeout * 1000;
  const remaining = () => deadline - time.now();
  const attempts: JsonObject[] = [];
  const timeoutMessages = {
    total: 'totalTimeout',
    request: 'requestTimeout',
    stream_idle: 'streamIdleTimeout',
  } as const;
  const timeout = (scope: 'total' | 'request' | 'stream_idle', context?: AttemptContext) =>
    new AppError('TIMEOUT', timeoutMessages[scope], {
      provider: options.provider,
      timeout_scope: scope,
      ...(context?.operation ? { operation: context.operation } : {}),
      ...(context?.httpStatus === undefined ? {} : { http_status: context.httpStatus }),
      ...(context?.requestId ? { request_id: context.requestId } : {}),
    });
  const check = () => {
    if (options.signal.aborted) throw abortError(options.signal);
    if (remaining() <= 0) throw timeout('total');
  };
  let final: Outcome<T>;
  try {
    for (;;) {
      check();
      const begin = time.now();
      const abort = new AbortController();
      const cancel = () => abort.abort();
      options.signal.addEventListener('abort', cancel, { once: true });
      const cap = Math.min(options.requestLimit * 1000, remaining());
      let attemptDeadline = begin + cap;
      let expired = false;
      const context: AttemptContext = { signal: abort.signal };
      let streamStarted = false;
      const expire = () => {
        expired = true;
        abort.abort();
      };
      let clear = time.schedule(cap, expire);
      const timedOut = () => {
        if (!streamStarted && remaining() <= 0) return timeout('total', context);
        if (expired || time.now() >= attemptDeadline)
          return timeout(streamStarted ? 'stream_idle' : 'request', context);
        return undefined;
      };
      context.markStreamProgress = () => {
        if (options.signal.aborted) throw abortError(options.signal);
        const problem = timedOut();
        if (problem) throw problem;
        streamStarted = true;
        attemptDeadline = time.now() + options.timeout * 1000;
        clear();
        clear = time.schedule(options.timeout * 1000, expire);
      };
      const entry: JsonObject = {};
      attempts.push(entry);
      let attempt: AttemptResult<T>;
      try {
        options.onAttempt?.(entry);
        attempt = await operation(context);
        if (options.signal.aborted) throw abortError(options.signal);
        const problem = timedOut();
        if (problem) throw problem;
      } catch (error) {
        let problem = error;
        if (options.signal.aborted) problem = abortError(options.signal);
        else problem = timedOut() ?? error;
        attempt = {
          outcome: failure<T>(problem, options.language),
          retry:
            problem instanceof AppError &&
            problem.code === 'TIMEOUT' &&
            problem.details?.timeout_scope === 'request' &&
            context.retryAllowed !== false,
        };
      } finally {
        clear();
        options.signal.removeEventListener('abort', cancel);
      }
      Object.assign(entry, {
        duration_ms: Math.max(0, Math.round(time.now() - begin)),
        ...(context.httpStatus === undefined ? {} : { http_status: context.httpStatus }),
        ...(context.requestId ? { request_id: context.requestId } : {}),
        ...(context.responseId ? { response_id: context.responseId } : {}),
        ...(context.model ? { model: context.model } : {}),
        ...(attempt.outcome.result.error ? { code: attempt.outcome.result.error.code } : {}),
        ...(context.billedTokens === undefined ? {} : { billed_tokens: context.billedTokens }),
        ...(context.pageLatencies?.length ? { page_latencies: context.pageLatencies } : {}),
      });
      final = attempt.outcome;
      if (streamStarted || !attempt.retry || attempts.length > options.retries) break;
      check();
      const budget = remaining();
      const seconds =
        attempt.retryAfter === undefined
          ? undefined
          : retryAfterSeconds(attempt.retryAfter, time.wallNow());
      if (attempt.retryAfter !== undefined && seconds === undefined)
        entry.retry_after_invalid = true;
      const wait =
        seconds === undefined
          ? Math.min(2 ** Math.min(attempts.length - 1, 4), 10) * 1000
          : seconds * 1000;
      const overBudget = wait >= budget;
      if (overBudget || options.declineRetryWait?.(wait, budget)) {
        if (final.result.error) {
          const key = overBudget ? 'retryBudget' : 'retryWaitShare';
          final.result.error.message += `${options.language === 'zh' ? '' : ' '}${text(options.language, key)}`;
          final.result.error.details = {
            ...final.result.error.details,
            reason: overBudget ? 'retry_wait_exceeds_budget' : 'retry_wait_exceeds_share',
            ...(seconds === undefined ? {} : { retry_after_seconds: seconds }),
          };
        }
        break;
      }
      const waitStart = time.now();
      entry.wait_source = seconds === undefined ? 'backoff' : 'retry_after';
      try {
        await time.sleep(wait, options.signal);
      } finally {
        entry.wait_ms = Math.max(0, Math.round(time.now() - waitStart));
      }
      check();
    }
  } catch (error) {
    final = failure<T>(
      options.signal.aborted ? abortError(options.signal) : error,
      options.language,
    );
  }
  const last = attempts.at(-1);
  if (last?.request_id && last.request_id === final.result.error?.details?.request_id)
    delete last.request_id;
  if (last?.response_id && last.response_id === final.result.error?.details?.response_id)
    delete last.response_id;
  options.record.elapsed_ms = Math.max(0, Math.round(time.now() - started));
  options.record.attempts = attempts;
  return final;
}
