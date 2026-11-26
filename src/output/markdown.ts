import { colon, text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import type { JsonValue } from '../result.js';

const entityStart = /&(?=#?\w+;)/g;

export function inline(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_[\]<>~]/g, '\\$&')
    .replace(entityStart, '\\&');
}

export function link(url: string, title?: string): string {
  const target = url.replace(/[<>\s\\]/g, encodeURIComponent);
  if (!title?.trim() || title === url) return `<${target}>`;
  const destination = target.replace(entityStart, '\\&');
  return `[${inline(title)}](${/[()]/.test(target) ? `<${destination}>` : destination})`;
}

function backticks(value: string, mode: 'inline' | 'block'): string {
  const pattern = mode === 'block' ? /^ {0,3}(`{3,})[ \t]*$/gm : /(`+)/g;
  let length = mode === 'block' ? 3 : 1;
  for (const [, run] of value.matchAll(pattern)) length = Math.max(length, run.length + 1);
  return '`'.repeat(length);
}

export function inlineCode(value: string): string {
  const content = value.replace(/[\r\n]+/g, ' ');
  const fence = backticks(content, 'inline');
  const edgeSpaces = content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content);
  const padding = content.includes('`') || edgeSpaces ? ' ' : '';
  return `${fence}${padding}${content}${padding}${fence}`;
}

export function fenced(value: string, syntax = ''): string {
  const fence = backticks(value, 'block');
  return `${fence}${syntax}\n${value}${/[\r\n]$/.test(value) ? '' : '\n'}${fence}`;
}

export function jsonBlock(value: JsonValue): string {
  return fenced(JSON.stringify(value, null, 2), 'json');
}

export function blockField(language: Language, key: MessageKey, body: string): string {
  return `**${text(language, key)}**\n\n${body}`;
}

export function distinctSummary(
  summary: string | undefined,
  body: string | undefined,
): string | undefined {
  return summary !== body && summary?.trim() ? summary : undefined;
}

export function pageBody(
  language: Language,
  value: string,
  summaryOrHighlights: string | readonly string[] | undefined,
  standalone = false,
): string {
  const body = standalone ? value : fenced(value);
  return summaryOrHighlights?.length ? blockField(language, 'textLabel', body) : body;
}

export function highlightField(
  language: Language,
  items: (string | { text: string; relevance?: number })[],
): string {
  const blocks = items.map((item) => {
    const { text: value, relevance } = typeof item === 'string' ? { text: item } : item;
    const body = fenced(value.replace(/\r\n?/g, '\n'));
    return relevance === undefined
      ? body
      : `${text(language, 'relevanceScore')}${colon(language)}${relevance}\n\n${body}`;
  });
  return blockField(language, 'highlightsLabel', blocks.join('\n\n'));
}

export function inlineProse(value: string): string | undefined {
  const line = value.replace(/(?:\r\n|[\r\n])$/, '');
  return /[\r\n]/.test(line) ? undefined : inline(line);
}

export function proseField(language: Language, key: MessageKey, value: string): string {
  const line = inlineProse(value);
  return line === undefined
    ? blockField(language, key, fenced(value))
    : `**${text(language, key)}**${colon(language)}${line}`;
}

export function indentListBlock(value: string): string {
  return value
    .split(/\r\n?|\n/)
    .map((line) => (line ? `  ${line}` : ''))
    .join('\n');
}

export function diagnostic(value: string): string {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

type PageLink = { url: string; title?: string };

export function rankedResults<T extends PageLink>(
  items: T[],
  language: Language,
  level: number,
  fields: (item: T, index: number) => string[],
): string {
  if (!items.length) return text(language, 'noResults');
  const entries = items.map((item, index) => [
    `${index + 1}. ${link(item.url, item.title)}`,
    ...fields(item, index),
  ]);
  if (entries.every((entry) => entry.length === 1))
    return entries.map(([title]) => title).join('\n');
  return entries.map((entry) => `${'#'.repeat(level)} ${entry.join('\n\n')}`).join('\n\n');
}

export function renderPages<T extends PageLink>(
  pages: T[],
  language: Language,
  source: string,
  fields: (page: T, single: boolean) => string[],
  notes: string[] = [],
): string {
  if (!pages.length) return [source, ...notes, text(language, 'noResults')].join('\n\n');
  if (pages.length === 1) {
    const [page] = pages;
    return [`${source} · ${link(page.url, page.title)}`, ...notes, ...fields(page, true)].join(
      '\n\n',
    );
  }
  return [
    source,
    ...notes,
    ...pages.flatMap((page, index) => [
      `## ${index + 1}. ${link(page.url, page.title)}`,
      ...fields(page, false),
    ]),
  ].join('\n\n');
}
