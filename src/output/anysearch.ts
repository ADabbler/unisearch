import { colon, text } from '../i18n/messages.js';
import { sourceLabel } from '../i18n/providers.js';
import type { Language } from '../i18n/messages.js';
import type { CatalogData, DomainsData, ExtractData, SearchData } from '../providers/anysearch.js';
import {
  fenced,
  indentListBlock,
  inline,
  inlineCode,
  inlineProse,
  pageBody,
  proseField,
  rankedResults,
} from './markdown.js';
import { renderRetrieval } from './retrieval.js';

export function renderSearch(
  data: SearchData,
  language: Language,
  level = 2,
  showProvider = true,
): string {
  const results = rankedResults(data.results, language, level, (item) => {
    const fields: string[] = [];
    if (item.snippet) fields.push(proseField(language, 'summaryLabel', item.snippet));
    if (item.content) fields.push(pageBody(language, item.content, item.snippet));
    return fields;
  });
  return showProvider ? `${sourceLabel('anysearch', language)}\n\n${results}` : results;
}

export function renderDomains(data: DomainsData | CatalogData, language: Language): string {
  const separator = colon(language);
  const sections = [sourceLabel('anysearch', language)];
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
    if (domain.description)
      sections.push(proseField(language, 'descriptionLabel', domain.description));
    if (!domain.sub_domains.length) sections.push(text(language, 'anysearchNoSubdomains'));
    for (const sub of domain.sub_domains) {
      sections.push(`### ${inline(sub.sub_domain)}`);
      if (sub.description) sections.push(proseField(language, 'descriptionLabel', sub.description));
      if (!sub.params) continue;
      const parameters = Object.entries(sub.params).map(([name, param]) => {
        const required = text(language, param.required ? 'anysearchRequired' : 'anysearchOptional');
        const suffix = language === 'zh' ? `（${required}）` : ` (${required})`;
        const label = `- ${inlineCode(name)}${suffix}`;
        if (!param.description) return label;
        const line = inlineProse(param.description);
        return line === undefined
          ? `${label}\n\n${indentListBlock(fenced(param.description))}`
          : `${label}${separator}${line}`;
      });
      sections.push(parameters.join('\n'));
    }
  }
  return sections.join('\n\n');
}

export function renderExtract({ provider, ...page }: ExtractData, language: Language): string {
  return renderRetrieval({ provider, results: [page] }, language);
}
