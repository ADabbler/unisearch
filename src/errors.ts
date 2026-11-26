import { text } from './i18n/messages.js';
import type { Language, MessageKey } from './i18n/messages.js';
import { errorExitCodes } from './result.js';
import type { ErrorDetails, FailureExitCode, JsonValue, Outcome, PublicError } from './result.js';

export class AppError extends Error {
  readonly exitCode: FailureExitCode;

  constructor(
    readonly code: keyof typeof errorExitCodes,
    readonly key: MessageKey,
    readonly details?: ErrorDetails,
  ) {
    super(text('en', key));
    this.name = 'AppError';
    this.exitCode = errorExitCodes[code];
  }

  public(language: Language): PublicError {
    return publicError(this.code, this.key, language, this.details);
  }
}

export function publicError(
  code: PublicError['code'],
  key: MessageKey,
  language: Language,
  details?: ErrorDetails,
): PublicError {
  const message = text(language, key);
  let normalized = normalizeDetails(details);
  if (normalized?.upstream_message === message) {
    normalized = { ...normalized };
    delete normalized.upstream_message;
  }
  return {
    code,
    message,
    ...(normalized && Object.keys(normalized).length ? { details: normalized } : {}),
  };
}

export function httpFailure(
  { code, key }: Pick<AppError, 'code' | 'key'>,
  details: ErrorDetails,
  language: Language,
  invalidBody: boolean,
) {
  const diagnostic = { ...details };
  if (code === 'TIMEOUT') diagnostic.timeout_scope = 'request';
  if (invalidBody) {
    diagnostic.reason ??= 'error_body_invalid';
    if (diagnostic.reason !== 'error_body_invalid') diagnostic.error_body_invalid = true;
  }
  const error = publicError(code, key, language, diagnostic);
  if (invalidBody && code !== 'INVALID_RESPONSE')
    error.message += `${language === 'zh' ? '；' : '; '}${text(language, 'errorBodyInvalid')}`;
  return { result: { status: 'error' as const, error }, exitCode: errorExitCodes[code] };
}

/**
 * A page-level failure already reports why the target could not be read. Advertise the
 * API call's own 200 beside it and readers take that as the page status, so the
 * redundant value is dropped once, before either output format renders details.
 */
export function normalizeDetails(details: ErrorDetails | undefined): ErrorDetails | undefined {
  if (!details || typeof details.page_status !== 'number' || details.http_status !== 200)
    return details;
  const { http_status: _omitted, ...rest } = details;
  return rest;
}

export function systemCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

export function fileError(error: unknown, path: string, operation: string): AppError {
  const code = systemCode(error);
  return new AppError('FILE_IO_ERROR', 'fileIO', {
    path,
    operation,
    ...(code ? { system_code: code } : {}),
  });
}

export function failure<T extends JsonValue>(
  error: unknown,
  language: Language,
  previous?: Outcome<T>,
): Outcome<T> {
  const known = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'internal');
  const reported = known.public(language);
  if (previous?.result.error) {
    reported.details = {
      ...reported.details,
      causes: [...(reported.details?.causes ?? []), previous.result.error],
    };
  }
  return {
    result: {
      status: 'error',
      error: reported,
      ...(previous?.result.data === undefined ? {} : { data: previous.result.data }),
      ...(previous?.result.meta ? { meta: previous.result.meta } : {}),
    },
    exitCode: known.exitCode,
  };
}
