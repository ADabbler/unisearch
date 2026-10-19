import { colon, text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { Data } from '../providers/context7.js';
import { inline } from './exa.js';
import { link } from './firecrawl.js';

function backtickFence(value: string, minimum: number): string {
  let length = minimum;
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return '`'.repeat(length);
}
export function inlineCode(value: string): string {
  const content = value.replace(/[\r\n]+/g, ' ');
  const fence = backtickFence(content, 1);
  const padding = content.includes('`') ? ' ' : '';
  return `${fence}${padding}${content}${padding}${fence}`;
}
export function renderContext7(data: Data, language: Language): string {
  const sep = colon(language);
  const sections = [text(language, 'ctx7Source')];
  if ('results' in data) {
    if (data.search_filter_applied) sections.push(text(language, 'ctx7Filtered'));
    for (const [index, item] of data.results.entries()) {
      sections.push(
        `## ${index + 1}. ${inline(item.title ?? item.id)}`,
        `${text(language, 'ctx7IdLabel')}${sep}${inlineCode(item.id)}`,
      );
      if (item.description) sections.push(item.description);
      if (item.versions)
        sections.push(
          `${text(language, 'ctx7Versions')}${sep}${item.versions.map(inlineCode).join(language === 'zh' ? '、' : ', ')}`,
        );
      const meta: string[] = [];
      for (const [key, label] of [
        ['total_snippets', 'ctx7Snippets'],
        ['trust_score', 'ctx7Trust'],
        ['benchmark_score', 'ctx7Benchmark'],
        ['state', 'ctx7State'],
      ] as const) {
        if (item[key] !== undefined)
          meta.push(`${text(language, label)}${sep}${inline(String(item[key]))}`);
      }
      if (meta.length) sections.push(meta.join(' · '));
    }
    if (!data.results.length) sections.push(text(language, 'ctx7NoLibraries'));
  } else {
    sections[0] += ` · ${text(language, 'ctx7LibraryLabel')}${sep}${inlineCode(data.library_id)}`;
    if (data.rules) {
      sections.push(`## ${text(language, 'ctx7Rules')}`);
      for (const [key, label] of [
        ['global', 'ctx7GlobalRules'],
        ['library_own', 'ctx7OwnRules'],
        ['library_team', 'ctx7TeamRules'],
      ] as const) {
        const rules = data.rules[key];
        if (rules?.length) {
          sections.push(`### ${text(language, label)}`);
          for (const rule of rules) sections.push(rule);
        }
      }
    }
    if (data.code_snippets.length) sections.push(`## ${text(language, 'ctx7Code')}`);
    for (const snippet of data.code_snippets) {
      if (snippet.title) sections.push(`### ${inline(snippet.title)}`);
      sections.push(`${text(language, 'sourceLabel')}${sep}${link(snippet.url)}`);
      if (snippet.is_dynamic) sections.push(text(language, 'ctx7Dynamic'));
      if (snippet.source_file)
        sections.push(
          `${text(language, 'ctx7SourceFile')}${sep}${inlineCode(snippet.source_file)}`,
        );
      if (snippet.description) sections.push(snippet.description);
      for (const example of snippet.examples ?? []) {
        const languageSafe = example.language && /^[\w.+#-]+$/.test(example.language);
        if (example.language && !languageSafe)
          sections.push(`${text(language, 'ctx7CodeLanguage')}${sep}${inline(example.language)}`);
        const fence = backtickFence(example.code, 3);
        sections.push(
          `${fence}${languageSafe ? example.language : ''}\n${example.code}${example.code.endsWith('\n') ? '' : '\n'}${fence}`,
        );
      }
    }
    if (data.info_snippets.length) sections.push(`## ${text(language, 'ctx7Info')}`);
    for (const snippet of data.info_snippets) {
      if (snippet.breadcrumb) sections.push(`### ${inline(snippet.breadcrumb)}`);
      if (snippet.url) sections.push(`${text(language, 'sourceLabel')}${sep}${link(snippet.url)}`);
      sections.push(snippet.content);
    }
    if (!data.code_snippets.length && !data.info_snippets.length)
      sections.push(text(language, 'ctx7NoDocs'));
  }
  return sections.join('\n\n');
}
