import { text } from './i18n/messages.js';
import type { Language, MessageKey } from './i18n/messages.js';
import type { FailureExitCode, JsonObject, JsonValue, Outcome, PublicError } from './result.js';

const codes = {
  INVALID_ARGUMENT: 2,
  CONFIG_PATH_ERROR: 3,
  CONFIG_NOT_FOUND: 3,
  CONFIG_READ_ERROR: 3,
  CONFIG_PARSE_ERROR: 3,
  INVALID_CONFIG: 3,
  MISSING_CONFIG: 3,
  SERVICE_DISABLED: 3,
  AUTHENTICATION_ERROR: 3,
  ACCESS_DENIED: 3,
  QUOTA_EXCEEDED: 4,
  TIMEOUT: 4,
  RATE_LIMITED: 4,
  UPSTREAM_ERROR: 4,
  NETWORK_ERROR: 4,
  INVALID_RESPONSE: 4,
  CONTENT_UNAVAILABLE: 4,
  MODEL_UNAVAILABLE: 4,
  FILE_IO_ERROR: 5,
  SKILL_NOT_INSTALLED: 5,
  SKILL_TARGETS_FAILED: 5,
  SETUP_SKILLS_FAILED: 5,
  RENDER_ERROR: 5,
  INTERNAL_ERROR: 5,
  CANCELLED: 130,
} as const;

export class AppError extends Error {
  readonly exitCode: FailureExitCode;

  constructor(
    readonly code: keyof typeof codes,
    readonly key: MessageKey,
    readonly details?: JsonObject,
  ) {
    super(text('en', key));
    this.name = 'AppError';
    this.exitCode = codes[code];
  }

  public(language: Language): PublicError {
    return {
      code: this.code,
      message: text(language, this.key),
      ...(this.details && Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
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
