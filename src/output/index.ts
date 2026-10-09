import type { Writable } from 'node:stream';
import { AppError, failure, fileError } from '../errors.js';
import { text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { ExitCode, JsonValue, Outcome } from '../result.js';
import { prepareOutput } from './file.js';
import type { OutputFile } from './file.js';
import { errorText, line, render } from './render.js';
import type { RenderOptions } from './render.js';

export interface Channels {
  stdout: (content: string) => Promise<void>;
  stderr: (content: string) => Promise<void>;
}

export function writeText(stream: Writable, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.write(content, 'utf8', (error) => {
      // A live stream emits its write error after this callback.
      if (!error || stream.closed) stream.removeListener('error', reject);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export function processChannels(): Channels {
  return {
    stdout: (content) => writeText(process.stdout, content),
    stderr: (content) => writeText(process.stderr, content),
  };
}

export async function reportOutputError<T extends JsonValue>(
  error: unknown,
  channels: Channels,
  language: Language,
  previous?: Outcome<T>,
  options?: RenderOptions<T>,
): Promise<ExitCode> {
  const problem = fileError(error, 'stdout/stderr', 'write');
  try {
    if (previous && options) {
      const failed = failure(problem, language, previous);
      const rendered = render(failed, {
        ...options,
        format: options.format === 'json' ? 'json' : 'text',
        verbose: false,
      });
      await channels.stderr(rendered.details + rendered.content);
    } else {
      await channels.stderr(
        line(`${text(language, 'error')}: ${errorText(problem.public(language), language)}`),
      );
    }
  } catch {
    // Neither output channel is writable; failure remains visible in the exit status.
  }
  return 5;
}

export async function display<T extends JsonValue>(
  outcome: Outcome<T>,
  options: RenderOptions<T>,
  channels: Channels,
): Promise<ExitCode> {
  const rendered = render(outcome, options);
  try {
    if (rendered.content) await channels.stdout(rendered.content);
    if (rendered.details) await channels.stderr(rendered.details);
    return rendered.outcome.exitCode;
  } catch (error) {
    return reportOutputError(error, channels, options.language, rendered.outcome, options);
  }
}

export interface OutputOptions<T extends JsonValue> extends RenderOptions<T> {
  previous?: Outcome<T>;
  output?: string;
  cwd?: string;
  signal?: AbortSignal;
}

export async function execute<T extends JsonValue>(
  operation: () => Promise<Outcome<T>>,
  options: OutputOptions<T>,
  channels: Channels = processChannels(),
): Promise<ExitCode> {
  let file: OutputFile | undefined;
  let outcome: Outcome<T>;
  const cancelled = (previous: Outcome<T>, savedPath?: string): Outcome<T> => {
    if (!options.signal?.aborted || previous.exitCode === 130) return previous;
    return failure(
      new AppError(
        'CANCELLED',
        savedPath ? 'cancelledSaved' : 'cancelled',
        savedPath ? { path: savedPath, output_saved: true } : undefined,
      ),
      options.language,
      previous,
    );
  };
  try {
    if (options.signal?.aborted) throw new AppError('CANCELLED', 'cancelled');
    if (options.output !== undefined) file = await prepareOutput(options.output, options.cwd);
    if (options.signal?.aborted) throw new AppError('CANCELLED', 'cancelled');
    outcome = await operation();
  } catch (error) {
    outcome = failure<T>(error, options.language, options.previous);
  }
  outcome = cancelled(outcome);
  let rendered = render(outcome, options);
  outcome = rendered.outcome;
  let savedPath: string | undefined;
  if (file) {
    try {
      if (
        outcome.exitCode !== 130 &&
        outcome.result.error?.code !== 'RENDER_ERROR' &&
        (outcome.result.status === 'success' || outcome.result.data !== undefined)
      ) {
        await file.save(rendered.content, options.signal);
        savedPath = file.path;
      }
    } catch (error) {
      outcome = failure(error, options.language, outcome);
    }
    outcome = cancelled(outcome, savedPath);
    try {
      await file.cleanup();
    } catch (error) {
      if (outcome.exitCode === 130) {
        const cleanup = (
          error instanceof AppError ? error : fileError(error, file.temporaryPath, 'cleanup')
        ).public(options.language);
        const details = outcome.result.error.details;
        outcome = {
          ...outcome,
          result: {
            ...outcome.result,
            error: {
              ...outcome.result.error,
              details: { ...details, causes: [...(details?.causes ?? []), cleanup] },
            },
          },
        };
      } else {
        outcome = failure(error, options.language, outcome);
      }
    }
  }
  outcome = cancelled(outcome, savedPath);
  if (outcome !== rendered.outcome) rendered = render(outcome, options);
  try {
    if (savedPath !== undefined && rendered.outcome.exitCode !== 130) {
      if (rendered.outcome.result.status !== 'success') {
        const error = rendered.outcome.result.error;
        await channels.stderr(
          line(
            `${text(options.language, rendered.outcome.result.status === 'partial' ? 'partial' : 'error')}: ${errorText(error, options.language)}\n${text(options.language, 'saved')}: ${savedPath}`,
          ),
        );
        rendered.details = rendered.execution;
      }
    } else {
      if (rendered.content) await channels.stdout(rendered.content);
    }
    if (rendered.details) await channels.stderr(rendered.details);
    return rendered.outcome.exitCode;
  } catch (error) {
    return reportOutputError(error, channels, options.language, rendered.outcome, options);
  }
}
