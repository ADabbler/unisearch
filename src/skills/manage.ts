import fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findPackageJSON } from 'node:module';
import { canonicalPath } from '../config/write.js';
import { checkCancellation } from '../config/manage.js';
import { AppError, failure, fileError, systemCode } from '../errors.js';
import type { Language } from '../i18n/messages.js';
import { success } from '../result.js';
import type { JsonObject, Outcome, PublicError } from '../result.js';
import type { TargetPath } from './targets.js';

export const skillSource = join(dirname(findPackageJSON(import.meta.url)!), 'skills', 'unisearch');
export type SkillAction = 'install' | 'update' | 'status' | 'remove';
export type TargetResult = JsonObject & TargetPath & { state: string };
export type SkillsData = JsonObject & { targets: TargetResult[] };
type Node =
  | { kind: 'directory'; children: Map<string, Node> }
  | { kind: 'file'; bytes: Buffer }
  | { kind: 'link' };

async function readTree(
  path: string,
  source = false,
  readBytes = true,
  root = true,
  signal?: AbortSignal,
): Promise<Node | undefined> {
  checkCancellation(signal);
  let stat;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if (systemCode(error) === 'ENOENT') return undefined;
    throw systemCode(error) ? fileError(error, path, 'lstat') : error;
  }
  try {
    if (stat.isSymbolicLink() && !source) return { kind: 'link' };
    if (stat.isFile()) {
      if (root && !source) throw new AppError('FILE_IO_ERROR', 'skillNode', { path });
      return { kind: 'file', bytes: readBytes ? await fs.readFile(path) : Buffer.alloc(0) };
    }
    if (stat.isDirectory()) {
      const children = new Map<string, Node>();
      for (const name of (await fs.readdir(path)).sort()) {
        const child = await readTree(join(path, name), source, readBytes, false, signal);
        if (!child) throw Object.assign(new Error(), { code: 'ENOENT' });
        children.set(name, child);
      }
      return { kind: 'directory', children };
    }
    throw new AppError('FILE_IO_ERROR', 'skillNode', { path });
  } catch (error) {
    throw systemCode(error) ? fileError(error, path, 'read') : error;
  }
}

async function readComparableTree(path: string, signal?: AbortSignal): Promise<Node | undefined> {
  const node = await readTree(path, false, true, true, signal);
  if (node?.kind !== 'link') return node;
  let resolved: string;
  try {
    resolved = await fs.realpath(path);
  } catch (error) {
    if (systemCode(error) === 'ENOENT') return node;
    throw systemCode(error) ? fileError(error, path, 'resolve') : error;
  }
  return readTree(resolved, false, true, true, signal);
}

function compare(source: Node, target: Node): JsonObject {
  const differences: Record<string, string[]> = { missing: [], modified: [], extra: [] };
  function walk(a: Node, b: Node, path: string) {
    if (a.kind !== b.kind || (a.kind === 'file' && b.kind === 'file' && !a.bytes.equals(b.bytes))) {
      differences.modified.push(path || '.');
    } else if (a.kind === 'directory' && b.kind === 'directory') {
      for (const [name, child] of a.children) {
        const p = path ? `${path}/${name}` : name;
        const other = b.children.get(name);
        if (!other) differences.missing.push(p);
        else walk(child, other, p);
      }
      for (const name of b.children.keys())
        if (!a.children.has(name)) differences.extra.push(path ? `${path}/${name}` : name);
    }
  }
  walk(source, target, '');
  return Object.fromEntries(
    Object.entries(differences)
      .filter(([, paths]) => paths.length)
      .map(([kind, paths]) => [kind, paths.sort()]),
  );
}

function contains(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}
function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

export async function preflightSkills(
  targets: TargetPath[],
  source = skillSource,
  configPath?: string,
): Promise<void> {
  const nodes: string[] = [];
  const sourcePath = await canonicalPath(source).catch((error) => {
    throw systemCode(error) ? fileError(error, source, 'resolve') : error;
  });
  const config =
    configPath === undefined
      ? undefined
      : await canonicalPath(configPath).catch((error) => {
          throw systemCode(error) ? fileError(error, configPath, 'resolve') : error;
        });
  for (const target of targets) {
    if (config && overlaps(resolve(target.path), config))
      throw new AppError('INVALID_ARGUMENT', 'skillsOverlap');
    let node: string;
    try {
      node = join(await canonicalPath(dirname(target.path)), basename(target.path));
    } catch (error) {
      // Per-target resolution failures are reported by the installer; no node can be written here.
      if (systemCode(error)) continue;
      throw error;
    }
    if (
      overlaps(node, sourcePath) ||
      nodes.some((previous) => overlaps(previous, node)) ||
      (config && overlaps(node, config))
    )
      throw new AppError('INVALID_ARGUMENT', 'skillsOverlap');
    nodes.push(node);
  }
  if (config && overlaps(sourcePath, config))
    throw new AppError('INVALID_ARGUMENT', 'skillsOverlap');
}

async function writeTree(node: Node, path: string, signal?: AbortSignal): Promise<void> {
  checkCancellation(signal);
  if (node.kind === 'file') await fs.writeFile(path, node.bytes, { flag: 'wx' });
  else if (node.kind === 'directory') {
    await fs.mkdir(path);
    for (const [name, child] of node.children) await writeTree(child, join(path, name), signal);
  } else throw new AppError('FILE_IO_ERROR', 'skillNode', { path });
}

export async function manageSkills(
  action: SkillAction,
  targets: TargetPath[],
  language: Language,
  signal?: AbortSignal,
  source = skillSource,
): Promise<Outcome<SkillsData>> {
  const data: SkillsData = {
    targets: targets.map((target) => ({ ...target, state: 'not_started' })),
  };
  let tree: Node | undefined;
  if (action !== 'remove' && targets.length) {
    try {
      tree = await readTree(source, true, true, true, signal);
    } catch (error) {
      if (signal?.aborted)
        return failure(new AppError('CANCELLED', 'cancelled'), language, success(data));
      throw error;
    }
    if (tree?.kind !== 'directory' || tree.children.get('SKILL.md')?.kind !== 'file')
      throw new AppError('FILE_IO_ERROR', 'skillNode', { path: source });
  }
  let fatal: unknown;
  for (const item of data.targets) {
    if (signal?.aborted) break;
    let changed: boolean | 'unknown' = false;
    let temporary: string | undefined;
    let operation = 'read';
    try {
      const parent = await canonicalPath(dirname(item.path));
      const path = join(parent, basename(item.path));
      const rawExisting = await readTree(path, false, action !== 'remove', true, signal);
      const existing =
        action === 'remove' || rawExisting?.kind !== 'link'
          ? rawExisting
          : await readComparableTree(path, signal);
      checkCancellation(signal);
      if (action === 'remove') {
        operation = 'remove';
        if (existing) {
          changed = existing.kind === 'directory' ? 'unknown' : false;
          await fs.rm(path, { recursive: existing.kind === 'directory' });
          changed = true;
        }
        item.state = existing ? 'removed' : 'absent';
      } else if (!existing && action === 'update')
        throw new AppError('SKILL_NOT_INSTALLED', 'skillsMissing');
      else {
        const differences = existing ? compare(tree!, existing) : {};
        if (action === 'status') {
          if (!existing) item.state = 'absent';
          else if (Object.keys(differences).length) item.state = 'different';
          else item.state = 'current';
          if (item.state === 'different') item.differences = differences;
        } else if (existing && !Object.keys(differences).length) item.state = 'unchanged';
        else {
          operation = 'prepare';
          await fs.mkdir(parent, { recursive: true });
          temporary = await fs.mkdtemp(join(parent, '.unisearch-skill-'));
          const staged = join(temporary, 'unisearch');
          await writeTree(tree!, staged, signal);
          checkCancellation(signal);
          if (existing) {
            operation = 'remove';
            changed = existing.kind === 'directory' ? 'unknown' : false;
            await fs.rm(path, { recursive: existing.kind === 'directory' });
            changed = true;
          }
          operation = 'rename';
          await fs.rename(staged, path);
          changed = true;
          item.state = existing ? 'updated' : 'installed';
        }
      }
    } catch (error) {
      let known: AppError;
      if (error instanceof AppError) known = error;
      else if (systemCode(error)) known = fileError(error, item.path, operation);
      else known = new AppError('INTERNAL_ERROR', 'internal');
      item.state = 'failed';
      item.error = known.public(language);
      if (action !== 'status') item.changed = changed;
      if (known.code === 'INTERNAL_ERROR' || known.code === 'CANCELLED') fatal = known;
    }
    if (temporary) {
      try {
        await fs.rm(temporary, { recursive: true });
      } catch (error) {
        const problem = systemCode(error)
          ? fileError(error, temporary, 'cleanup')
          : new AppError('INTERNAL_ERROR', 'internal');
        if (problem.code === 'INTERNAL_ERROR') fatal = problem;
        const cleanup = problem.public(language);
        const prior = item.error as JsonObject | undefined;
        item.error = prior
          ? { ...prior, details: { ...(prior.details as JsonObject), causes: [cleanup] } }
          : cleanup;
        item.state = 'failed';
        item.changed = changed;
      }
    }
    if (fatal) break;
  }
  if (signal?.aborted || fatal) {
    const result = failure<SkillsData>(
      signal?.aborted ? new AppError('CANCELLED', 'cancelled') : fatal,
      language,
      success(data),
    );
    const errors = data.targets.flatMap((item) => (item.error ? [item.error as PublicError] : []));
    if (errors.length && result.result.error) result.result.error.details = { causes: errors };
    return result;
  }
  const failed = data.targets.filter((item) => item.state === 'failed').length;
  if (!failed) return success(data);
  const error = new AppError('SKILL_TARGETS_FAILED', 'skillsFailed').public(language);
  return failed === data.targets.length
    ? { result: { status: 'error', data, error }, exitCode: 5 }
    : { result: { status: 'partial', data, error }, exitCode: 6 };
}
