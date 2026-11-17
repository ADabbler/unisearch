import { fieldAt } from './config/fields.js';
import { resolveField } from './config/resolve.js';
import type { Language } from './i18n/messages.js';
import { prepareSearch as prepareExa } from './providers/exa.js';
import { prepareSearch as prepareFirecrawl } from './providers/firecrawl.js';
import { prepareSearch as prepareJina } from './providers/jina.js';
import { prepareTavilySearch } from './providers/tavily.js';
import { prepareSearch as prepareTinyfish } from './providers/tinyfish.js';
import { prepare as prepareZhipu } from './providers/zhipu.js';
import type { JsonObject } from './result.js';
import type { SourcePlan } from './search.js';

export interface ParameterQuestion {
  purpose: string;
  criteria: Record<string, string>;
}

export interface ParameterPlan {
  provider: SourcePlan['provider'];
  current: JsonObject;
  questions: Record<string, ParameterQuestion>;
  prepare: (choices: Record<string, string>) => SourcePlan;
}

export function prepareParameters(
  query: string,
  source: SourcePlan,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): ParameterPlan | undefined {
  const { provider, request } = source;
  const timeout = request.timeout;
  switch (provider) {
    case 'exa':
      return {
        provider,
        current: { search_type: request.body.type, category: 'none' },
        questions: {
          search_type: {
            purpose: 'retrieval strategy',
            criteria: {
              auto: 'Balance search quality and speed for general-purpose retrieval.',
              lite: 'Low-cost, low-latency retrieval from the refreshed index without fetching pages at query time; suitable when cached content is sufficient.',
              'deep-lite': 'Lightweight research, with less latency than full deep search.',
              deep: 'Comprehensive multi-step research for queries that need broader investigation.',
            },
          },
          category: {
            purpose: 'source category',
            criteria: {
              none: 'General search without restricting the source category.',
              company: 'Company pages and profiles for company discovery and company information.',
              publication:
                'Scholarly publications, including research papers, preprints and journal articles.',
              news: 'News reports and coverage of events.',
              'personal site': 'Personal websites and personal blogs.',
              'financial report': 'Financial reports and company financial disclosures.',
              people: 'People profiles for finding individuals and their professional information.',
            },
          },
        },
        prepare: (choices) => ({
          provider,
          request: prepareExa(
            query,
            {
              timeout,
              searchType: choices.search_type,
              category: choices.category === 'none' ? undefined : choices.category,
            },
            values,
            env,
            language,
          ),
        }),
      };
    case 'tavily':
      return {
        provider,
        current: { search_depth: request.body.search_depth, topic: request.body.topic },
        questions: {
          search_depth: {
            purpose: 'search depth',
            criteria: {
              basic:
                'Balance relevance and latency for general-purpose search; returns relevant snippets per URL. Costs 1 API credit.',
              advanced:
                'Prioritize relevance for detailed, high-precision retrieval, with increased latency and relevant snippets per URL. Costs 2 API credits.',
              fast: 'Prioritize lower latency while retaining relevant snippets per URL. Costs 1 API credit.',
              'ultra-fast':
                'Minimize latency for retrieval where response speed is critical; returns one NLP summary per URL. Costs 1 API credit.',
            },
          },
          topic: {
            purpose: 'search topic',
            criteria: {
              general: 'Broad, general-purpose web retrieval across a range of sources.',
              news: 'News reporting and current-event updates from news sources.',
              finance: 'Financial and market-related information.',
            },
          },
        },
        prepare: (choices) => ({
          provider,
          request: prepareTavilySearch(
            query,
            { timeout, searchDepth: choices.search_depth, topic: choices.topic },
            values,
            env,
            language,
          ),
        }),
      };
    case 'firecrawl':
      return {
        provider,
        current: { categories: 'none' },
        questions: {
          categories: {
            purpose: 'search category combination',
            criteria: {
              none: 'General web search without a category restriction.',
              research:
                'Academic and research websites; returns web pages rather than structured paper records.',
              pdf: 'PDF documents.',
              'research,pdf':
                'Include both academic/research websites and PDF documents in the search.',
              developer:
                'Developer-index results from public repositories and documentation, including issues, merged pull requests and READMEs.',
              gov: 'Statutes, regulations, codes, court opinions and other government publications from US federal, state and local sources.',
            },
          },
        },
        prepare: (choices) => ({
          provider,
          request: prepareFirecrawl(
            query,
            { timeout, categories: choices.categories === 'none' ? undefined : choices.categories },
            values,
            env,
            language,
          ),
        }),
      };
    case 'jina':
      return {
        provider,
        current: { search_type: request.searchType },
        questions: {
          search_type: {
            purpose: 'result type',
            criteria: {
              web: 'General web pages and source discovery.',
              news: 'News reports and event coverage.',
              images: 'Image discovery when visual material is a requested result.',
            },
          },
        },
        prepare: (choices) => ({
          provider,
          request: prepareJina(
            query,
            { timeout, searchType: choices.search_type },
            values,
            env,
            language,
          ),
        }),
      };
    case 'zhipu': {
      const engineField = resolveField(values, env, fieldAt('providers.zhipu.search.engine')).field;
      const engines = (engineField.choices as string[]).filter((engine) => {
        const overrides = {
          [engineField.path]: { field: engineField, value: engine, source: 'cli', problems: [] },
        };
        return !resolveField(values, env, fieldAt('providers.zhipu.search.limit'), overrides)
          .problems.length;
      });
      if (engines.length === 1) return undefined;
      const descriptions: Record<string, string> = {
        search_std:
          "BigModel's standard engine for everyday web queries, with a lower published per-request price than its pro engines.",
        search_pro:
          "BigModel's multi-engine search for broader retrieval, at a higher published per-request price than search_std.",
        search_pro_sogou:
          'Sogou search, including Tencent News, Penguin accounts and Zhihu content; costs more per request than search_std at published prices.',
        search_pro_quark:
          "Quark's web-search source, at a higher published per-request price than search_std.",
      };
      return {
        provider,
        current: { engine: request.body.search_engine },
        questions: {
          engine: {
            purpose: 'search engine',
            criteria: Object.fromEntries(engines.map((engine) => [engine, descriptions[engine]])),
          },
        },
        prepare: (choices) => ({
          provider,
          request: prepareZhipu(
            'search',
            query,
            { timeout, engine: choices.engine },
            values,
            env,
            language,
          ),
        }),
      };
    }
    case 'tinyfish':
      return {
        provider,
        current: { search_type: new URL(request.url).searchParams.get('domain_type')! },
        questions: {
          search_type: {
            purpose: 'search type',
            criteria: {
              web: 'General web pages and source discovery.',
              news: 'News reports and current-event coverage.',
              research_paper:
                'Academic-paper discovery with available author, venue, publication-year and citation-count metadata.',
            },
          },
        },
        prepare: (choices) => ({
          provider,
          request: prepareTinyfish(
            query,
            { timeout, searchType: choices.search_type },
            values,
            env,
            language,
          ),
        }),
      };
    default:
      return undefined;
  }
}
