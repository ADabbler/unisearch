import type { DoctorData, DoctorService } from '../doctor.js';
import type { Provider } from '../config/fields.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { text } from '../i18n/messages.js';
import { operationName, providerName } from '../i18n/providers.js';
import type { JsonObject, JsonValue, PublicError } from '../result.js';
import { renderExecution } from './exa.js';
import { errorText } from './render.js';
import { wrapText } from './text.js';

export interface DoctorDisplayOptions {
  anonymous: ReadonlySet<Provider>;
}

function stateLabel(state: string, language: Language): string {
  const labels: Record<string, MessageKey> = {
    disabled: 'doctorDisabled',
    missing: 'doctorMissing',
    invalid: 'invalid',
    passed: 'doctorPassed',
    failed: 'doctorFailed',
    not_started: 'doctorNotStarted',
  };
  return text(language, labels[state]);
}

function errorLines(error: PublicError, language: Language, indent: string): string[] {
  return errorText(error, language)
    .split('\n')
    .map((line) => `${indent}${line}`);
}

function parenthetical(value: string, language: Language): string {
  return language === 'zh' ? `（${value}）` : ` (${value})`;
}

function serviceTitle(provider: Provider, language: Language): string {
  return `${providerName(provider, language)} (${provider})`;
}

function indented(value: string): string {
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function scalar(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function structuredLines(value: JsonValue, indent: string): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return [`${indent}${scalar(value)}`];
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      lines.push(`${indent}${key}:`, ...structuredLines(item, `${indent}  `));
    } else lines.push(`${indent}${key}: ${scalar(item)}`);
  }
  return lines;
}

function checkLines(check: JsonObject, language: Language): string[] {
  const separator = language === 'zh' ? '：' : ': ';
  const lines: string[] = [];
  for (const [key, value] of Object.entries(check)) {
    if (key === 'operation') {
      lines.push(
        `  ${text(language, 'operationLabel')}${separator}${operationName(String(value), language)}`,
      );
    } else if (key === 'endpoint') {
      lines.push(`  ${text(language, 'endpointLabel')}${separator}${String(value)}`);
    } else if (key === 'quota') {
      lines.push(`  ${text(language, 'quotaLabel')}${language === 'zh' ? '：' : ':'}`);
      lines.push(...structuredLines(value, '    '));
    } else {
      lines.push(`  ${key}${separator}${scalar(value)}`);
    }
  }
  return lines;
}

export function renderDoctor(
  data: JsonObject,
  language: Language,
  options: DoctorDisplayOptions = { anonymous: new Set() },
): string {
  const services: DoctorService[] = Array.isArray(data.services)
    ? (data as DoctorData).services
    : [{ ...data, provider: data.provider as Provider, state: 'passed' }];
  return wrapText(
    services
      .map((service) => {
        const anonymous =
          options.anonymous.has(service.provider) &&
          (service.state === 'passed' || service.state === 'failed');
        if (service.provider === 'jina' && anonymous) {
          const lines = [`${serviceTitle(service.provider, language)}:`];
          const fetchState = `${stateLabel(service.state, language)}${parenthetical(language === 'zh' ? '匿名' : 'anonymous', language)}`;
          lines.push(`  fetch: ${fetchState}`);
          if (service.error) lines.push(...errorLines(service.error, language, '    '));
          lines.push(
            `  search: ${text(language, 'doctorMissing')}`,
            `    ${text(language, 'fieldLabel')}: providers.jina.api_key`,
          );
          return lines.join('\n');
        }
        const lines = [
          `${serviceTitle(service.provider, language)}: ${stateLabel(service.state, language)}${anonymous ? parenthetical(language === 'zh' ? '匿名' : 'anonymous', language) : ''}${service.model ? `${language === 'zh' ? '，' : ', '}${text(language, 'configuredModelLabel')}${language === 'zh' ? '：' : ': '}${service.model}` : ''}`,
        ];
        if (service.error) lines.push(...errorLines(service.error, language, '  '));
        return lines.join('\n');
      })
      .join('\n'),
  );
}

function renderDoctorServiceExecution(
  record: JsonObject,
  language: Language,
  provider?: Provider,
): string {
  const check = checkLines(record.check as JsonObject, language).join('\n');
  const execution = renderExecution(record, language);
  return [
    provider ? `${serviceTitle(provider, language)}:` : '',
    check,
    execution ? indented(execution) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderDoctorExecution(
  record: JsonObject,
  language: Language,
  provider?: Provider,
): string {
  const separator = language === 'zh' ? '：' : ':';
  if (!Array.isArray(record.services)) {
    return `\n${text(language, 'doctorDetails')}${separator}\n\n${wrapText(renderDoctorServiceExecution(record, language, provider), process.stderr.columns ?? 80)}`;
  }
  const sections = (record.services as JsonObject[])
    .map((service) => {
      const serviceProvider = service.provider as Provider;
      return renderDoctorServiceExecution(service, language, serviceProvider);
    })
    .join('\n');
  return `\n${text(language, 'doctorDetails')}${separator}\n\n${wrapText(sections, process.stderr.columns ?? 80)}`;
}
