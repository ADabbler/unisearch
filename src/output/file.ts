import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { AppError, fileError, systemCode } from '../errors.js';

async function targetMode(path: string): Promise<number | undefined> {
  try {
    const target = await fs.stat(path);
    if (target.isDirectory()) throw Object.assign(new Error(), { code: 'EISDIR' });
    if (process.platform !== 'win32' && target.isFile()) return target.mode & 0o777;
  } catch (error) {
    if (systemCode(error) !== 'ENOENT') throw error;
  }
}

export class OutputFile {
  private closed = false;
  private saved = false;

  constructor(
    readonly path: string,
    readonly temporaryPath: string,
    private handle: FileHandle,
    private readonly existingMode?: number,
  ) {}

  async save(content: string, signal?: AbortSignal): Promise<void> {
    let operation = 'stat';
    try {
      if (signal?.aborted) throw new AppError('CANCELLED', 'cancelled');
      let mode = this.existingMode;
      if (process.platform !== 'win32') {
        mode = (await targetMode(this.path)) ?? mode;
        if (mode !== undefined && this.existingMode === undefined) {
          // A destination appeared while the request was running.
          operation = 'chmod';
          await this.handle.chmod(0o600);
        }
      }
      operation = 'write';
      await this.handle.writeFile(content, 'utf8');
      if (mode !== undefined) {
        operation = 'chmod';
        await this.handle.chmod(mode);
      }
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
    const existingMode = await targetMode(path);
    const temporaryPath = join(dirname(path), `.unisearch-${randomUUID()}.tmp`);
    const handle = await fs.open(
      temporaryPath,
      'wx',
      existingMode === undefined ? undefined : 0o600,
    );
    return new OutputFile(path, temporaryPath, handle, existingMode);
  } catch (error) {
    throw fileError(error, path, 'prepare');
  }
}
