import type { JsonObject, Result } from '../../../src/result.js';

export type ContractCase = {
  name: string;
  renderer:
    | 'search'
    | 'retrieval'
    | 'context7'
    | 'exa-fetch'
    | 'tavily-search'
    | 'tavily-extract'
    | 'tavily-map'
    | 'anysearch-search'
    | 'anysearch-domains'
    | 'anysearch-extract'
    | 'jina'
    | 'tinyfish-search'
    | 'tinyfish-fetch'
    | 'mcp-search'
    | 'mcp-fetch'
    | 'mcp-docs'
    | 'mcp-tree'
    | 'mcp-read-file'
    | 'zhipu';
  result: Result<JsonObject>;
  markdown?: string;
  stderr?: string;
  details?: string;
};
