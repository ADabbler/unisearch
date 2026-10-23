import type { ContractCase } from './types.js';

export const cases: ContractCase[] = [
  {
    name: 'search renders provenance, authority and score in one line',
    renderer: 'deepseek-search',
    result: {
      status: 'success',
      data: {
        provider: 'deepseek',
        results: [
          {
            title: 'DeepSeek V4 模型发布',
            url: 'https://example.com/deepseek-v4',
            site_name: 'Example News',
            date: '2026-06-01T00:00:00+00:00',
            authority: 3,
            rerank_score: 2.4,
            summary:
              'DeepSeek 发布了 V4 模型。此次发布改进了工具调用与长上下文能力，适合 Agent 工作流。',
          },
        ],
      },
    },
    markdown: `来源：DeepSeek

## 1. [DeepSeek V4 模型发布](https://example.com/deepseek-v4)

站点：Example News · 发布日期：2026-06-01T00:00:00+00:00 · 权威度：3 · 相关性评分：2.4

DeepSeek 发布了 V4 模型。此次发布改进了工具调用与长上下文能力，适合 Agent 工作流。`,
  },
  {
    name: 'search appends requested page text under its own heading',
    renderer: 'deepseek-search',
    result: {
      status: 'success',
      data: {
        provider: 'deepseek',
        results: [
          {
            title: 'DeepSeek V4 模型发布',
            url: 'https://example.com/deepseek-v4',
            summary: 'DeepSeek 发布了 V4 模型。',
            content: '# 正文\n\n完整页面。',
          },
        ],
      },
    },
    markdown: `来源：DeepSeek

## 1. [DeepSeek V4 模型发布](https://example.com/deepseek-v4)

DeepSeek 发布了 V4 模型。

### 正文

# 正文

完整页面。`,
  },
  {
    name: 'search omits unknown authority and absent metadata',
    renderer: 'deepseek-search',
    result: {
      status: 'success',
      data: {
        provider: 'deepseek',
        results: [{ url: 'https://example.com/plain', summary: '唯一可用的字段是摘要。' }],
      },
    },
    markdown: `来源：DeepSeek

## 1. [https://example.com/plain](https://example.com/plain)

唯一可用的字段是摘要。`,
  },
  {
    name: 'empty search results report no matches without failing',
    renderer: 'deepseek-search',
    result: { status: 'success', data: { provider: 'deepseek', results: [] } },
    markdown: `来源：DeepSeek

未找到结果`,
  },
  {
    name: 'fetch shows the title beside the source and keeps the body verbatim',
    renderer: 'deepseek-fetch',
    result: {
      status: 'success',
      data: {
        provider: 'deepseek',
        results: [
          {
            url: 'https://example.com/guide',
            title: '安装指南',
            text: '# 安装\n\n运行 `npm install example-cli`。',
          },
        ],
      },
    },
    markdown: `来源：DeepSeek · [安装指南](https://example.com/guide)

# 安装

运行 \`npm install example-cli\`。`,
  },
  {
    name: 'fetch without a title links the bare address',
    renderer: 'deepseek-fetch',
    result: {
      status: 'success',
      data: {
        provider: 'deepseek',
        results: [{ url: 'https://example.com/raw', text: 'Plain body.' }],
      },
    },
    markdown: `来源：DeepSeek · [https://example.com/raw](https://example.com/raw)

Plain body.`,
  },
];
