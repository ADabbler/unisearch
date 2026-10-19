import { isObject } from '../config/fields.js';
import { colon, text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { JsonObject, JsonValue } from '../result.js';
import type { Data, Operation, ToolContent } from '../providers/zhipu-mcp.js';
import { inline } from './exa.js';
import { link } from './firecrawl.js';

function fenced(value: string, language: string): string {
  let length = 3;
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}${language}\n${value}${value.endsWith('\n') ? '' : '\n'}${fence}`;
}
export function jsonBlock(value: JsonValue): string {
  return fenced(JSON.stringify(value, null, 2), 'json');
}

export function renderBlocks(
  blocks: JsonObject[],
  language: Language,
  operation?: Operation,
): string {
  const sections: string[] = [];
  const sep = colon(language);
  for (const block of blocks) {
    const rest = { ...block };
    if (block.type === 'text' && typeof block.text === 'string') {
      sections.push(
        operation === 'tree' || operation === 'read-file' ? fenced(block.text, 'text') : block.text,
      );
      delete rest.type;
      delete rest.text;
    } else if (block.type === 'resource_link' && typeof block.uri === 'string') {
      const name = typeof block.name === 'string' ? block.name : block.uri;
      sections.push(
        /^https?:\/\//.test(block.uri)
          ? link(block.uri, name)
          : `${inline(name)} · ${inline(block.uri)}`,
      );
      delete rest.type;
      delete rest.uri;
      delete rest.name;
      if (rest.title === name) delete rest.title;
      if (typeof rest.description === 'string') {
        sections.push(rest.description);
        delete rest.description;
      }
      if (typeof rest.mimeType === 'string') {
        sections.push(`${text(language, 'mcpResourceType')}${sep}${inline(rest.mimeType)}`);
        delete rest.mimeType;
      }
    } else if (
      block.type === 'resource' &&
      isObject(block.resource) &&
      typeof block.resource.text === 'string'
    ) {
      const resource = { ...block.resource } as JsonObject;
      const body = resource.text as string;
      sections.push(resource.mimeType === 'text/markdown' ? body : fenced(body, 'text'));
      delete resource.text;
      rest.resource = resource;
    }
    if (Object.keys(rest).length)
      sections.push(`${text(language, 'mcpAttributes')}${sep}`, jsonBlock(rest));
  }
  return sections.join('\n\n');
}

function renderToolContent(data: ToolContent, language: Language, operation?: Operation): string[] {
  const sections: string[] = [];
  const sep = colon(language);
  if (data.text !== undefined) {
    if (data.text === '')
      sections.push(text(language, operation === 'read-file' ? 'mcpEmptyFile' : 'mcpEmpty'));
    else
      sections.push(
        operation === 'tree' || operation === 'read-file' ? fenced(data.text, 'text') : data.text,
      );
  }
  if (data.content?.length) sections.push(renderBlocks(data.content, language, operation));
  else if (data.content && !data.structured_content) sections.push(text(language, 'mcpEmpty'));
  if (data.structured_content !== undefined)
    sections.push(`${text(language, 'mcpStructured')}${sep}`, jsonBlock(data.structured_content));
  if (data.metadata !== undefined)
    sections.push(`${text(language, 'mcpAttributes')}${sep}`, jsonBlock(data.metadata));
  return sections;
}

export function renderMcp(
  data: Data,
  language: Language,
  operation?: Operation,
  showProvider = true,
): string {
  const sections: string[] = showProvider ? [text(language, 'mcpSource')] : [];
  const sep = colon(language);
  if ('results' in data) {
    for (const page of data.results) {
      if (showProvider && data.results.length === 1)
        sections[0] += ` · ${link(page.url, page.title)}`;
      else sections.push(link(page.url, page.title));
      if (page.text !== undefined) sections.push(page.text);
      const { url: _url, title: _title, text: _text, ...rest } = page;
      if (Object.keys(rest).length) sections.push(jsonBlock(rest));
    }
  } else {
    if (data.repo) sections.push(`${text(language, 'mcpRepoLabel')}${sep}${inline(data.repo)}`);
    if (data.path !== undefined)
      sections.push(`${text(language, 'pathLabel')}${sep}${inline(data.path)}`);
  }
  sections.push(...renderToolContent(data, language, operation));
  return sections.join('\n\n');
}
