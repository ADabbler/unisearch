import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../errors.js';
import { text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { JsonObject } from '../result.js';
import {
  assertValid,
  fields,
  fieldAt,
  invalidKey,
  isObject,
  issue,
  knownPath,
  parseInput,
  providers,
  putValue,
  redact,
  valueAt,
  within,
} from './fields.js';
import type { ConfigDocument } from './read.js';
import { inspectConfig, parentProblems, resolveField } from './resolve.js';

function providerRank(name: string): number {
  const index = providers.findIndex((provider) => provider === name);
  return index === -1 ? providers.length : index;
}

export function queryConfig(
  document: ConfigDocument,
  env: NodeJS.ProcessEnv,
  language: Language,
  key?: string,
  includeDefaults = false,
): JsonObject {
  if (key !== undefined && !knownPath(key)) throw invalidKey(key);
  const { resolved, problems } = inspectConfig(document.values, env, key);
  assertValid(problems, language);
  if (key && fields.some((field) => field.path === key)) {
    const item = resolved[0];
    return {
      key,
      ...(item.value === undefined ? {} : { value: redact(item.field, item.value) }),
      source: item.source,
    };
  }
  const values: JsonObject = {};
  const sources: JsonObject = {};
  for (const item of resolved.toSorted(
    (a, b) =>
      providerRank(a.field.path.split('.')[1] ?? '') -
      providerRank(b.field.path.split('.')[1] ?? ''),
  )) {
    if (
      item.value === undefined ||
      (key === undefined && item.source === 'default' && !includeDefaults)
    )
      continue;
    const path = key ? item.field.path.slice(key.length + 1) : item.field.path;
    putValue(values, path, redact(item.field, item.value));
    sources[path] = item.source;
  }
  return {
    ...(key ? { key, value: values } : { values }),
    ...(Object.keys(sources).length ? { sources } : {}),
  };
}

export interface Mutation {
  values: Record<string, unknown>;
  changed: boolean;
  data: JsonObject;
}

export function prepareMutation(
  document: ConfigDocument,
  env: NodeJS.ProcessEnv,
  language: Language,
  key: string,
  input?: string,
): Mutation {
  const setting = input !== undefined;
  const field = setting ? fieldAt(key) : undefined;
  const value = field ? parseInput(field, input!) : undefined;
  const known = knownPath(key);
  const previous = valueAt(document.values, key);
  if (!known && (key.split('.').some((part) => !part) || previous === undefined))
    throw invalidKey(key);
  const parents = parentProblems(document.values, key);
  assertValid(parents, language);
  const changed = setting ? !isDeepStrictEqual(previous, value) : previous !== undefined;
  const values = structuredClone(document.values);
  if (changed) {
    if (setting) putValue(values as JsonObject, key, value!);
    else {
      const parts = key.split('.');
      const leaf = parts.pop()!;
      const ancestors: { parent: Record<string, unknown>; key: string }[] = [];
      let parent = values;
      for (const part of parts) {
        ancestors.push({ parent, key: part });
        parent = parent[part] as Record<string, unknown>;
      }
      delete parent[leaf];
      for (const ancestor of ancestors.reverse()) {
        const child = ancestor.parent[ancestor.key];
        if (isObject(child) && Object.keys(child).length === 0)
          delete ancestor.parent[ancestor.key];
        else break;
      }
    }
  }
  const data: JsonObject = {
    ...(known ? { key } : {}),
    ...(field ? { value: redact(field, value!) } : {}),
    changed: false,
  };
  if (
    setting &&
    [
      'providers.model.model.id',
      'providers.model.model.effort',
      'providers.model.fallback_models',
    ].includes(key)
  ) {
    const duplicate = resolveField(
      values,
      {},
      fieldAt('providers.model.fallback_models'),
    ).problems.find((problem) => problem.message === 'duplicateModel');
    if (duplicate) throw new AppError('INVALID_ARGUMENT', 'duplicateModel', { field: key });
  }
  const overrides: JsonObject = {};
  const issues: JsonObject[] = [];
  for (const affected of fields.filter((item) => within(item.path, key))) {
    if (!affected.environment || env[affected.environment] === undefined) continue;
    overrides[affected.path] = affected.environment;
    for (const problem of resolveField(values, env, affected).problems) {
      const reported = issue(problem, language);
      reported.message += `${language === 'zh' ? '；' : '; '}${text(language, 'envRepair')}`;
      issues.push(reported);
    }
  }
  if (Object.keys(overrides).length) data.overrides = overrides;
  if (issues.length) data.issues = issues;
  return { values, changed, data };
}

export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError('CANCELLED', 'cancelled');
}

export function configText(values: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ['providers', ...Object.keys(values).filter((key) => key !== 'providers')]) {
    if (!Object.hasOwn(values, key)) continue;
    let value = values[key];
    if (key === 'providers' && isObject(value)) {
      value = Object.fromEntries(
        Object.entries(value).toSorted(([a], [b]) => providerRank(a) - providerRank(b)),
      );
    }
    Object.defineProperty(ordered, key, { value, enumerable: true });
  }
  return `${JSON.stringify(
    ordered,
    (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new AppError('INVALID_CONFIG', 'nonfiniteConfig');
      return value;
    },
    2,
  )}\n`;
}
