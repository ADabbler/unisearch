import { AppError, failure } from '../errors.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import type { JsonObject, JsonValue, Outcome, PublicError, Result } from '../result.js';
import { contentSources } from './exa.js';
import type { ContentSource } from '../providers/exa.js';
import { inlineCode } from './context7.js';
import { jsonBlock, renderBlocks } from './zhipu-mcp.js';
import { wrapText } from './text.js';

export type Format = 'json' | 'markdown' | 'text';
export type RenderData<T extends JsonValue> = (
  data: T,
  language: Language,
  meta?: JsonObject,
) => string;
export interface ExecutionDetails {
  data: JsonObject;
  markdown: (data: JsonObject, language: Language) => string;
}

export interface RenderOptions<T extends JsonValue> {
  language: Language;
  format: Format;
  verbose?: boolean;
  textErrorPlacement?: 'before-data';
  renderData?: RenderData<T>;
  renderText?: (result: Result<T>, language: Language) => string;
  execution?: ExecutionDetails;
}

export function line(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function errorLines(error: PublicError, language: Language, codes = true): string[] {
  const lines = [`${codes ? `[${error.code}] ` : ''}${error.message}`];
  const details = error.details;
  const labels: Record<string, MessageKey> = {
    path: 'pathLabel',
    field: error.code === 'INVALID_RESPONSE' ? 'responseFieldLabel' : 'fieldLabel',
    option: 'optionLabel',
    operation: 'operationLabel',
    system_code: 'systemCodeLabel',
    source: 'sourceLabel',
    environment: 'environmentLabel',
    provider: 'errorProviderLabel',
    url: 'urlLabel',
    model: 'modelLabel',
    http_status: 'httpStatusLabel',
    page_status: 'pageStatusLabel',
    upstream_code: 'upstreamCodeLabel',
    upstream_type: 'upstreamTypeLabel',
    upstream_param: 'upstreamParamLabel',
    upstream_message: 'upstreamMessageLabel',
    upstream_readable_message: 'upstreamReadableLabel',
    request_id: 'requestIdLabel',
    response_id: 'responseIdLabel',
    timeout_scope: 'timeoutScopeLabel',
    retry_after_seconds: 'retrySecondsLabel',
    reason: 'reasonLabel',
    index: 'resultIndexLabel',
    upstream_index: 'upstreamIndexLabel',
    redirect_library_id: 'redirectLibraryLabel',
    content_source: 'contentSourceLabel',
    limit: 'rateLimitLabel',
    unit: 'rateUnitLabel',
    usage: 'usageLabel',
    remaining_credits: 'remainingCreditsLabel',
    plan_usage: 'planUsageLabel',
    plan_limit: 'planLimitLabel',
    paygo_usage: 'paygoUsageLabel',
    paygo_limit: 'paygoLimitLabel',
    tool: 'toolLabel',
    window_seconds: 'rateWindowLabel',
  };
  for (const [key, label] of Object.entries(labels)) {
    if (typeof details?.[key] === 'string' || typeof details?.[key] === 'number')
      lines.push(
        `${text(language, label)}: ${codes ? details[key] : String(details[key]).replace(/\r\n|\r|\n/g, '\n  ')}`,
      );
  }
  if (typeof details?.help === 'string') lines.push(`${text(language, 'seeHelp')} ${details.help}`);
  if (Array.isArray(details?.content_sources)) {
    const sources = details.content_sources as ContentSource[];
    lines.push(
      ...(codes
        ? contentSources(sources, language)
        : sources.map(
            (item) => `${text(language, 'contentSourceLabel')}: ${item.url} · ${item.source}`,
          )),
    );
  }
  for (const [key, label] of [
    ['unmatched_selectors', 'unmatchedSelectorsLabel'],
    ['candidate_selectors', 'candidateSelectorsLabel'],
  ] as const) {
    const values = details?.[key];
    if (Array.isArray(values) && values.length)
      lines.push(
        `${text(language, label)}: ${values.map((value) => (codes ? inlineCode(String(value)) : String(value))).join(language === 'zh' ? '、' : ', ')}`,
      );
  }
  for (const cause of details?.causes ?? []) {
    lines.push(
      ...errorLines(cause, language, codes).map((entry) => `${codes ? '- ' : '  '}${entry}`),
    );
  }
  for (const failure of details?.failures ?? []) {
    const target = 'provider' in failure ? failure.provider : failure.url;
    lines.push(
      ...errorLines(failure, language, codes).map(
        (entry, index) => `${codes ? '- ' : '  '}${index === 0 ? `${target}: ` : ''}${entry}`,
      ),
    );
  }
  return lines;
}

export function errorText(error: PublicError, language: Language): string {
  return errorLines(error, language, false).join('\n');
}

function errorContent(error: PublicError, language: Language, target?: string): string[] {
  const sections: string[] = [];
  const details = error.details;
  const prefix = target ? `${target} · ` : '';
  const sep = language === 'zh' ? '：' : ': ';
  if (details?.upstream_data !== undefined)
    sections.push(
      `${prefix}${text(language, 'upstreamDataLabel')}${sep}`,
      jsonBlock(details.upstream_data),
    );
  if (Array.isArray(details?.upstream_content))
    sections.push(
      `${prefix}${text(language, 'upstreamContentLabel')}${sep}`,
      renderBlocks(details.upstream_content as JsonObject[], language),
    );
  if (details?.upstream_metadata !== undefined)
    sections.push(
      `${prefix}${text(language, 'mcpAttributes')}${sep}`,
      jsonBlock(details.upstream_metadata),
    );
  for (const cause of details?.causes ?? [])
    sections.push(...errorContent(cause, language, target));
  for (const failure of details?.failures ?? [])
    sections.push(
      ...errorContent(failure, language, 'provider' in failure ? failure.provider : failure.url),
    );
  return sections;
}

function markdown<T extends JsonValue>(outcome: Outcome<T>, options: RenderOptions<T>): string {
  const { result } = outcome;
  const sections: string[] = [];
  for (const [fallbacks, label] of [
    [result.meta?.service_fallbacks, 'serviceFallbackLabel'],
    [result.meta?.model_fallbacks, 'modelFallbackLabel'],
  ] as const) {
    if (!Array.isArray(fallbacks)) continue;
    for (const value of fallbacks) {
      const item = value as JsonObject;
      sections.push(
        `> ${text(options.language, label)}${options.language === 'zh' ? '：' : ': '}${item.from} → ${item.to}${options.language === 'zh' ? '；' : '; '}[${item.code}] ${String(item.message).replace(/[\r\n]+/g, ' ')}`,
      );
    }
  }
  if (result.error) {
    const label = text(options.language, result.status === 'partial' ? 'partial' : 'error');
    sections.push(
      `> ${label}: ${errorLines(result.error, options.language)
        .flatMap((value) => value.split(/\r\n|\r|\n/))
        .join('\n> ')}`,
    );
    sections.push(...errorContent(result.error, options.language));
  }
  if (result.data !== undefined) {
    if (!options.renderData) throw new Error('A data renderer is required.');
    sections.push(options.renderData(result.data, options.language, result.meta));
  }
  return line(sections.join('\n\n'));
}

function json(value: unknown): string {
  return line(
    JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (typeof item === 'number' && !Number.isFinite(item))
          throw new TypeError('Non-finite JSON number.');
        return item;
      },
      2,
    ),
  );
}

export interface Rendered<T extends JsonValue> {
  outcome: Outcome<T>;
  content: string;
  details: string;
  execution: string;
}

function readable<T extends JsonValue>(
  outcome: Outcome<T>,
  options: RenderOptions<T>,
): Rendered<T> {
  const { result } = outcome;
  const details: string[] = [];
  const hasData = result.data !== undefined;
  let content = '';
  const renderText = options.format === 'text' ? options.renderText : undefined;
  if (renderText) {
    const renderedText = renderText(result, options.language);
    if (result.error) details.push(renderedText);
    else content = line(renderedText);
  } else if (options.format === 'text') {
    if (hasData) {
      if (!options.renderData) throw new Error('A data renderer is required.');
      content = line(options.renderData(result.data!, options.language, result.meta));
    }
  } else if (hasData || !result.error) content = markdown(outcome, options);
  if (
    !renderText &&
    result.error &&
    (options.format === 'text' || !hasData || result.status === 'error')
  ) {
    const label = text(options.language, result.status === 'partial' ? 'partial' : 'error');
    const renderedError = wrapText(
      `${label}: ${errorText(result.error, options.language)}`,
      process.stderr.columns ?? 80,
    );
    if (options.format === 'text' && hasData && options.textErrorPlacement === 'before-data')
      content = `${renderedError}\n\n${content}`;
    else {
      details.push(renderedError);
      if (options.format === 'markdown' && !hasData)
        details.push(errorContent(result.error, options.language).join('\n\n'));
    }
  }
  const execution =
    options.verbose && options.execution
      ? options.execution.markdown(options.execution.data, options.language)
      : '';
  details.push(execution);
  return {
    outcome,
    content,
    details: details.some(Boolean) ? line(details.filter(Boolean).join('\n\n')) : '',
    execution: execution ? line(execution) : '',
  };
}

export function render<T extends JsonValue>(
  outcome: Outcome<T>,
  options: RenderOptions<T>,
): Rendered<T> {
  try {
    if (options.format === 'json') {
      const result =
        options.verbose && options.execution
          ? { ...outcome.result, meta: { ...outcome.result.meta, ...options.execution.data } }
          : { ...outcome.result };
      if (result.meta && Object.keys(result.meta).length === 0) delete result.meta;
      return { outcome, content: json(result), details: '', execution: '' };
    }
    return readable(outcome, options);
  } catch {
    const failed = failure(new AppError('RENDER_ERROR', 'render'), options.language, outcome);
    delete failed.result.meta;
    let retained = '';
    if (failed.result.data !== undefined) {
      try {
        retained = json(failed.result.data);
      } catch {
        delete failed.result.data;
        if (failed.result.error)
          failed.result.error.message += `${options.language === 'zh' ? '；' : '; '}${text(options.language, 'unavailableData')}`;
      }
    }
    if (options.format === 'json')
      return { outcome: failed, content: json(failed.result), details: '', execution: '' };
    return readable(failed, {
      ...options,
      verbose: false,
      renderText: undefined,
      renderData: () =>
        options.format === 'text'
          ? `${text(options.language, 'retainedData')}:\n${retained}`
          : `## ${text(options.language, 'retainedData')}\n\n\`\`\`json\n${retained}\`\`\``,
    });
  }
}
