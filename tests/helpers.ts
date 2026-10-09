import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Channels } from '../src/output/index.js';
import type { ConfigContext } from '../src/config/path.js';

function removeDirectory(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) removeDirectory(child);
    else unlinkSync(child);
  }
  rmdirSync(path);
}

export function temporary(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'unisearch-test-'));
  t.after(() => removeDirectory(path));
  return path;
}

export function context(path: string, env: NodeJS.ProcessEnv = {}): ConfigContext {
  return { cwd: path, env, home: () => path, platform: process.platform };
}

export function capture(): Channels & { out: string; err: string } {
  return {
    out: '',
    err: '',
    async stdout(value) {
      this.out += value;
    },
    async stderr(value) {
      this.err += value;
    },
  };
}
