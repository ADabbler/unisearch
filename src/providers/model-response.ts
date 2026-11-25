import { parser as markdown } from '@lezer/markdown';
import { isObject } from '../config/fields.js';
import { AppError } from '../errors.js';
import type { JsonObject } from '../result.js';

export type ModelAnswer = JsonObject & {
  model: string;
  text: string;
  /** Sources the answer cites. */
  citations?: AnswerSource[];
  /**
   * URLs the provider returned that the answer does not cite. Empty when the
   * answer cites nothing, because the whole provider list becomes `citations`.
   */
  searchedSources?: string[];
};
type AnswerSource = JsonObject & { url: string; title?: string };
export function invalidResponse(): never {
  throw new AppError('INVALID_RESPONSE', 'modelResponse');
}
function incomplete(reason: string, upstreamCode?: string): never {
  throw new AppError('UPSTREAM_ERROR', reason === 'refusal' ? 'modelRefusal' : 'modelIncomplete', {
    reason,
    ...(upstreamCode ? { upstream_code: upstreamCode } : {}),
  });
}
export function modelErrorDetails(value: unknown): JsonObject {
  if (typeof value === 'string' && value) return { upstream_message: value };
  if (!isObject(value)) return { reason: 'error_body_invalid' };
  const details: JsonObject = {};
  for (const [field, target] of [
    ['code', 'upstream_code'],
    ['type', 'upstream_type'],
    ['param', 'upstream_param'],
    ['message', 'upstream_message'],
  ] as const) {
    const item = value[field];
    if (item === undefined || item === null || item === '') continue;
    if (
      typeof item === 'string' ||
      (field === 'code' && typeof item === 'number' && Number.isFinite(item))
    )
      details[target] = item;
    else details.reason = 'error_body_invalid';
  }
  return details;
}
function upstreamError(value: unknown): never {
  const details = modelErrorDetails(value);
  if (details.reason) invalidResponse();
  throw new AppError('UPSTREAM_ERROR', 'modelUpstream', { reason: 'upstream_error', ...details });
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function validSourceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || /\s/u.test(value) || !/^https?:\/\//i.test(value)) return false;
  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
}
function addSource(sources: AnswerSource[], url: string, title?: string): void {
  const existing = sources.find((source) => source.url === url);
  if (!existing) {
    sources.push({ url, ...(title ? { title } : {}) });
    return;
  }
  if (!existing.title && title) existing.title = title;
}
function annotations(
  value: unknown,
  protocol: 'responses' | 'chat-completions',
  sources: AnswerSource[],
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) invalidResponse();
  for (const item of value) {
    if (!isObject(item) || typeof item.type !== 'string') invalidResponse();
    if (item.type !== 'url_citation') continue;
    const citation = protocol === 'responses' ? item : item.url_citation;
    if (!isObject(citation) || !validSourceUrl(citation.url)) invalidResponse();
    if (
      citation.title !== undefined &&
      citation.title !== null &&
      typeof citation.title !== 'string'
    )
      invalidResponse();
    addSource(sources, citation.url, citation.title ? (citation.title as string) : undefined);
  }
}

/** Characters a URL can contain, excluding parentheses, which are balanced separately. */
const urlChar = String.raw`[^\s()<>"'\`，。、；：！？》）】]`;

/** A URL body with balanced parentheses, as used by paths such as `X_(company)`. */
const urlBody = String.raw`${urlChar}*(?:\(${urlChar}*\)${urlChar}*)*`;

const url = String.raw`https?:\/\/${urlBody}`;
const sourceLink = new RegExp(String.raw`^\[([^\]]*)\]\((${url})\)$`, 'i');
const sourceUrl = new RegExp(String.raw`(?:^|\s)(${url})$`, 'i');

/** A standalone line naming the source list, such as `## Sources` or `参考资料：`. */
const sourceHeading =
  /^(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*(?:sources?|references?|citations?|信源|参考资料|参考|引用|来源列表|来源)[ \t]*(?:[:：]?(?:\*\*|__))?(?:[ \t]*[（(][^)\n]*[)）])?[ \t]*[:：]?[ \t]*$/gim;

const listMarker = /^[ \t]*(?:[-*]|\d+\.)[ \t]+/;

// Parse standalone HTML tags individually so their attributes and Markdown code stay literal.
const reasoningMarkdown = markdown.configure({ remove: ['HTMLBlock'] });

/** Only paired HTML tags delimit reasoning. Markdown code can quote either tag literally. */
function stripThinking(text: string): string {
  if (!/<think\b/i.test(text)) return text;
  const parts: string[] = [];
  const openParts: number[] = [];
  let literalTag = '';
  let end = 0;
  let removed = false;
  const commentSyntax = text.includes('<!--') ? markdown.parse(text) : undefined;
  reasoningMarkdown.parse(text).iterate({
    enter(node) {
      if (node.name !== 'HTMLTag') return;
      const { from, to } = node;
      if (commentSyntax?.resolveInner(from, 1).name === 'CommentBlock') return;
      const tag = text.slice(from, to);
      const match = /^<(\/?)(think|pre|code|script|style|textarea)(?=[\s/>])/i.exec(tag);
      if (!match || tag.endsWith('/>')) return;
      const closing = match[1] === '/';
      const name = match[2].toLowerCase();
      if (literalTag) {
        if (closing && name === literalTag) literalTag = '';
      } else if (name !== 'think') {
        if (!closing) literalTag = name;
      } else if (!closing) {
        parts.push(text.slice(end, from));
        openParts.push(parts.length);
        end = from;
      } else {
        const keep = openParts.pop();
        if (keep !== undefined) {
          parts.length = keep;
          end = to;
          removed = true;
        }
      }
    },
  });
  if (!removed) return text;
  return (parts.join('') + text.slice(end)).replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, '');
}

/** A source list that makes up the entire answer belongs in the answer text. */
function extractAnswerSources(text: string): { text: string; sources: AnswerSource[] } {
  const block = headingBlock(text) ?? linkBlock(text);
  const contentEnd = block?.text.trimEnd().length;
  if (block && contentEnd) {
    let containsCode = false;
    markdown.parse(text).iterate({
      from: block.text.length,
      enter(node) {
        if (
          node.to > block.text.length &&
          (node.name === 'CodeBlock' || node.name === 'FencedCode')
        )
          containsCode = true;
      },
    });
    if (!containsCode) {
      const nextLine = block.text.indexOf('\n', contentEnd);
      const body = nextLine < 0 ? block.text : block.text.slice(0, nextLine);
      return { text: body.replace(/\r$/, ''), sources: block.sources };
    }
  }
  return { text, sources: [] };
}

/**
 * Every non-blank line below the heading must be a source line carrying a URL.
 */
function headingBlock(text: string): { text: string; sources: AnswerSource[] } | undefined {
  const heading = [...text.matchAll(sourceHeading)].at(-1);
  if (!heading) return;
  const sources = text
    .slice(heading.index + heading[0].length)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => sourceFromLine(line, true));
  if (sources.length && sources.every((source) => source !== undefined))
    return { text: text.slice(0, heading.index), sources };
}

function linkBlock(text: string): { text: string; sources: AnswerSource[] } | undefined {
  const lines = text.split('\n');
  const sources: AnswerSource[] = [];
  let i = lines.length - 1;
  for (; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const source = sourceFromLine(lines[i], false);
    if (!source) break;
    sources.push(source);
  }
  if (sources.length < 2) return undefined;
  return {
    text: lines.slice(0, i + 1).join('\n'),
    sources: sources.reverse(),
  };
}

function sourceFromLine(line: string, allowLabel: boolean): AnswerSource | undefined {
  const entry = line.replace(listMarker, '').trim();
  const link = sourceLink.exec(entry);
  let url: string;
  let title: string;
  if (link) {
    title = link[1].trim();
    url = link[2];
  } else {
    const match = sourceUrl.exec(entry);
    if (!match) return;
    title = entry.slice(0, match.index).trimEnd();
    if (title && (!allowLabel || !listMarker.test(line) || /https?:\/\//i.test(title))) return;
    url = match[1];
  }
  if (validSourceUrl(url)) return { url, ...(title ? { title } : {}) };
}

/** The top-level `citations` URL list both protocols return. */
function citations(value: unknown, sources: AnswerSource[]): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) invalidResponse();
  for (const url of value) {
    if (!validSourceUrl(url)) invalidResponse();
    addSource(sources, url);
  }
}

interface FinalAnswer {
  text: string;
  sources: AnswerSource[];
  searchedSources: string[];
}

function answerFields(model: string, answer: FinalAnswer): ModelAnswer {
  return {
    model,
    text: answer.text,
    ...(answer.sources.length ? { citations: answer.sources } : {}),
    ...(answer.searchedSources.length ? { searchedSources: answer.searchedSources } : {}),
  };
}

/**
 * Replace model-written sources and inline reasoning with structured output.
 * Cited sources keep priority over sources recovered from prose. When the model
 * cites nothing, the provider list is the only evidence and becomes the sources.
 */
function finalize(text: string, cited: AnswerSource[], searched: AnswerSource[]): FinalAnswer {
  const answer = extractAnswerSources(stripThinking(text));
  const explicit = [...cited, ...answer.sources];
  const merged: AnswerSource[] = [];
  for (const source of explicit.length ? explicit : searched)
    addSource(merged, source.url, source.title);
  const citedUrls = new Set(merged.map((source) => source.url));
  const searchedSources = [...new Set(searched.map((source) => source.url))].filter(
    (url) => !citedUrls.has(url),
  );
  return { text: answer.text, sources: merged, searchedSources };
}

export function responseAnswer(body: unknown): ModelAnswer {
  if (!isObject(body)) invalidResponse();
  if (body.error !== undefined && body.error !== null && body.error !== '')
    upstreamError(body.error);
  if (typeof body.status !== 'string') invalidResponse();
  if (body.status !== 'completed') {
    const reason = isObject(body.incomplete_details) ? body.incomplete_details.reason : undefined;
    if (reason === 'content_filter') incomplete('refusal', reason);
    incomplete(body.status, nonempty(reason) ? reason : undefined);
  }
  if (!nonempty(body.model) || !Array.isArray(body.output)) invalidResponse();
  const parts: string[] = [];
  const cited: AnswerSource[] = [];
  const searched: AnswerSource[] = [];
  let refusal = false;
  for (const item of body.output) {
    if (!isObject(item) || typeof item.type !== 'string') invalidResponse();
    if (item.type !== 'message') continue;
    if (typeof item.role !== 'string' || !Array.isArray(item.content)) invalidResponse();
    if (item.role !== 'assistant' || item.phase === 'commentary') continue;
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
      annotations(part.annotations, 'responses', cited);
    }
  }
  citations(body.citations, searched);
  const answer = finalize(parts.join('\n\n'), cited, searched);
  if (!answer.text.trim()) {
    if (refusal) incomplete('refusal');
    invalidResponse();
  }
  return answerFields(body.model, answer);
}

function chatFinish(reason: unknown): void {
  if (typeof reason !== 'string') invalidResponse();
  if (reason === 'content_filter') incomplete('refusal');
  if (reason !== 'stop') incomplete(reason);
}
export function chatAnswer(body: unknown): ModelAnswer {
  if (isObject(body) && body.error !== undefined && body.error !== null) upstreamError(body.error);
  if (!isObject(body) || !Array.isArray(body.choices)) invalidResponse();
  const choices = body.choices.filter(
    (choice, _, all) =>
      isObject(choice) && (choice.index === 0 || (all.length === 1 && choice.index === undefined)),
  );
  if (choices.length !== 1) invalidResponse();
  const choice = choices[0];
  if (choice.error != null) upstreamError(choice.error);
  if (!nonempty(body.model) || !isObject(choice.message)) invalidResponse();
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
  const cited: AnswerSource[] = [];
  const searched: AnswerSource[] = [];
  citations(body.citations, searched);
  annotations(choice.message.annotations, 'chat-completions', cited);
  const answer = finalize(content, cited, searched);
  if (!answer.text.trim()) {
    if (nonempty(choice.message.refusal)) incomplete('refusal');
    invalidResponse();
  }
  return answerFields(body.model, answer);
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
      if (chunk.done) {
        if (data.length || event || (buffer && !buffer.startsWith(':'))) invalidResponse();
        break;
      }
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
  const cited: AnswerSource[] = [];
  const searched: AnswerSource[] = [];
  const commentaryItems = new Set<string | number>();
  for await (const event of events(body)) {
    if (event.data === '[DONE]') break;
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
        value.type === 'response.output_item.added' &&
        isObject(value.item) &&
        value.item.type === 'message' &&
        value.item.phase === 'commentary'
      ) {
        if (typeof value.item.id === 'string') commentaryItems.add(value.item.id);
        if (typeof value.output_index === 'number') commentaryItems.add(value.output_index);
      }
      if (value.type === 'response.output_text.delta') {
        if (typeof value.delta !== 'string') invalidResponse();
        const commentary =
          (typeof value.item_id === 'string' && commentaryItems.has(value.item_id)) ||
          (typeof value.output_index === 'number' && commentaryItems.has(value.output_index));
        if (value.delta && !commentary) onContent?.();
      }
      continue;
    }
    if (value.citations !== undefined && value.citations !== null)
      citations(value.citations, searched);
    if (value.model != null && value.model !== '') {
      if (!nonempty(value.model) || (model !== undefined && value.model !== model))
        invalidResponse();
      model = value.model;
    }
    if (!Array.isArray(value.choices)) invalidResponse();
    const choices = value.choices.filter((choice) => isObject(choice) && choice.index === 0);
    if (choices.length > 1) invalidResponse();
    if (!choices.length) {
      if (value.choices.some((choice) => !isObject(choice) || !Number.isInteger(choice.index)))
        invalidResponse();
      continue;
    }
    const choice = choices[0];
    if (choice.error != null) upstreamError(choice.error);
    const delta = choice.delta ?? {};
    if (!isObject(delta)) invalidResponse();
    if (delta.content != null) {
      if (typeof delta.content !== 'string' || (stopped && delta.content)) invalidResponse();
      content += delta.content;
      if (delta.content) onContent?.();
    }
    if (delta.refusal != null) {
      if (typeof delta.refusal !== 'string') invalidResponse();
      refused ||= Boolean(delta.refusal);
    }
    annotations(delta.annotations, 'chat-completions', cited);
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      chatFinish(choice.finish_reason);
      stopped = true;
    }
  }
  if (protocol !== 'chat-completions' || !stopped || !model) invalidResponse();
  const answer = finalize(content, cited, searched);
  if (!answer.text.trim()) {
    if (refused) incomplete('refusal');
    invalidResponse();
  }
  return answerFields(model, answer);
}
