import { colon, text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { RetrievalData } from '../retrieval.js';
import { contentInfo, link, warnings } from './firecrawl.js';
import { contentSources, inline } from './exa.js';
import { renderJina } from './jina.js';
import { renderZhipu } from './zhipu.js';
import { renderFetch as renderTinyfish } from './tinyfish.js';
import { renderMcp } from './zhipu-mcp.js';

export function renderRetrieval(data: RetrievalData, language: Language): string {
  if (data.provider === 'zhipu' && 'results' in data)
    return renderZhipu({ ...data, provider: 'zhipu' }, language);
  if (data.provider === 'zhipu-mcp' && 'results' in data)
    return renderMcp({ ...data, provider: 'zhipu-mcp' }, language, 'fetch');
  if (data.provider === 'jina' && 'results' in data)
    return renderJina({ provider: 'jina', results: data.results }, language);
  if (data.provider === 'tinyfish' && 'results' in data)
    return renderTinyfish({ provider: 'tinyfish', results: data.results }, language);
  const sourceLabels = {
    tavily: 'tavilySource',
    firecrawl: 'firecrawlSource',
    exa: 'exaSource',
    jina: 'jinaSource',
    zhipu: 'zhipuSource',
    anysearch: 'anysearchSource',
    tinyfish: 'tinyfishSource',
    'zhipu-mcp': 'mcpSource',
  } as const;
  const source = text(language, sourceLabels[data.provider]);
  const sections = [source, ...warnings(data.warnings, language)];
  if ('links' in data) {
    sections.push(
      data.links.length
        ? data.links
            .map((item, index) => {
              const description = item.description
                ?.split(/\r\n|\r|\n/)
                .map((line) => `${' '.repeat(String(index + 1).length + 2)}${line}`)
                .join('\n');
              return `${index + 1}. ${link(item.url, item.title)}${description ? `\n${description}` : ''}`;
            })
            .join('\n')
        : text(language, 'noSiteLinks'),
    );
  } else {
    sections.push(...contentSources(data.content_sources, language));
    for (const page of data.results) {
      if (data.results.length === 1) sections[0] += ` · ${link(page.url, page.title)}`;
      else sections.push(`## ${link(page.url, page.title)}`);
      const sep = colon(language);
      const metadata = [
        page.published_date
          ? `${text(language, 'publishedLabel')}${sep}${inline(page.published_date)}`
          : '',
        page.author ? `${text(language, 'authorLabel')}${sep}${inline(page.author)}` : '',
      ].filter(Boolean);
      if (metadata.length) sections.push(metadata.join(' · '));
      sections.push(...contentInfo(page, language));
      if (page.text) sections.push(page.text);
    }
  }
  return sections.join('\n\n');
}
