import type { ContractCase } from './types.js';

export const cases: ContractCase[] = [
  {
    name: 'single-page content',
    renderer: 'retrieval',
    result: {
      status: 'success',
      data: {
        provider: 'tavily',
        results: [
          {
            url: 'https://example.org/docs',
            text: '# Guide\n\nUse `unisearch status`.',
          },
        ],
      },
    },
    markdown: `来源：Tavily · [https://example.org/docs](https://example.org/docs)

# Guide

Use \`unisearch status\`.`,
  },
  {
    name: 'document page count and upstream warnings',
    renderer: 'retrieval',
    result: {
      status: 'success',
      data: {
        provider: 'firecrawl',
        results: [
          {
            url: 'https://example.org/report',
            text: '# Report\n\nAvailable document content.',
            title: 'Report',
            final_url: 'https://example.org/report.pdf',
            content_type: 'application/pdf',
            content_truncation: {
              parsed_pages: 2,
              total_pages: 5,
            },
          },
        ],
        warnings: ['Some document pages were not parsed.'],
      },
    },
    markdown: `来源：Firecrawl · [Report](https://example.org/report)

上游提示：Some document pages were not parsed.

最终 URL：https://example.org/report.pdf

正文已解析 2 页，文档共 5 页

# Report

Available document content.`,
  },
  {
    name: 'site links',
    renderer: 'retrieval',
    result: {
      status: 'success',
      data: {
        provider: 'tavily',
        links: [
          {
            url: 'https://example.org/docs',
          },
          {
            url: 'https://example.org/api',
          },
        ],
      },
    },
    markdown: `来源：Tavily

1. [https://example.org/docs](https://example.org/docs)
2. [https://example.org/api](https://example.org/api)`,
  },
  {
    name: 'site titles and descriptions',
    renderer: 'retrieval',
    result: {
      status: 'success',
      data: {
        provider: 'firecrawl',
        links: [
          {
            url: 'https://example.org/docs',
            title: 'Guide',
            description: 'Command reference.',
          },
        ],
      },
    },
    markdown: `来源：Firecrawl

1. [Guide](https://example.org/docs)
   Command reference.`,
  },
  {
    name: 'empty site links',
    renderer: 'retrieval',
    result: {
      status: 'success',
      data: {
        provider: 'tavily',
        links: [],
      },
    },
    markdown: `来源：Tavily

未发现站点链接`,
  },
  {
    name: 'result count mismatch retains content',
    renderer: 'retrieval',
    result: {
      status: 'error',
      data: {
        provider: 'tavily',
        results: [
          {
            url: 'https://example.org/a',
            text: 'Page A.',
          },
          {
            url: 'https://example.org/b',
            text: 'Page B.',
          },
        ],
      },
      error: {
        code: 'INVALID_RESPONSE',
        message: '提取响应条目数与输入 URL 数不符',
        details: {
          reason: 'result_count_mismatch',
        },
      },
    },
    markdown: `> 错误：[INVALID_RESPONSE] 提取响应条目数与输入 URL 数不符
> 原因：result_count_mismatch

来源：Tavily

## [https://example.org/a](https://example.org/a)

Page A.

## [https://example.org/b](https://example.org/b)

Page B.`,
  },
  {
    name: 'partial success across sources',
    renderer: 'search',
    result: {
      status: 'partial',
      data: {
        answer: {
          model: 'fixture-model',
          text: 'See the command reference.',
        },
        extra_sources: [
          {
            provider: 'exa',
            data: {
              results: [],
            },
          },
          {
            provider: 'firecrawl',
            data: {
              results: [
                {
                  url: 'https://example.org/docs',
                  title: 'Guide',
                  description: 'Command reference.',
                },
              ],
              warnings: ['Some sources were unavailable.'],
            },
          },
        ],
      },
      error: {
        code: 'PARTIAL_FAILURE',
        message: '模型搜索已完成，部分补充来源失败',
        details: {
          failures: [
            {
              provider: 'tavily',
              code: 'AUTHENTICATION_ERROR',
              message: 'Tavily 认证失败',
              details: {
                http_status: 401,
              },
            },
          ],
        },
      },
    },
    markdown: `> 部分完成：[PARTIAL_FAILURE] 模型搜索已完成，部分补充来源失败
> - tavily：[AUTHENTICATION_ERROR] Tavily 认证失败
>   - HTTP 状态：401

## 模型回答

模型：fixture-model

See the command reference.

## 补充检索

### Exa

未找到结果

### Firecrawl

上游提示：Some sources were unavailable.

#### 1. [Guide](https://example.org/docs)

Command reference.`,
  },
  {
    name: 'service fallback summary and content',
    renderer: 'retrieval',
    result: {
      status: 'success',
      data: {
        provider: 'firecrawl',
        results: [
          {
            url: 'https://example.org/docs',
            text: '# Guide\n\nCommand reference.',
          },
        ],
      },
      meta: {
        service_fallbacks: [
          {
            from: 'tavily',
            to: 'firecrawl',
            code: 'UPSTREAM_ERROR',
            message: '未取得网页正文',
          },
        ],
      },
    },
    markdown: `> 服务切换：tavily → firecrawl；[UPSTREAM_ERROR] 未取得网页正文

来源：Firecrawl · [https://example.org/docs](https://example.org/docs)

# Guide

Command reference.`,
  },
  {
    name: 'aggregated service failures',
    renderer: 'retrieval',
    result: {
      status: 'error',
      error: {
        code: 'ALL_PROVIDERS_FAILED',
        message: '网页读取失败',
        details: {
          failures: [
            {
              provider: 'tavily',
              code: 'AUTHENTICATION_ERROR',
              message: 'Tavily 认证失败',
              details: {
                http_status: 401,
              },
            },
            {
              provider: 'firecrawl',
              code: 'QUOTA_EXCEEDED',
              message: 'Firecrawl 额度已用尽',
              details: {
                http_status: 402,
              },
            },
          ],
        },
      },
    },
    markdown: ``,
    stderr: `错误：网页读取失败

tavily：Tavily 认证失败
  HTTP 状态：401
firecrawl：Firecrawl 额度已用尽
  HTTP 状态：402`,
  },
];
