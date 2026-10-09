import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { AppError, fileError, systemCode } from '../errors.js';

export class OutputFile {
  private closed = false;
  private saved = false;

  constructor(
    readonly path: string,
    readonly temporaryPath: string,
    private handle: FileHandle,
  ) {}

  async save(content: string, signal?: AbortSignal): Promise<void> {
    let operation = 'write';
    try {
      if (signal?.aborted) throw new AppError('CANCELLED', 'cancelled');
      await this.handle.writeFile(content, 'utf8');
      operation = 'close';
      await this.close();
      if (signal?.aborted) throw new AppError('CANCELLED', 'cancelled');
      operation = 'rename';
      await fs.rename(this.temporaryPath, this.path);
      this.saved = true;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw fileError(error, this.path, operation);
    }
  }

  async cleanup(): Promise<void> {
    try {
      await this.close();
      if (!this.saved) await fs.unlink(this.temporaryPath);
    } catch (error) {
      throw fileError(error, this.temporaryPath, 'cleanup');
    }
  }

  private async close(): Promise<void> {
    if (!this.closed) {
      await this.handle.close();
      this.closed = true;
    }
  }
}

export async function prepareOutput(value: string, cwd = process.cwd()): Promise<OutputFile> {
  if (value.length === 0)
    throw new AppError('INVALID_ARGUMENT', 'emptyOutput', { option: '--output' });
  const path = resolve(cwd, value);
  try {
    const parent = await fs.stat(dirname(path));
    if (!parent.isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' });
    try {
      if ((await fs.stat(path)).isDirectory()) throw Object.assign(new Error(), { code: 'EISDIR' });
    } catch (error) {
      if (systemCode(error) !== 'ENOENT') throw error;
    }
    const temporaryPath = join(dirname(path), `.unisearch-${randomUUID()}.tmp`);
    return new OutputFile(path, temporaryPath, await fs.open(temporaryPath, 'wx'));
  } catch (error) {
    throw fileError(error, path, 'prepare');
  }
}
