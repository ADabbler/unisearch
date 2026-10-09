import type { DoctorData, DoctorService } from '../doctor.js';
import type { Provider } from '../config/fields.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { text } from '../i18n/messages.js';
import { providerName } from '../i18n/providers.js';
import type { JsonObject, PublicError } from '../result.js';
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
          const lines = [`${providerName(service.provider, language)} (${service.provider}):`];
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
          `${providerName(service.provider, language)} (${service.provider}): ${stateLabel(service.state, language)}${anonymous ? parenthetical(language === 'zh' ? '匿名' : 'anonymous', language) : ''}${service.model ? ` (${service.model})` : ''}`,
        ];
        if (service.error) lines.push(...errorLines(service.error, language, '  '));
        return lines.join('\n');
      })
      .join('\n'),
  );
}

export function renderDoctorExecution(record: JsonObject, language: Language): string {
  if (!Array.isArray(record.services)) {
    const check = Object.entries(record.check as JsonObject)
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join('\n');
    return wrapText(`${check}\n${renderExecution(record, language)}`, process.stderr.columns ?? 80);
  }
  return wrapText(
    (record.services as JsonObject[])
      .map((service) => `${service.provider}\n${renderDoctorExecution(service, language)}`)
      .join('\n\n'),
    process.stderr.columns ?? 80,
  );
}
