import { colon, text } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { CatalogData, DomainsData, ExtractData, SearchData } from '../providers/anysearch.js';
import { inline, resultTitle } from './exa.js';
import { inlineCode } from './context7.js';
import { renderRetrieval } from './retrieval.js';

export function renderSearch(
  data: SearchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const sections = showProvider ? [text(language, 'anysearchSource')] : [];
  const results = data.results.map((item, index) => {
    const parts = [
      resultTitle(
        index,
        item.url,
        item.title,
        level,
        !!item.snippet?.trim() || !!item.content?.trim(),
      ),
    ];
    if (item.snippet && item.content)
      parts.push(
        `**${text(language, 'anysearchSnippet')}**`,
        item.snippet,
        `**${text(language, 'anysearchContent')}**`,
        item.content,
      );
    else if (item.snippet) parts.push(item.snippet);
    else if (item.content) parts.push(item.content);
    return parts.join('\n\n');
  });
  sections.push(results.length ? results.join('\n\n---\n\n') : text(language, 'noResults'));
  return sections.join('\n\n');
}

export function renderDomains(data: DomainsData | CatalogData, language: Language): string {
  const separator = colon(language);
  const sections = [text(language, 'anysearchSource')];
  if ('catalog_source' in data) {
    sections[0] += ` · ${text(language, 'anysearchCatalog')}`;
    sections.push(
      data.domains.map((domain) => `- ${domain}`).join('\n'),
      text(language, 'anysearchCatalogUsage'),
    );
    return sections.join('\n\n');
  }
  if (!data.domains.length) sections.push(text(language, 'anysearchNoDomains'));
  for (const domain of data.domains) {
    sections.push(`## ${inline(domain.domain)}`);
    if (domain.description) sections.push(domain.description);
    if (!domain.sub_domains.length) sections.push(text(language, 'anysearchNoSubdomains'));
    for (const sub of domain.sub_domains) {
      sections.push(`### ${inline(sub.sub_domain)}`);
      if (sub.description) sections.push(sub.description);
      if (!sub.params) continue;
      const parameters = Object.entries(sub.params).map(([name, param]) => {
        const required = text(language, param.required ? 'anysearchRequired' : 'anysearchOptional');
        const suffix = language === 'zh' ? `（${required}）` : ` (${required})`;
        const description = param.description
          ? `${separator}${param.description.replace(/\r\n|\r|\n/g, '\n  ')}`
          : '';
        return `- ${inlineCode(name)}${suffix}${description}`;
      });
      sections.push(parameters.join('\n'));
    }
  }
  return sections.join('\n\n');
}

export function renderExtract({ provider, ...page }: ExtractData, language: Language): string {
  return renderRetrieval({ provider, results: [page] }, language);
}
