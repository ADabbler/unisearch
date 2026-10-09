import { isDeepStrictEqual } from 'node:util';
import { hasNonfiniteNumber, isObject } from '../config/fields.js';
import { AppError, failure } from '../errors.js';
import type { Language } from '../i18n/messages.js';
import { success } from '../result.js';
import type { JsonObject, Outcome, PublicError } from '../result.js';
import { invalid } from './zhipu-mcp-http.js';

export type Operation = 'search' | 'fetch' | 'docs' | 'tree' | 'read-file';
export type ToolContent = {
  text?: string;
  content?: JsonObject[];
  structured_content?: JsonObject;
  metadata?: JsonObject;
};
export type ToolData = ToolContent & { provider: 'zhipu-mcp'; repo?: string; path?: string };
export type FetchData = ToolContent & {
  provider: 'zhipu-mcp';
  results: (JsonObject & { url: string; title?: string; text?: string })[];
};
export type Data = ToolData | FetchData;

function plainText(block: JsonObject): block is JsonObject & { text: string } {
  return block.type === 'text' && typeof block.text === 'string' && Object.keys(block).length === 2;
}
function validateBlock(value: unknown, path: string): JsonObject {
  if (!isObject(value) || hasNonfiniteNumber(value)) throw invalid(path);
  switch (value.type) {
    case 'text':
      if (typeof value.text !== 'string') throw invalid(`${path}.text`);
      break;
    case 'resource_link':
      if (typeof value.uri !== 'string' || typeof value.name !== 'string') throw invalid(path);
      break;
    case 'resource':
      if (
        !isObject(value.resource) ||
        typeof value.resource.uri !== 'string' ||
        (typeof value.resource.text !== 'string' && typeof value.resource.blob !== 'string')
      )
        throw invalid(`${path}.resource`);
      break;
    case 'image':
    case 'audio':
      if (typeof value.data !== 'string' || typeof value.mimeType !== 'string') throw invalid(path);
      break;
    default:
      throw invalid(`${path}.type`);
  }
  for (const key of ['mimeType', 'title', 'description'] as const)
    if (value[key] !== undefined && typeof value[key] !== 'string') throw invalid(`${path}.${key}`);
  if (value.annotations !== undefined && !isObject(value.annotations))
    throw invalid(`${path}.annotations`);
  if (isObject(value.annotations)) {
    const annotations = value.annotations;
    if (
      annotations.audience !== undefined &&
      (!Array.isArray(annotations.audience) ||
        annotations.audience.some((role) => role !== 'user' && role !== 'assistant'))
    )
      throw invalid(`${path}.annotations.audience`);
    if (
      annotations.priority !== undefined &&
      (typeof annotations.priority !== 'number' ||
        annotations.priority < 0 ||
        annotations.priority > 1)
    )
      throw invalid(`${path}.annotations.priority`);
    if (annotations.lastModified !== undefined && typeof annotations.lastModified !== 'string')
      throw invalid(`${path}.annotations.lastModified`);
  }
  if (value.type === 'resource' && isObject(value.resource)) {
    for (const key of ['text', 'blob', 'mimeType'] as const)
      if (value.resource[key] !== undefined && typeof value.resource[key] !== 'string')
        throw invalid(`${path}.resource.${key}`);
  }
  return value as JsonObject;
}

function contentFields(
  blocks: JsonObject[],
  structured: JsonObject | undefined,
  keepJsonText: boolean,
): ToolContent {
  const retained = blocks.filter((block) => {
    if (keepJsonText || !structured || !plainText(block)) return true;
    try {
      return !isDeepStrictEqual(JSON.parse(block.text), structured);
    } catch {
      return true;
    }
  });
  const data: ToolContent = {};
  if (structured !== undefined) data.structured_content = structured;
  if (retained.length === 1 && plainText(retained[0])) data.text = retained[0].text;
  else if (retained.length || !structured) data.content = retained;
  return data;
}

export function toolResult(
  value: unknown,
  request: { operation: Operation; target: string; path?: string },
  language: Language,
): Outcome<Data> {
  if (!isObject(value)) throw invalid('result');
  const problems: PublicError[] = [];
  const note = (error: AppError) => problems.push(error.public(language));
  const blocks: JsonObject[] = [];
  if (!Array.isArray(value.content)) note(invalid('result.content'));
  else
    for (const [index, block] of value.content.entries()) {
      try {
        blocks.push(validateBlock(block, `result.content[${index}]`));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        note(new AppError(error.code, error.key, { ...error.details, upstream_index: index }));
      }
    }
  let structured: JsonObject | undefined;
  if (value.structuredContent !== undefined) {
    if (!isObject(value.structuredContent) || hasNonfiniteNumber(value.structuredContent))
      note(invalid('result.structuredContent'));
    else structured = value.structuredContent as JsonObject;
  }
  if (value.isError !== undefined && typeof value.isError !== 'boolean')
    note(invalid('result.isError'));
  const metadataValid = isObject(value._meta) && !hasNonfiniteNumber(value._meta);
  if (value._meta !== undefined && !metadataValid) note(invalid('result._meta'));
  const toolFailed = value.isError !== undefined && value.isError !== false;

  const base: ToolData = { provider: 'zhipu-mcp' };
  if (['docs', 'tree', 'read-file'].includes(request.operation)) base.repo = request.target;
  if (request.path !== undefined) base.path = request.path;
  const diagnostic: JsonObject = { provider: 'zhipu-mcp', operation: 'tools/call' };
  let content: ToolContent;
  if (toolFailed) {
    // Embedded resources are independent returned data; untyped text may be the error itself.
    const resources = blocks.filter((block) => block.type === 'resource');
    content = resources.length ? contentFields(resources, undefined, true) : {};
    const errors = contentFields(
      blocks.filter((block) => block.type !== 'resource'),
      structured,
      false,
    );
    if (errors.text !== undefined) diagnostic.upstream_message = errors.text;
    if (errors.content?.length) diagnostic.upstream_content = errors.content;
    if (errors.structured_content !== undefined)
      diagnostic.upstream_data = errors.structured_content;
  } else content = contentFields(blocks, structured, request.operation === 'read-file');
  if (metadataValid) {
    if (toolFailed) diagnostic.upstream_metadata = value._meta as JsonObject;
    else content.metadata = value._meta as JsonObject;
  }

  let data: Data = { ...base, ...content };
  let unavailable: AppError | undefined;
  if (request.operation === 'fetch') {
    const page: FetchData['results'][number] = { url: request.target };
    // The reference Reader returns a plain MCP text block. Structured envelopes are
    // retained until their body path is established; never treat JSON as page text.
    if (content.text !== undefined) {
      let json = false;
      try {
        JSON.parse(content.text);
        json = true;
      } catch {
        /* Plain page text. */
      }
      if (!json && content.text.trim()) {
        page.text = content.text;
      } else if (content.text.trim()) content.content = [{ type: 'text', text: content.text }];
      delete content.text;
    }
    data = { provider: 'zhipu-mcp', results: [page], ...content };
    if (!page.text)
      unavailable = new AppError('CONTENT_UNAVAILABLE', 'mcpNoPage', {
        ...diagnostic,
        reason: 'empty_content',
      });
  } else if (
    request.operation === 'read-file' &&
    content.text === undefined &&
    !content.content?.some(
      (block) =>
        block.type === 'text' ||
        (block.type === 'resource' &&
          isObject(block.resource) &&
          (typeof block.resource.text === 'string' || typeof block.resource.blob === 'string')),
    )
  ) {
    unavailable = new AppError('CONTENT_UNAVAILABLE', 'mcpNoFile', {
      ...diagnostic,
      reason: 'missing_file_content',
    });
  }
  let error: AppError | undefined;
  if (problems.length)
    error = new AppError('INVALID_RESPONSE', 'mcpResponse', { ...diagnostic, causes: problems });
  else if (value.isError) error = new AppError('UPSTREAM_ERROR', 'mcpUpstream', diagnostic);
  else error = unavailable;
  if (!error) return success(data);
  const outcome = failure<Data>(error, language);
  const hasContent = blocks.length > 0 || structured !== undefined || metadataValid;
  if (hasContent && (!toolFailed || Object.keys(content).length)) outcome.result.data = data;
  return outcome;
}
