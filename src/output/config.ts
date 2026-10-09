import { fields } from '../config/fields.js';
import type { StatusData, StatusIssue } from '../config/status.js';
import { text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { JsonObject } from '../result.js';
import { wrapText } from './text.js';

function issueText(problem: StatusIssue): string {
  const location = problem.environment ?? problem.field;
  return `${problem.operation ? `${problem.operation}: ` : ''}${location ? `${location}: ` : ''}${problem.message}`;
}

export function renderConfig(
  action: 'path' | 'set' | 'unset',
  data: JsonObject,
  language: Language,
): string {
  if (action === 'path') return String(data.path);
  const key = data.key as string | undefined;
  let summary: string;
  if (action === 'set') {
    summary = text(language, data.changed ? 'settingSaved' : 'settingUnchanged')
      .replace('{key}', key!)
      .replace('{value}', () =>
        data.value === '[REDACTED]' ? data.value : JSON.stringify(data.value),
      );
  } else if (!key) summary = text(language, 'unknownRemoved');
  else if (!data.changed) summary = text(language, 'settingAbsent').replace('{key}', key);
  else {
    const section = !fields.some((field) => field.path === key);
    summary = text(language, section ? 'sectionRemoved' : 'settingRemoved').replace('{key}', key);
  }
  const issues = (data.issues ?? []) as StatusIssue[];
  const notes = Object.entries((data.overrides ?? {}) as JsonObject).map(([field, environment]) => {
    const problem = issues.find((problem) => problem.field === field);
    if (problem) return issueText(problem);
    return text(language, 'environmentOverride')
      .replace('{key}', field)
      .replace('{environment}', String(environment));
  });
  if (!notes.length) return summary;
  return `${summary}\n${notes.join('\n')}`;
}

export function renderStatus(data: StatusData, language: Language): string {
  const sections: string[] = [];
  if (!data.services.length) sections.push(text(language, 'noOperations'));
  for (const service of data.services) {
    sections.push(
      `${service.provider}:${service.operations ? '' : ` ${text(language, service.state)}`}`,
    );
    sections.push(...(service.issues ?? []).map((problem) => `  ${issueText(problem)}`));
    for (const operation of service.operations ?? []) {
      sections.push(`  ${operation.operation}: ${text(language, operation.state)}`);
      sections.push(...(operation.issues ?? []).map((problem) => `    ${issueText(problem)}`));
    }
  }
  if (data.issues?.length)
    sections.push(
      '',
      `${text(language, 'configIssues')}:`,
      ...data.issues.map((problem) => `  ${issueText(problem)}`),
    );
  return wrapText(sections.join('\n'));
}
