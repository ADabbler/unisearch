import type { DoctorData, DoctorService } from '../doctor.js';
import type { Provider } from '../config/fields.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { colon, text } from '../i18n/messages.js';
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

function anonymousLabel(language: Language): string {
  return parenthetical(language === 'zh' ? '匿名' : 'anonymous', language);
}

function serviceTitle(provider: Provider, language: Language): string {
  return `${providerName(provider, language)} (${provider})`;
}

function doctorServiceTitle(
  service: DoctorService,
  anonymous: boolean,
  language: Language,
): string {
  const state = `${stateLabel(service.state, language)}${anonymous ? anonymousLabel(language) : ''}`;
  const model = service.model
    ? `${language === 'zh' ? '，' : ', '}${text(language, 'configuredModelLabel')}${colon(language)}${service.model}`
    : '';
  return `${serviceTitle(service.provider, language)}${colon(language)}${state}${model}`;
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

function structuredLines(value: JsonValue, indent: string, language: Language): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return [`${indent}${scalar(value)}`];
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      // The value continues on the next line, so the label ends without a space.
      lines.push(`${indent}${key}${language === 'zh' ? '：' : ':'}`);
      lines.push(...structuredLines(item, `${indent}  `, language));
    } else lines.push(`${indent}${key}${colon(language)}${scalar(item)}`);
  }
  return lines;
}

function checkLines(check: JsonObject, language: Language): string[] {
  const separator = colon(language);
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
      lines.push(...structuredLines(value, '    ', language));
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
          const lines = [`${serviceTitle(service.provider, language)}${colon(language)}`];
          const fetchState = `${stateLabel(service.state, language)}${anonymousLabel(language)}`;
          lines.push(`  ${operationName('fetch', language)}${colon(language)}${fetchState}`);
          if (service.error) lines.push(...errorLines(service.error, language, '    '));
          lines.push(
            `  ${operationName('search', language)}${colon(language)}${text(language, 'doctorMissing')}`,
            `    ${text(language, 'fieldLabel')}${colon(language)}providers.jina.api_key`,
          );
          return lines.join('\n');
        }
        const lines = [doctorServiceTitle(service, anonymous, language)];
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
