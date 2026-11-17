import { assertValid, fieldAt, isObject } from './config/fields.js';
import { inspectClassifier } from './config/classifier.js';
import { resolveField } from './config/resolve.js';
import { AppError } from './errors.js';
import type { Language } from './i18n/messages.js';
import { prepareParameters } from './routing-parameters.js';
import type { ParameterPlan } from './routing-parameters.js';
import type { SourcePlan } from './search.js';

export type SearchProvider = SourcePlan['provider'];
export interface RoutingPlan {
  query: string;
  candidates: { id: SearchProvider; description: string }[];
  maxSources: number;
  baseUrl: string;
  apiKey: string;
  model: string;
  retries: number;
  parameters: ParameterPlan[];
}

function describe(
  source: SourcePlan,
  parameters: ParameterPlan | undefined,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): string {
  switch (source.provider) {
    case 'model': {
      const tools = source.request.candidates[0].tools ?? source.request.tools;
      const types = tools.map((tool) => (isObject(tool) ? tool.type : tool));
      const web = types.some((type) => type === 'web_search' || type === 'web_search_preview');
      const x = types.includes('x_search');
      if (web && x)
        return 'Search and information synthesis using the enabled web_search and x_search tools. Supports web retrieval and discovery of X posts and threads, returning findings and available references.';
      if (web)
        return 'Web retrieval and information synthesis using the enabled web_search tool, returning findings and available references.';
      if (x)
        return 'X post and thread retrieval and information synthesis using the enabled x_search tool, returning findings and available references.';
      return 'Search and information synthesis through the configured model, returning findings and available references. Retrieval capabilities are provided by the upstream.';
    }
    case 'exa':
      return 'Semantic and natural-language web discovery for research, technical documentation, company and product information. Supports general search or company, publication, news, personal-site, financial-report and people categories, with balanced, low-latency or research modes. Returns ranked URLs, titles and query-relevant excerpts.';
    case 'tavily':
      return 'Web retrieval for factual lookup and source discovery, with general, news and finance topics and selectable search depth. Returns URLs and relevant snippets or summaries.';
    case 'firecrawl':
      return 'Web discovery with general search, academic/research websites and PDFs, a developer index for repository material and documentation, or US federal, state and local government publications. Returns query-relevant passages when available, otherwise summaries. The default search country is US.';
    case 'jina':
      return 'Web, news or image SERP discovery returning result links and descriptions.';
    case 'zhipu': {
      if (source.request.platform === 'zai')
        return 'Web retrieval through Z.AI Search Prime, returning linked titles and summaries.';
      const engines = parameters
        ? Object.keys(parameters.questions.engine.criteria)
        : [source.request.body.search_engine as string];
      const descriptions: Record<string, string> = {
        search_std: 'search_std serves everyday web queries.',
        search_pro: 'search_pro combines multiple search engines.',
        search_pro_sogou: 'search_pro_sogou covers Tencent News, Penguin accounts and Zhihu.',
        search_pro_quark: "search_pro_quark uses Quark's web-search source.",
      };
      return `Web discovery through BigModel using ${engines.join(', ')}. ${engines.map((engine) => descriptions[engine]).join(' ')} Returns linked titles and summaries.`;
    }
    case 'zhipu-mcp': {
      const platform =
        resolveField(values, env, fieldAt('providers.zhipu-mcp.platform')).value === 'zai'
          ? 'Z.AI'
          : 'BigModel';
      return `Web and current-information retrieval through ${platform} Coding Plan's webSearchPrime tool, returning linked search results and summaries.`;
    }
    case 'anysearch':
      return 'Intent-routed general search through a gateway that combines and reranks sources. Returns URLs and available snippets or cleaned content.';
    case 'tinyfish':
      return 'Web, news or research-paper search returning structured titles, URLs and snippets. Paper results may include authors, venue, publication year and citation counts. Uses the default US/en locale; supports site: operators already present in query.';
    case 'deepseek':
      return 'Multilingual web retrieval with query-focused long summaries, URLs and provider-supplied authority and rerank scores. Useful for source discovery and inspecting relevance signals. Supports site:, lang:, after: and before: operators already present in query.';
  }
}

export function prepareRouting(
  query: string,
  sources: SourcePlan[],
  maxSources: number,
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  language: Language,
): RoutingPlan | undefined {
  const parameters = sources.flatMap((source) => {
    const plan = prepareParameters(query, source, values, env, language);
    return plan ? [plan] : [];
  });
  if (sources.length === 1 && !parameters.length) return undefined;
  const { resolved, problems, missing } = inspectClassifier(values, env);
  assertValid(problems, language);
  if (missing.length)
    throw new AppError('MISSING_CONFIG', missing[0].message, { field: missing[0].field! });
  const get = (name: string) =>
    resolved.find((setting) => setting.field.path === `search.routing.classifier.${name}`)!.value;
  return {
    query,
    candidates: sources.map((source) => ({
      id: source.provider,
      description: describe(
        source,
        parameters.find((plan) => plan.provider === source.provider),
        values,
        env,
      ),
    })),
    maxSources,
    baseUrl: get('base_url') as string,
    apiKey: get('api_key') as string,
    model: get('model') as string,
    retries: sources[0].request.retries,
    parameters,
  };
}
