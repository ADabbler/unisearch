import { AppError, systemCode } from '../errors.js';
import type { AttemptContext } from '../execution.js';
import type { MessageKey } from '../i18n/messages.js';
import { fields, valueAt } from '../config/fields.js';
import type { JsonValue } from '../result.js';

export function configuredSecrets(
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): string[] {
  const secrets = new Set<string>();
  for (const field of fields.filter((field) => field.kind === 'credential')) {
    for (const value of [
      valueAt(values, field.path),
      field.environment ? env[field.environment] : undefined,
    ]) {
      if (typeof value === 'string' && value) secrets.add(value);
    }
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

export function redactDiagnostics(value: JsonValue, secrets: string[]): JsonValue {
  if (typeof value === 'string')
    return secrets.reduce((result, secret) => redactError(result, secret), redactError(value, ''));
  if (Array.isArray(value)) return value.map((item) => redactDiagnostics(item, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        ['code', 'provider', 'wait_source', 'timeout_scope'].includes(key)
          ? item
          : redactDiagnostics(item, secrets),
      ]),
    );
  return value;
}

// Apply only to supplier-owned content, before adding trusted IDs and error codes.
export function redactSecrets<T extends JsonValue>(value: T, secrets: string[]): T {
  const pattern = secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  if (!pattern) return value;
  const matcher = new RegExp(pattern, 'g');
  const mask = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return value.replace(matcher, '[REDACTED]');
    if (Array.isArray(value)) return value.map(mask);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value).map(([original, item]) => ({
        original,
        key: original.replace(matcher, '[REDACTED]'),
        item,
      }));
      const reserved = new Set(entries.map(({ key }) => key));
      const unchanged = new Set(
        entries.filter(({ original, key }) => original === key).map(({ key }) => key),
      );
      const used = new Set<string>();
      return Object.fromEntries(
        entries.map(({ original, key, item }) => {
          let outputKey = key;
          // Preserve literal names and future masked names before assigning a suffix.
          if (used.has(key) || (original !== key && unchanged.has(key))) {
            let index = 2;
            do {
              outputKey = `${key}#${index++}`;
            } while (reserved.has(outputKey) || used.has(outputKey));
          }
          used.add(outputKey);
          return [outputKey, mask(item)];
        }),
      );
    }
    return value;
  };
  return mask(value) as T;
}

export function redactError(value: string, apiKey: string): string {
  return (apiKey ? value.split(apiKey).join('[REDACTED]') : value)
    .replace(
      /\b(authorization|proxy-authorization|x-api-key)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;]+)/gi,
      '$1: [REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/]*@/gi, '$1[REDACTED]@');
}

const timeouts = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const temporary = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
]);
const permanent = new Set([
  'ENOTFOUND',
  'EPROTO',
  'EACCES',
  'EPERM',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

export function transportError(
  error: unknown,
  context: AttemptContext,
  provider: string,
  networkMessage: MessageKey,
  safe: (value: string) => string,
): { error: AppError; retry: boolean } | undefined {
  if (context.signal.aborted) throw error;
  const cause = error instanceof Error ? error.cause : undefined;
  const code = systemCode(cause) ?? systemCode(error);
  const fetchFailure =
    error instanceof TypeError && error.message === 'fetch failed' && cause instanceof Error;
  const known =
    code !== undefined &&
    (timeouts.has(code) ||
      temporary.has(code) ||
      permanent.has(code) ||
      code.startsWith('ERR_TLS_') ||
      code.startsWith('ERR_SSL_') ||
      code.startsWith('UND_ERR_'));
  if (!known && !fetchFailure) return undefined;
  const timedOut = code !== undefined && timeouts.has(code);
  return {
    error: new AppError(
      timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
      timedOut ? 'requestTimeout' : networkMessage,
      {
        provider,
        ...(code ? { system_code: safe(code) } : {}),
        ...(timedOut ? { timeout_scope: 'request' } : {}),
        ...(context.httpStatus === undefined ? {} : { http_status: context.httpStatus }),
        ...(context.requestId ? { request_id: context.requestId } : {}),
      },
    ),
    retry:
      context.retryAllowed !== false && (timedOut || (code !== undefined && temporary.has(code))),
  };
}
