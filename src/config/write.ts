import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { AppError, failure, systemCode } from '../errors.js';
import type { Language } from '../i18n/messages.js';
import { success } from '../result.js';
import type { JsonObject, Outcome } from '../result.js';
import { checkCancellation, configText } from './manage.js';
import type { Mutation } from './manage.js';

// Resolve existing ancestors as well as the file, so new files under directory links compare correctly.
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch (error) {
    if (systemCode(error) !== 'ENOENT' || dirname(path) === path) throw error;
    let isLink = false;
    try {
      isLink = (await fs.lstat(path)).isSymbolicLink();
    } catch (entryError) {
      if (systemCode(entryError) !== 'ENOENT') throw entryError;
    }
    if (isLink) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

function writeError(error: unknown, path: string, operation: string): AppError {
  const code = systemCode(error);
  return new AppError('FILE_IO_ERROR', 'configWrite', {
    path,
    operation,
    ...(code ? { system_code: code } : {}),
  });
}

export async function configWriteTarget(path: string): Promise<string> {
  try {
    return await canonicalPath(path);
  } catch (error) {
    throw writeError(error, path, 'resolve');
  }
}

export async function saveConfig(
  mutation: Mutation,
  path: string,
  language: Language,
  signal?: AbortSignal,
): Promise<Outcome<JsonObject>> {
  const data = { ...mutation.data };
  let handle: FileHandle | undefined;
  let closed = false;
  let temporaryPath: string | undefined;
  let operation = 'mkdir';
  let outcome: Outcome<JsonObject>;
  try {
    checkCancellation(signal);
    if (mutation.changed) {
      const content = configText(mutation.values);
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      checkCancellation(signal);
      operation = 'open';
      const candidate = join(dirname(path), `.unisearch-config-${randomUUID()}.tmp`);
      handle = await fs.open(candidate, 'wx', 0o600);
      temporaryPath = candidate;
      checkCancellation(signal);
      operation = 'write';
      await handle.writeFile(content, 'utf8');
      operation = 'close';
      await handle.close();
      closed = true;
      checkCancellation(signal);
      operation = 'rename';
      await fs.rename(temporaryPath, path);
      data.changed = true;
      temporaryPath = undefined;
    }
    outcome = success(data);
    if (signal?.aborted)
      outcome = failure(new AppError('CANCELLED', 'cancelled'), language, outcome);
  } catch (error) {
    outcome = failure(
      error instanceof AppError ? error : writeError(error, path, operation),
      language,
    );
  }
  const cleanupErrors: AppError[] = [];
  if (handle && !closed) {
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(writeError(error, temporaryPath!, 'close'));
    }
  }
  if (temporaryPath) {
    try {
      await fs.unlink(temporaryPath);
    } catch (error) {
      cleanupErrors.push(writeError(error, temporaryPath, 'cleanup'));
    }
  }
  for (const error of cleanupErrors) {
    if (outcome.exitCode === 130) {
      const details = outcome.result.error.details;
      outcome.result.error.details = {
        ...details,
        causes: [...(details?.causes ?? []), error.public(language)],
      };
    } else outcome = failure(error, language, outcome);
  }
  return outcome;
}
