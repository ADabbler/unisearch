import { inspectConfig } from './resolve.js';
import type { Problem } from './fields.js';
import { isDeepStrictEqual } from 'node:util';

export function inspectClassifier(values: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const inspected = inspectConfig(values, env, 'search.routing.classifier');
  const effective = inspected.resolved.flatMap((setting) => setting.problems);
  const problems = inspected.problems.filter(
    (problem) =>
      problem.code === 'UNKNOWN_FIELD' ||
      effective.some((item) => isDeepStrictEqual(item, problem)),
  );
  const missing: Problem[] = inspected.resolved
    .filter((setting) => setting.source === 'unset' && !setting.problems.length)
    .map((setting) => ({
      field: setting.field.path,
      source: 'unset',
      code: 'MISSING_REQUIRED',
      message: setting.field.kind === 'credential' ? 'missingCredential' : 'missingRequired',
    }));
  return { resolved: inspected.resolved, problems, missing };
}
