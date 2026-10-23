import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from '../src/output/render.js';
import type { RenderData } from '../src/output/render.js';
import { renderCombinedSearch } from '../src/output/search.js';
import { renderRetrieval } from '../src/output/retrieval.js';
import { renderContext7 } from '../src/output/context7.js';
import { renderFetch as renderExaFetch, renderExecution } from '../src/output/exa.js';
import { renderTavilySearch, renderExtract, renderMap } from '../src/output/tavily.js';
import * as anysearch from '../src/output/anysearch.js';
import { renderJina } from '../src/output/jina.js';
import * as tinyfish from '../src/output/tinyfish.js';
import * as deepseek from '../src/output/deepseek.js';
import { renderMcp } from '../src/output/zhipu-mcp.js';
import { renderZhipu } from '../src/output/zhipu.js';
import type { Data as McpData } from '../src/providers/zhipu-mcp.js';
import type { JsonObject, Outcome } from '../src/result.js';
import { cases as model } from './fixtures/contracts/model-search.js';
import { cases as retrieval } from './fixtures/contracts/unified-retrieval.js';
import { cases as context7 } from './fixtures/contracts/context7.js';
import { cases as exa } from './fixtures/contracts/exa.js';
import { cases as tavily } from './fixtures/contracts/tavily.js';
import { cases as anysearchCases } from './fixtures/contracts/anysearch.js';
import { cases as jina } from './fixtures/contracts/jina.js';
import { cases as tinyfishCases } from './fixtures/contracts/tinyfish.js';
import { cases as deepseekCases } from './fixtures/contracts/deepseek.js';
import { cases as mcp } from './fixtures/contracts/zhipu-mcp.js';
import { cases as zhipu } from './fixtures/contracts/zhipu.js';

const renderers = {
  search: renderCombinedSearch,
  retrieval: renderRetrieval,
  context7: renderContext7,
  'exa-fetch': renderExaFetch,
  'tavily-search': renderTavilySearch,
  'tavily-extract': renderExtract,
  'tavily-map': renderMap,
  'anysearch-search': anysearch.renderSearch,
  'anysearch-domains': anysearch.renderDomains,
  'anysearch-extract': anysearch.renderExtract,
  jina: renderJina,
  'tinyfish-search': tinyfish.renderSearch,
  'tinyfish-fetch': tinyfish.renderFetch,
  'deepseek-search': deepseek.renderSearch,
  'deepseek-fetch': deepseek.renderFetch,
  'mcp-search': (data: McpData) => renderMcp(data, 'zh', 'search'),
  'mcp-fetch': (data: McpData) => renderMcp(data, 'zh', 'fetch'),
  'mcp-docs': (data: McpData) => renderMcp(data, 'zh', 'docs'),
  'mcp-tree': (data: McpData) => renderMcp(data, 'zh', 'tree'),
  'mcp-read-file': (data: McpData) => renderMcp(data, 'zh', 'read-file'),
  zhipu: renderZhipu,
};

for (const [group, cases] of Object.entries({
  model,
  retrieval,
  context7,
  exa,
  tavily,
  anysearch: anysearchCases,
  jina,
  tinyfish: tinyfishCases,
  deepseek: deepseekCases,
  'zhipu-mcp': mcp,
  zhipu,
})) {
  for (const { name, result, renderer, markdown, stderr, details } of cases) {
    test(`${group}: ${name}`, () => {
      const outcome = {
        result,
        exitCode: { success: 0, partial: 6, error: 4 }[result.status],
      } as Outcome<JsonObject>;
      const actual = render(outcome, {
        format: 'markdown',
        language: 'zh',
        renderData: renderers[renderer] as RenderData<JsonObject>,
        ...(details === undefined
          ? {}
          : { verbose: true, execution: { data: result.meta!, markdown: renderExecution } }),
      });
      assert.equal(actual.content.trimEnd(), markdown ?? '');
      if (stderr !== undefined) assert.equal(actual.details.trimEnd(), stderr);
      if (details !== undefined) assert.equal(actual.details.trimEnd(), details);
    });
  }
}
