import { AppError } from '../errors.js';
import {
  assertValid,
  expandTools,
  fieldAt,
  isObject,
  modelIdentity,
  parseInput,
  token,
  valueAt,
} from '../config/fields.js';
import type { ModelCandidate } from '../config/fields.js';
import { inspectConfig, parentProblems, resolveField } from '../config/resolve.js';
import type { ResolvedField } from '../config/resolve.js';
import { operationConfig } from '../config/status.js';
import type { OperationDefinition } from '../config/status.js';
import type { Language } from '../i18n/messages.js';
import type { JsonObject, JsonValue } from '../result.js';

const connectionFields = [
  'providers.model.api_key',
  'providers.model.base_url',
  'providers.model.protocol',
  'providers.model.tools',
  'providers.model.stream',
  'execution.timeout_seconds',
  'execution.retries',
  'execution.fallback',
];
export const modelSearch: OperationDefinition = {
  provider: 'model',
  operation: 'search',
  required: [...connectionFields, 'providers.model.model.id', 'providers.model.fallback_models'],
  optional: ['providers.model.model.effort'],
};
export interface ModelOptions {
  model?: string;
  effort?: string;
  stream?: boolean;
  fallback?: boolean;
  timeout?: number;
  extraSources?: string;
}
export interface ModelRequest {
  url: string;
  apiKey: string;
  protocol: 'responses' | 'chat-completions';
  stream: boolean;
  tools: JsonObject[];
  candidates: ModelCandidate[];
  query: string;
  timeout: number;
  retries: number;
}

function cliToken(value: string, option: string): string {
  try {
    return parseInput(fieldAt('providers.model.model.id'), value) as string;
  } catch (error) {
    if (error instanceof AppError) throw new AppError('INVALID_ARGUMENT', error.key, { option });
    throw error;
  }
}

export function prepareModel(
  query: string,
  options: ModelOptions,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): ModelRequest {
  if (!query.trim()) throw new AppError('INVALID_ARGUMENT', 'emptyQuery');
  const selectedId = options.model === undefined ? undefined : cliToken(options.model, '--model');
  const effort = options.effort === undefined ? undefined : cliToken(options.effort, '--effort');
  const overrides: Record<string, ResolvedField> = {};
  for (const [path, value] of [
    ['providers.model.stream', options.stream],
    ['execution.fallback', options.model !== undefined ? false : options.fallback],
    ['execution.timeout_seconds', options.timeout],
  ] as const)
    if (value !== undefined)
      overrides[path] = { field: fieldAt(path), value, source: 'cli', problems: [] };
  const settings = operationConfig(
    values,
    env,
    language,
    { provider: 'model', operation: 'search', required: connectionFields },
    overrides,
  );
  const get = (path: string) => settings[path].value!;
  function read(path: string, required = false): JsonValue | undefined {
    if (path.startsWith('providers.model.model.'))
      assertValid(
        inspectConfig(values, env, 'providers.model.model').problems.filter(
          (problem) => problem.code === 'UNKNOWN_FIELD',
        ),
        language,
      );
    const setting = resolveField(values, env, fieldAt(path));
    assertValid(setting.problems, language);
    if (required && setting.value === undefined)
      throw new AppError('MISSING_CONFIG', 'missingRequired', { provider: 'model', field: path });
    return setting.value;
  }
  let candidates: ModelCandidate[];
  if (selectedId !== undefined) {
    const id = selectedId;
    let selected = effort;
    if (effort === undefined) {
      const mainId = read('providers.model.model.id');
      if (mainId === id) selected = read('providers.model.model.effort') as string | undefined;
      else {
        assertValid(parentProblems(values, 'providers.model.fallback_models'), language);
        const configured = valueAt(values, 'providers.model.fallback_models');
        const saved = configured === undefined ? [] : configured;
        const invalid = () => {
          throw new AppError('INVALID_CONFIG', 'invalidModels', {
            field: 'providers.model.fallback_models',
          });
        };
        if (!Array.isArray(saved)) invalid();
        for (const item of saved as unknown[]) {
          if (
            !isObject(item) ||
            !token(item.id) ||
            Object.keys(item).some((key) => key !== 'id' && key !== 'effort')
          )
            invalid();
          const model = item as ModelCandidate;
          if (model.id === id) {
            if (model.effort !== undefined && !token(model.effort)) invalid();
            selected = model.effort;
            break;
          }
        }
      }
    }
    candidates = [{ id, ...(selected === undefined ? {} : { effort: selected }) }];
  } else {
    const id = read('providers.model.model.id', true) as string;
    const selected = effort ?? (read('providers.model.model.effort') as string | undefined);
    const main: ModelCandidate = { id, ...(selected === undefined ? {} : { effort: selected }) };
    const backups = get('execution.fallback')
      ? (read('providers.model.fallback_models') as ModelCandidate[])
      : [];
    candidates = [main, ...backups];
  }
  const seen = new Set<string>();
  candidates = candidates
    .filter((candidate) => {
      const key = modelIdentity(candidate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ id, effort }) => ({
      id,
      ...(effort === undefined || effort === 'default' ? {} : { effort }),
    }));
  const protocol = get('providers.model.protocol') as ModelRequest['protocol'];
  return {
    url: `${(get('providers.model.base_url') as string).replace(/\/+$/, '')}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`,
    apiKey: get('providers.model.api_key') as string,
    protocol,
    stream: get('providers.model.stream') as boolean,
    tools: expandTools(get('providers.model.tools') as JsonValue[]),
    candidates,
    query,
    timeout: get('execution.timeout_seconds') as number,
    retries: get('execution.retries') as number,
  };
}
