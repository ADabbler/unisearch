import {
  fields,
  isObject,
  knownPath,
  sections,
  validate,
  valueAt,
  within,
  parseLiteral,
  modelIdentity,
  token,
  fieldAt,
} from './fields.js';
import type { Field, Problem, ModelCandidate } from './fields.js';
import type { JsonValue } from '../result.js';

export interface ResolvedField {
  field: Field;
  value?: JsonValue;
  source: string;
  problems: Problem[];
}

export function parentProblems(values: Record<string, unknown>, path: string): Problem[] {
  const parts = path.split('.');
  for (let index = 1; index < parts.length; index++) {
    const field = parts.slice(0, index).join('.');
    const value = valueAt(values, field);
    if (value === undefined) break;
    if (!isObject(value))
      return [{ field, source: 'config', code: 'INVALID_TYPE', message: 'objectRequired' }];
  }
  return [];
}

export function resolveField(
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  field: Field,
  overrides: Record<string, ResolvedField> = {},
): ResolvedField {
  if (field.variants) {
    const dependency = resolveField(values, env, fieldAt(field.variants.field), overrides);
    if (dependency.problems.length)
      return { field, source: dependency.source, problems: dependency.problems };
    const variant = field.variants.cases[String(dependency.value)];
    if (variant) field = { ...field, ...variant };
  }
  const override = overrides[field.path];
  if (override && !field.variants) return override;
  const raw = field.environment ? env[field.environment] : undefined;
  const environment = raw !== undefined ? field.environment : undefined;
  const saved = valueAt(values, field.path);
  let value: unknown;
  let source: string;
  if (override) {
    value = override.value;
    source = override.source;
  } else if (environment) {
    value = parseLiteral(field, raw!);
    source = environment;
  } else if (saved !== undefined) {
    value = saved;
    source = 'config';
  } else {
    value = field.default;
    source = value === undefined ? 'unset' : 'default';
  }
  const problems = override || environment ? [] : parentProblems(values, field.path);
  if (value !== undefined && !problems.length) {
    const invalid = validate(field, value);
    if (invalid)
      problems.push({
        ...invalid,
        code: environment && invalid.code === 'INVALID_TYPE' ? 'INVALID_VALUE' : invalid.code,
        field: field.path,
        source: !override && environment ? 'environment' : source,
        ...(!override && environment ? { environment } : {}),
      });
  }
  if (field.kind === 'models' && !problems.length && Array.isArray(value)) {
    const main = valueAt(values, 'providers.model.model');
    if (
      isObject(main) &&
      token(main.id) &&
      (main.effort === undefined || token(main.effort)) &&
      value.some(
        (candidate) =>
          modelIdentity(candidate as ModelCandidate) === modelIdentity(main as ModelCandidate),
      )
    ) {
      problems.push({
        field: field.path,
        source: 'config',
        code: 'INVALID_VALUE',
        message: 'duplicateModel',
      });
    }
  }
  return {
    field,
    source,
    ...(value === undefined || problems.length ? {} : { value: value as JsonValue }),
    problems,
  };
}

export function inspectConfig(
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  scope = '',
  overrides: Record<string, ResolvedField> = {},
) {
  const resolved = fields
    .filter((field) => within(field.path, scope))
    .map((field) => resolveField(values, env, field, overrides));
  const problems: Problem[] = [];
  const add = (problem: Problem) => {
    if (
      !problems.some(
        (item) =>
          item.field === problem.field &&
          item.source === problem.source &&
          item.code === problem.code &&
          item.environment === problem.environment,
      )
    )
      problems.push(problem);
  };
  for (const item of resolved) {
    if (item.source === item.field.environment) {
      for (const problem of parentProblems(values, item.field.path)) add(problem);
      const saved = valueAt(values, item.field.path);
      if (saved !== undefined) {
        const invalid = validate(item.field, saved);
        if (invalid) add({ ...invalid, field: item.field.path, source: 'config' });
      }
    }
    for (const problem of item.problems) add(problem);
  }
  function unknowns(value: unknown, path: string): void {
    if (!isObject(value)) return;
    for (const key of Object.keys(value)) {
      const child = path ? `${path}.${key}` : key;
      if (key.includes('.') || !knownPath(child)) {
        add({
          ...(path ? { field: path } : {}),
          source: 'config',
          code: 'UNKNOWN_FIELD',
          message: 'unknownField',
        });
      } else if (sections.has(child)) unknowns(value[key], child);
    }
  }
  if (!scope || sections.has(scope)) unknowns(scope ? valueAt(values, scope) : values, scope);
  return { resolved, problems };
}
