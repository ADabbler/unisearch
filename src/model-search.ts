import { AppError, failure } from './errors.js';
import { executeRequest } from './execution.js';
import type { ExecutionClock } from './execution.js';
import type { ModelCandidate } from './config/fields.js';
import type { ModelRequest } from './providers/model-config.js';
import { requestModel, searchInstructions } from './providers/model.js';
import type { ModelAttempt } from './providers/model.js';
import type { ModelAnswer } from './providers/model-response.js';
import type { Language } from './i18n/messages.js';
import type { JsonObject, Outcome, PublicError } from './result.js';

/** Share of the remaining budget a retry wait may consume. */
const retryWaitShare = 0.5;

function modelLabel(candidate: ModelCandidate): string {
  return candidate.id + (candidate.effort ? '(' + candidate.effort + ')' : '');
}

export async function searchModel(
  request: ModelRequest,
  options: {
    deadline: number;
    signal: AbortSignal;
    language: Language;
    clock: ExecutionClock;
    transport?: typeof fetch;
    onAttempt: (entry: JsonObject) => void;
  },
): Promise<Outcome<ModelAnswer>> {
  const { deadline, signal, language, clock: time, transport, onAttempt } = options;
  const instructions =
    searchInstructions + '\n\nCurrent UTC time: ' + new Date(time.wallNow()).toISOString();
  const fallbacks: JsonObject[] = [];
  async function run(): Promise<Outcome<ModelAnswer>> {
    if (signal.aborted) return failure(signal.reason, language);
    const blockedIds = new Set<string>();
    let previous: { candidate: ModelCandidate; error: PublicError; last?: JsonObject } | undefined;
    let outcome: Outcome<ModelAnswer> | undefined;
    // A model-level verdict blocks the rest of the ID, a candidate-level one does not.
    const attemptable = (index: number, verdict: 'candidate' | 'model'): boolean =>
      request.candidates
        .slice(index + 1)
        .some(
          (other) =>
            !blockedIds.has(other.id) &&
            (verdict === 'candidate' || other.id !== request.candidates[index].id),
        );
    for (const [index, candidate] of request.candidates.entries()) {
      if (blockedIds.has(candidate.id)) continue;
      if (signal.aborted || time.now() >= deadline) break;
      let attempted = false;
      let policy: ModelAttempt['fallback'];
      const localRecord: JsonObject = {};
      outcome = await executeRequest(
        async (context) => {
          const result = await requestModel(
            request,
            candidate,
            instructions,
            context,
            language,
            transport,
          );
          // An attempt without a fallback verdict keeps the preceding retry's verdict.
          policy = result.fallback ?? policy;
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
          deadline,
          timeout: request.timeout,
          signal,
          language,
          clock: time,
          provider: 'model',
          retries: request.retries,
          requestLimit: Infinity,
          declineRetryWait: (wait, budget) =>
            policy !== undefined && attemptable(index, policy) && wait >= budget * retryWaitShare,
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
            onAttempt(entry);
          },
        },
      );
      const error = outcome.result.error;
      if (
        !error ||
        outcome.exitCode === 5 ||
        !policy ||
        signal.aborted ||
        time.now() >= deadline ||
        error.details?.timeout_scope === 'total'
      )
        return outcome;
      if (policy === 'model') blockedIds.add(candidate.id);
      previous = { candidate, error, last: (localRecord.attempts as JsonObject[]).at(-1) };
    }
    if (signal.aborted) return failure(signal.reason, language, outcome);
    if (time.now() >= deadline)
      return failure(
        new AppError('TIMEOUT', 'totalTimeout', { provider: 'model', timeout_scope: 'total' }),
        language,
      );
    return outcome!;
  }
  const outcome = await run();
  if (fallbacks.length) outcome.result.meta = { model_fallbacks: fallbacks };
  return outcome;
}
