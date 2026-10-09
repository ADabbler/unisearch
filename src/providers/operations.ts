import { modelSearch } from './model-config.js';
import { exaOperations } from './exa.js';
import { tavilyOperations } from './tavily.js';
import { operations as firecrawl } from './firecrawl.js';
import { operations as context7 } from './context7.js';
import { operations as jina } from './jina.js';
import { operations as zhipu } from './zhipu.js';
import { operations as mcp } from './zhipu-mcp.js';
import { operations as anysearch } from './anysearch.js';
import { operations as tinyfish } from './tinyfish.js';

export const operations = [
  modelSearch,
  ...exaOperations,
  ...context7,
  ...anysearch,
  ...tavilyOperations,
  ...firecrawl,
  ...jina,
  ...zhipu,
  ...mcp,
  ...tinyfish,
];
