export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type FailureExitCode = 2 | 3 | 4 | 5 | 130;
export type ExitCode = 0 | FailureExitCode | 6;

export type PublicError = {
  code: string;
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
