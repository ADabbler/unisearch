import { isDeepStrictEqual } from 'node:util';
import type { Language } from '../i18n/messages.js';
import type { JsonObject } from '../result.js';
import { assertValid, fieldAt, issue, providers, within } from './fields.js';
import { AppError } from '../errors.js';
import type { Problem, Provider } from './fields.js';
import { inspectConfig, resolveField } from './resolve.js';
import type { ResolvedField } from './resolve.js';

export interface OperationDefinition {
  provider: Provider;
  operation: string;
  required: readonly string[];
  optional?: readonly string[];
}
export type State = 'ready' | 'missing' | 'disabled' | 'invalid';
export type StatusIssue = JsonObject & {
  code: string;
  message: string;
  field?: string;
  environment?: string;
  operation?: string;
};
export type OperationStatus = JsonObject & {
  operation: string;
  state: State;
  issues?: StatusIssue[];
};
export type ServiceStatus = JsonObject & {
  provider: string;
  state: State;
  issues?: StatusIssue[];
  operations?: OperationStatus[];
};
export type StatusData = JsonObject & { services: ServiceStatus[]; issues?: StatusIssue[] };

function requiredSettings(
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  definition: OperationDefinition,
  overrides: Record<string, ResolvedField> = {},
) {
  return [
    ...new Set([
      `providers.${definition.provider}.enabled`,
      ...definition.required,
      ...(definition.optional ?? []),
    ]),
  ].map((path) => resolveField(values, env, fieldAt(path), overrides));
}

function requiredProblems(required: ResolvedField[], problems: Problem[]): Problem[] {
  const effective = required.flatMap((setting) => setting.problems);
  return problems.filter((problem) =>
    problem.code === 'UNKNOWN_FIELD'
      ? problem.field && required.some((setting) => within(setting.field.path, problem.field!))
      : effective.some((item) => isDeepStrictEqual(problem, item)),
  );
}

export function operationConfig(
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
  definition: OperationDefinition,
  overrides: Record<string, ResolvedField> = {},
): Record<string, ResolvedField> {
  const required = requiredSettings(values, env, definition, overrides);
  assertValid(
    requiredProblems(required, inspectConfig(values, env, '', overrides).problems),
    language,
  );
  const enabled = `providers.${definition.provider}.enabled`;
  if (required.find((setting) => setting.field.path === enabled)?.value === false) {
    throw new AppError('SERVICE_DISABLED', 'serviceDisabled', {
      provider: definition.provider,
      field: enabled,
    });
  }
  for (const setting of required) {
    if (setting.value === undefined && !definition.optional?.includes(setting.field.path))
      throw new AppError('MISSING_CONFIG', 'missingRequired', {
        provider: definition.provider,
        field: setting.field.path,
      });
  }
  return Object.fromEntries(required.map((setting) => [setting.field.path, setting]));
}

export function localStatus(
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
  definitions: readonly OperationDefinition[] = [],
): StatusData {
  const { problems } = inspectConfig(values, env);
  const used = new Set<Problem>();
  const services: ServiceStatus[] = [];
  const operationProviders = new Set(definitions.map((definition) => definition.provider));
  for (const provider of providers) {
    if (!operationProviders.has(provider)) continue;
    const enabled = `providers.${provider}.enabled`;
    const enabledSetting = resolveField(values, env, fieldAt(enabled));
    const disabled = enabledSetting.value === false;
    const operations: OperationStatus[] = definitions
      .filter((definition) => definition.provider === provider)
      .map((definition) => {
        const required = requiredSettings(values, env, definition);
        const invalid = requiredProblems(required, problems);
        for (const problem of invalid) used.add(problem);
        const issues = invalid.map((problem) => issue(problem, language) as StatusIssue);
        if (!disabled) {
          for (const setting of required) {
            if (
              setting.source === 'unset' &&
              !setting.problems.length &&
              !definition.optional?.includes(setting.field.path)
            )
              issues.push(
                issue(
                  {
                    field: setting.field.path,
                    source: 'unset',
                    code: 'MISSING_REQUIRED',
                    message:
                      setting.field.kind === 'credential' ? 'missingCredential' : 'missingRequired',
                  },
                  language,
                ) as StatusIssue,
              );
          }
        }
        let state: State = 'ready';
        if (invalid.length) state = 'invalid';
        else if (disabled) state = 'disabled';
        else if (issues.length) state = 'missing';
        return { operation: definition.operation, state, ...(issues.length ? { issues } : {}) };
      });
    const common = (operations[0].issues ?? []).filter((problem) =>
      operations.every((operation) =>
        operation.issues?.some((other) => isDeepStrictEqual(other, problem)),
      ),
    );
    for (const operation of operations) {
      const own = operation.issues?.filter(
        (problem) => !common.some((other) => isDeepStrictEqual(other, problem)),
      );
      if (own?.length) operation.issues = own;
      else delete operation.issues;
    }
    const same = operations.every((operation) => operation.state === operations[0].state);
    let state: State;
    if (same) state = operations[0].state;
    else if (operations.some((operation) => operation.state === 'ready')) state = 'ready';
    else if (operations.some((operation) => operation.state === 'invalid')) state = 'invalid';
    else state = 'missing';
    const issues = same
      ? [
          ...common,
          ...operations.flatMap((operation) =>
            (operation.issues ?? []).map((problem) => ({
              ...problem,
              operation: operation.operation,
            })),
          ),
        ]
      : common;
    services.push({
      provider,
      state,
      ...(issues.length ? { issues } : {}),
      ...(!same ? { operations } : {}),
    });
  }
  const remaining = problems
    .filter((problem) => !used.has(problem))
    .map((problem) => issue(problem, language) as StatusIssue);
  return { services, ...(remaining.length ? { issues: remaining } : {}) };
}
