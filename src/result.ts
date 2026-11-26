export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type FailureExitCode = 2 | 3 | 4 | 5 | 130;
export type ExitCode = 0 | FailureExitCode | 6;

export const errorExitCodes = {
  INVALID_ARGUMENT: 2,
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
  RENDER_ERROR: 5,
  INTERNAL_ERROR: 5,
  CANCELLED: 130,
} as const satisfies Record<string, FailureExitCode>;

export type PublicError = {
  code:
    | keyof typeof errorExitCodes
    | 'PARTIAL_FAILURE'
    | 'ALL_PROVIDERS_FAILED'
    | 'DOCTOR_CHECKS_FAILED'
    | 'SKILL_TARGETS_FAILED';
  message: string;
  details?: ErrorDetails;
};

export type ErrorDetails = JsonObject & {
  causes?: PublicError[];
  failures?: (PublicError & ({ provider: string } | { url: string }))[];
};

type Content<T> = { data?: T; meta?: JsonObject };
export type Result<T extends JsonValue = JsonValue> = Content<T> &
  (
    | { status: 'success'; error?: never }
    | { status: 'partial'; data: T; error: PublicError }
    | { status: 'error'; error: PublicError }
  );

export type Outcome<T extends JsonValue = JsonValue> =
  | { result: Extract<Result<T>, { status: 'success' }>; exitCode: 0 }
  | { result: Extract<Result<T>, { status: 'partial' }>; exitCode: 6 }
  | { result: Extract<Result<T>, { status: 'error' }>; exitCode: FailureExitCode };

export function success<T extends JsonValue>(data?: T): Outcome<T> {
  return { result: { status: 'success', ...(data === undefined ? {} : { data }) }, exitCode: 0 };
}
