import { isObject } from '../config/fields.js';
import { AppError } from '../errors.js';
import type { JsonObject } from '../result.js';

export type ModelAnswer = JsonObject & {
  model: string;
  text: string;
  sources?: (JsonObject & { url: string; title?: string })[];
};
export function invalidResponse(): never {
  throw new AppError('INVALID_RESPONSE', 'modelResponse');
}
function incomplete(reason: string): never {
  let message: 'modelToolWorkflow' | 'modelRefusal' | 'modelIncomplete' = 'modelIncomplete';
  if (reason === 'unsupported_tool_workflow') message = 'modelToolWorkflow';
  else if (reason === 'refusal') message = 'modelRefusal';
  throw new AppError('UPSTREAM_ERROR', message, { reason });
}
function upstreamError(value: unknown): never {
  if (typeof value === 'string' && value)
    throw new AppError('UPSTREAM_ERROR', 'modelUpstream', {
      reason: 'upstream_error',
      upstream_message: value,
    });
  if (!isObject(value)) invalidResponse();
  const details: JsonObject = { reason: 'upstream_error' };
  for (const [field, target] of [
    ['code', 'upstream_code'],
    ['type', 'upstream_type'],
    ['param', 'upstream_param'],
    ['message', 'upstream_message'],
  ] as const) {
    const item = value[field];
    if (item === undefined || item === null) continue;
    if (typeof item !== 'string') invalidResponse();
    if (item) details[target] = item;
  }
  throw new AppError('UPSTREAM_ERROR', 'modelUpstream', details);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function annotations(
  value: unknown,
  protocol: 'responses' | 'chat-completions',
  sources: NonNullable<ModelAnswer['sources']>,
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) invalidResponse();
  for (const item of value) {
    if (!isObject(item) || typeof item.type !== 'string') invalidResponse();
    if (item.type !== 'url_citation') continue;
    const citation = protocol === 'responses' ? item : item.url_citation;
    if (
      !isObject(citation) ||
      !nonempty(citation.url) ||
      /\s/u.test(citation.url) ||
      !/^https?:\/\//.test(citation.url)
    )
      invalidResponse();
    try {
      if (!new URL(citation.url).hostname) invalidResponse();
    } catch {
      invalidResponse();
    }
    if (
      citation.title !== undefined &&
      citation.title !== null &&
      typeof citation.title !== 'string'
    )
      invalidResponse();
    if (!sources.some((source) => source.url === citation.url))
      sources.push({
        url: citation.url,
        ...(citation.title ? { title: citation.title as string } : {}),
      });
  }
}

const clientTools = new Set([
  'function_call',
  'custom_tool_call',
  'computer_call',
  'local_shell_call',
  'apply_patch_call',
  'mcp_approval_request',
]);
export function responseAnswer(body: unknown): ModelAnswer {
  if (!isObject(body)) invalidResponse();
  if (body.error !== undefined && body.error !== null && body.error !== '')
    upstreamError(body.error);
  if (typeof body.status !== 'string') invalidResponse();
  if (body.status !== 'completed') {
    if (isObject(body.incomplete_details) && body.incomplete_details.reason === 'content_filter')
      incomplete('refusal');
    incomplete(body.status);
  }
  if (!nonempty(body.model) || !Array.isArray(body.output)) invalidResponse();
  const parts: string[] = [];
  const sources: NonNullable<ModelAnswer['sources']> = [];
  let refusal = false;
  for (const item of body.output) {
    if (!isObject(item) || typeof item.type !== 'string') invalidResponse();
    if (clientTools.has(item.type)) incomplete('unsupported_tool_workflow');
    if (
      item.type === 'shell_call' &&
      (!nonempty(item.call_id) ||
        !body.output.some(
          (output) =>
            isObject(output) &&
            output.type === 'shell_call_output' &&
            output.call_id === item.call_id,
        ))
    )
      incomplete('unsupported_tool_workflow');
    if (item.type !== 'message') continue;
    if (typeof item.role !== 'string' || !Array.isArray(item.content)) invalidResponse();
    if (item.role !== 'assistant') continue;
    if (item.status !== undefined && typeof item.status !== 'string') invalidResponse();
    if (item.status !== undefined && item.status !== 'completed') incomplete(item.status as string);
    for (const part of item.content) {
      if (!isObject(part) || typeof part.type !== 'string') invalidResponse();
      if (part.type === 'refusal') {
        if (typeof part.refusal !== 'string') invalidResponse();
        refusal = true;
      }
      if (part.type !== 'output_text') continue;
      if (typeof part.text !== 'string') invalidResponse();
      parts.push(part.text);
      annotations(part.annotations, 'responses', sources);
    }
  }
  const text = parts.join('\n\n');
  if (!text.trim()) {
    if (refusal) incomplete('refusal');
    invalidResponse();
  }
  return { model: body.model, text, ...(sources.length ? { sources } : {}) };
}

function chatFinish(reason: unknown): void {
  if (typeof reason !== 'string') invalidResponse();
  if (reason === 'tool_calls' || reason === 'function_call')
    incomplete('unsupported_tool_workflow');
  if (reason === 'content_filter') incomplete('refusal');
  if (reason !== 'stop') incomplete(reason);
}
function chatTools(message: Record<string, unknown>): void {
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls)) invalidResponse();
    if (message.tool_calls.length) incomplete('unsupported_tool_workflow');
  }
  if (message.function_call !== undefined && message.function_call !== null)
    incomplete('unsupported_tool_workflow');
}
export function chatAnswer(body: unknown): ModelAnswer {
  if (isObject(body) && body.error !== undefined && body.error !== null) upstreamError(body.error);
  if (!isObject(body) || !nonempty(body.model) || !Array.isArray(body.choices)) invalidResponse();
  const choices = body.choices.filter((choice) => isObject(choice) && choice.index === 0);
  if (choices.length !== 1) invalidResponse();
  const choice = choices[0];
  if (!isObject(choice.message)) invalidResponse();
  chatTools(choice.message);
  if (
    choice.message.refusal !== undefined &&
    choice.message.refusal !== null &&
    typeof choice.message.refusal !== 'string'
  )
    invalidResponse();
  chatFinish(choice.finish_reason);
  const content = choice.message.content;
  if (!nonempty(content)) {
    if (nonempty(choice.message.refusal)) incomplete('refusal');
    invalidResponse();
  }
  const sources: NonNullable<ModelAnswer['sources']> = [];
  annotations(choice.message.annotations, 'chat-completions', sources);
  return { model: body.model, text: content, ...(sources.length ? { sources } : {}) };
}

async function* events(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let skipLF = false;
  let event = '';
  let data: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      try {
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      } catch {
        invalidResponse();
      }
      if (skipLF && buffer.length) {
        if (buffer.startsWith('\n')) buffer = buffer.slice(1);
        skipLF = false;
      }
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) !== -1) {
        const line = buffer.slice(0, end);
        skipLF = buffer[end] === '\r' && end === buffer.length - 1;
        buffer = buffer.slice(end + (buffer.slice(end, end + 2) === '\r\n' ? 2 : 1));
        if (!line) {
          if (data.length) yield { event, data: data.join('\n') };
          event = '';
          data = [];
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          if (field === 'data') data.push(value);
        }
      }
      if (chunk.done) break;
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export async function streamAnswer(
  body: ReadableStream<Uint8Array>,
  protocol: 'responses' | 'chat-completions',
  onContent?: () => void,
): Promise<ModelAnswer> {
  let model: string | undefined;
  let content = '';
  let stopped = false;
  let refused = false;
  const sources: NonNullable<ModelAnswer['sources']> = [];
  for await (const event of events(body)) {
    if (event.data === '[DONE]') {
      if (protocol !== 'chat-completions' || !stopped || !model) invalidResponse();
      if (!content.trim()) {
        if (refused) incomplete('refusal');
        invalidResponse();
      }
      return { model, text: content, ...(sources.length ? { sources } : {}) };
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      invalidResponse();
    }
    if (!isObject(value)) invalidResponse();
    if (value.error !== undefined && value.error !== null) upstreamError(value.error);
    if (protocol === 'responses') {
      if (typeof value.type !== 'string' || (event.event && event.event !== value.type))
        invalidResponse();
      if (value.type === 'response.completed') return responseAnswer(value.response);
      if (value.type === 'error') upstreamError(value);
      if (value.type === 'response.failed' && isObject(value.response) && value.response.error)
        upstreamError(value.response.error);
      if (value.type === 'response.incomplete' && isObject(value.response))
        responseAnswer(value.response);
      if (['response.failed', 'response.incomplete'].includes(value.type)) incomplete(value.type);
      if (
        value.type === 'response.output_item.added' ||
        value.type === 'response.output_item.done'
      ) {
        if (!isObject(value.item) || typeof value.item.type !== 'string') invalidResponse();
        if (clientTools.has(value.item.type)) incomplete('unsupported_tool_workflow');
      }
      if (value.type === 'response.output_text.delta') {
        if (typeof value.delta !== 'string') invalidResponse();
        if (value.delta) onContent?.();
      }
      continue;
    }
    if (value.model !== undefined) {
      if (!nonempty(value.model) || (model !== undefined && value.model !== model))
        invalidResponse();
      model = value.model;
    }
    if (!Array.isArray(value.choices)) invalidResponse();
    const choices = value.choices.filter((choice) => isObject(choice) && choice.index === 0);
    if (choices.length > 1) invalidResponse();
    if (!choices.length) {
      if (value.choices.length) invalidResponse();
      continue;
    }
    const choice = choices[0];
    if (!isObject(choice.delta) || stopped) invalidResponse();
    chatTools(choice.delta);
    if (choice.delta.content !== undefined && choice.delta.content !== null) {
      if (typeof choice.delta.content !== 'string') invalidResponse();
      content += choice.delta.content;
      if (choice.delta.content) onContent?.();
    }
    if (choice.delta.refusal !== undefined && choice.delta.refusal !== null) {
      if (typeof choice.delta.refusal !== 'string') invalidResponse();
      refused ||= Boolean(choice.delta.refusal);
    }
    annotations(choice.delta.annotations, 'chat-completions', sources);
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      chatFinish(choice.finish_reason);
      stopped = true;
    }
  }
  return invalidResponse();
}
