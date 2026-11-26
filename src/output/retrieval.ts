import { colon, text } from '../i18n/messages.js';
import { sourceLabel } from '../i18n/providers.js';
import type { Language } from '../i18n/messages.js';
import type { RetrievalData } from '../retrieval.js';
import { contentInfo, renderMapLinks, warnings } from './firecrawl.js';
import { contentSources } from './exa.js';
import { fenced, inline, renderPages } from './markdown.js';
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
  const source = sourceLabel(data.provider, language);
  const notes = warnings(data.warnings, language);
  if ('links' in data) return [source, ...notes, renderMapLinks(data.links, language)].join('\n\n');
  return renderPages(
    data.results,
    language,
    source,
    (page, single) => {
      const sections: string[] = [];
      const sep = colon(language);
      const metadata = [
        page.published_date
          ? `${text(language, 'publishedLabel')}${sep}${inline(page.published_date)}`
          : '',
        page.author ? `${text(language, 'authorLabel')}${sep}${inline(page.author)}` : '',
      ].filter(Boolean);
      if (metadata.length) sections.push(metadata.join(' · '));
      sections.push(...contentInfo(page, language));
      if (page.text) sections.push(single ? page.text : fenced(page.text));
      return sections;
    },
    [...notes, ...contentSources(data.content_sources, language)],
  );
}
