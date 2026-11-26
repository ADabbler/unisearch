import { isObject } from '../config/fields.js';
import { colon, text } from '../i18n/messages.js';
import { sourceLabel } from '../i18n/providers.js';
import type { Language } from '../i18n/messages.js';
import type { JsonObject } from '../result.js';
import type { Data, Operation, ToolContent } from '../providers/zhipu-mcp.js';
import {
  blockField,
  fenced,
  inline,
  inlineCode,
  jsonBlock,
  link,
  proseField,
  renderPages,
} from './markdown.js';

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
        fenced(block.text, operation === 'tree' || operation === 'read-file' ? 'text' : ''),
      );
      delete rest.type;
      delete rest.text;
    } else if (block.type === 'resource_link' && typeof block.uri === 'string') {
      const name = typeof block.name === 'string' ? block.name : block.uri;
      if (/^https?:\/\//i.test(block.uri)) sections.push(link(block.uri, name));
      else if (name.trim() && name !== block.uri)
        sections.push(`${inline(name)} · ${inlineCode(block.uri)}`);
      else sections.push(inlineCode(block.uri));
      delete rest.type;
      delete rest.uri;
      delete rest.name;
      if (rest.title === name) delete rest.title;
      if (typeof rest.description === 'string') {
        if (rest.description.trim())
          sections.push(proseField(language, 'descriptionLabel', rest.description));
        delete rest.description;
      }
      if (typeof rest.mimeType === 'string') {
        sections.push(`${text(language, 'zhipuMcpResourceType')}${sep}${inline(rest.mimeType)}`);
        delete rest.mimeType;
      }
    } else if (
      block.type === 'resource' &&
      isObject(block.resource) &&
      typeof block.resource.text === 'string'
    ) {
      const resource = { ...block.resource } as JsonObject;
      const body = resource.text as string;
      sections.push(fenced(body, resource.mimeType === 'text/markdown' ? '' : 'text'));
      delete resource.text;
      rest.resource = resource;
    }
    if (Object.keys(rest).length)
      sections.push(blockField(language, 'zhipuMcpAttributes', jsonBlock(rest)));
  }
  return sections.join('\n\n');
}

function renderToolContent(data: ToolContent, language: Language, operation?: Operation): string[] {
  const sections: string[] = [];
  if (data.text !== undefined) {
    if (data.text === '')
      sections.push(
        text(language, operation === 'read-file' ? 'zhipuMcpEmptyFile' : 'zhipuMcpEmpty'),
      );
    else
      sections.push(
        fenced(data.text, operation === 'tree' || operation === 'read-file' ? 'text' : ''),
      );
  }
  if (data.content?.length) sections.push(renderBlocks(data.content, language, operation));
  else if (data.content && !data.structured_content) sections.push(text(language, 'zhipuMcpEmpty'));
  if (data.structured_content !== undefined)
    sections.push(blockField(language, 'zhipuMcpStructured', jsonBlock(data.structured_content)));
  if (data.metadata !== undefined)
    sections.push(blockField(language, 'zhipuMcpAttributes', jsonBlock(data.metadata)));
  return sections;
}

export function renderMcp(
  data: Data,
  language: Language,
  operation?: Operation,
  showProvider = true,
): string {
  const source = sourceLabel('zhipu-mcp', language);
  const sections: string[] = [];
  const sep = colon(language);
  if ('results' in data) {
    sections.push(
      renderPages(data.results, language, source, (page, single) => {
        const fields: string[] = [];
        if (page.text !== undefined) fields.push(single ? page.text : fenced(page.text));
        const { url: _url, title: _title, text: _text, ...rest } = page;
        if (Object.keys(rest).length) fields.push(jsonBlock(rest));
        return fields;
      }),
    );
  } else {
    if (showProvider) sections.push(source);
    if (data.repo)
      sections.push(`${text(language, 'zhipuMcpRepoLabel')}${sep}${inline(data.repo)}`);
    if (data.path !== undefined)
      sections.push(`${text(language, 'pathLabel')}${sep}${inline(data.path)}`);
  }
  sections.push(...renderToolContent(data, language, operation));
  return sections.join('\n\n');
}
