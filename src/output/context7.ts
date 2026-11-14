import { colon, text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { Data, CodeSnippet, InfoSnippet, Version } from '../providers/context7.js';
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
  if ('url' in data) {
    sections.push(
      link(data.url, data.title || data.url),
      text(language, 'ctx7Untrusted'),
      `${text(language, 'ctx7ContentCheck')}${sep}${inline(data.content_check_header ?? data.content_check)}`,
    );
    if (data.offset !== undefined)
      sections.push(
        `${text(language, 'ctx7OffsetLabel')}${sep}${data.offset} · ${text(language, 'ctx7LengthLabel')}${sep}${data.total_length}`,
      );
    if (data.next_offset !== undefined)
      sections.push(`${text(language, 'ctx7NextOffset')}${sep}${data.next_offset}`);
    if (data.truncated) sections.push(text(language, 'ctx7PageTruncated'));
    if (data.text !== undefined) sections.push(data.text);
    for (const highlight of data.highlights ?? []) {
      if (highlight.relevance !== undefined)
        sections.push(`${text(language, 'relevanceScore')}${sep}${highlight.relevance}`);
      sections.push(highlight.text);
    }
  } else if ('results' in data) {
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
    if (data.library_id)
      sections[0] += ` · ${text(language, 'ctx7LibraryLabel')}${sep}${inlineCode(data.library_id)}`;
    if (data.version) {
      const versions = 'libraries' in data.version ? data.version.libraries : [data.version];
      for (const version of versions) sections.push(renderVersion(version, language));
    }
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
      for (const rules of data.rules.libraries ?? []) {
        sections.push(`### ${inlineCode(rules.library_id)}`);
        for (const key of ['library_own', 'library_team'] as const) {
          if (rules[key]?.length)
            sections.push(
              `${text(language, key === 'library_own' ? 'ctx7OwnRules' : 'ctx7TeamRules')}${sep}`,
              ...rules[key],
            );
        }
      }
    }
    const snippets: (CodeSnippet | InfoSnippet)[] = [
      ...data.code_snippets,
      ...data.info_snippets,
    ].sort((a, b) => a.rank - b.rank);
    for (const snippet of snippets) {
      if (snippet.library_id)
        sections.push(
          `${text(language, 'ctx7LibraryLabel')}${sep}${inlineCode(snippet.library_id)}`,
        );
      if ('content' in snippet) {
        sections.push(`## ${text(language, 'ctx7Info')}`);
        if (snippet.breadcrumb) sections.push(`### ${inline(snippet.breadcrumb)}`);
        if (snippet.url)
          sections.push(`${text(language, 'sourceLabel')}${sep}${link(snippet.url)}`);
        sections.push(snippet.content);
      } else {
        sections.push(`## ${text(language, 'ctx7Code')}`);
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
    }
    if (!data.code_snippets.length && !data.info_snippets.length)
      sections.push(text(language, 'ctx7NoDocs'));
  }
  for (const [key, label] of [
    ['search_status', 'ctx7SearchStatus'],
    ['search_reason', 'reasonLabel'],
    ['search_version', 'ctx7VersionLabel'],
  ] as const)
    if (data[key]) sections.push(`${text(language, label)}${sep}${inline(data[key])}`);
  return sections.join('\n\n');
}
function renderVersion(version: Version, language: Language): string {
  return `${text(language, 'ctx7VersionLabel')}${colon(language)}${inlineCode(version.library_id)} · ${inline(version.requested)} → ${version.served === null ? text(language, 'ctx7Current') : inline(version.served)} · ${version.status}`;
}
