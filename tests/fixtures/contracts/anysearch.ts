import type { ContractCase } from './types.js';

export const cases: ContractCase[] = [
  {
    name: 'general search',
    renderer: 'anysearch-search',
    result: {
      status: 'success',
      data: {
        provider: 'anysearch',
        results: [
          {
            title: 'Go Release Notes',
            url: 'https://go.dev/doc/devel/release',
            snippet: 'Go release history.',
            content: '## Releases\n\nSee the [release history](https://go.dev/doc/devel/release).',
          },
        ],
      },
    },
    markdown: `来源：AnySearch

## 1. [Go Release Notes](https://go.dev/doc/devel/release)

**摘要**

Go release history.

**内容**

## Releases

See the [release history](https://go.dev/doc/devel/release).`,
  },
  {
    name: 'root domain catalog',
    renderer: 'anysearch-domains',
    result: {
      status: 'success',
      data: {
        provider: 'anysearch',
        catalog_source: 'bundled',
        domains: [
          'general',
          'resource',
          'social_media',
          'finance',
          'academic',
          'legal',
          'health',
          'business',
          'security',
          'ip',
          'code',
          'energy',
          'environment',
          'agriculture',
          'travel',
          'film',
          'gaming',
        ],
      },
    },
    markdown: `来源：AnySearch · 内置官方领域目录

- general
- resource
- social_media
- finance
- academic
- legal
- health
- business
- security
- ip
- code
- energy
- environment
- agriculture
- travel
- film
- gaming

使用 \`unisearch anysearch domains DOMAIN\` 查询当前下级领域及参数`,
  },
  {
    name: 'online subdomains',
    renderer: 'anysearch-domains',
    result: {
      status: 'success',
      data: {
        provider: 'anysearch',
        domains: [
          {
            domain: 'code',
            description: 'Developer documentation and code search',
            sub_domains: [
              {
                sub_domain: 'code.snippet',
                description: 'Search real code implementations',
                params: {
                  lang: {
                    description: 'Filter by programming language',
                    required: false,
                  },
                },
              },
            ],
          },
        ],
      },
    },
    markdown: `来源：AnySearch

## code

Developer documentation and code search

### code.snippet

Search real code implementations

- \`lang\`（可选）：Filter by programming language`,
  },
  {
    name: 'empty search results',
    renderer: 'anysearch-search',
    result: {
      status: 'success',
      data: {
        provider: 'anysearch',
        results: [],
      },
    },
    markdown: `来源：AnySearch

未找到结果`,
  },
  {
    name: 'empty domain list',
    renderer: 'anysearch-domains',
    result: {
      status: 'success',
      data: {
        provider: 'anysearch',
        domains: [],
      },
    },
    markdown: `来源：AnySearch

未找到领域定义`,
  },
  {
    name: 'empty subdomain list',
    renderer: 'anysearch-domains',
    result: {
      status: 'success',
      data: {
        provider: 'anysearch',
        domains: [
          {
            domain: 'code',
            sub_domains: [],
          },
        ],
      },
    },
    markdown: `来源：AnySearch

## code

未找到下级领域`,
  },
  {
    name: 'dedicated content extraction',
    renderer: 'anysearch-extract',
    result: {
      status: 'success',
      data: {
        provider: 'anysearch',
        url: 'https://example.org/guide',
        title: 'Guide',
        text: '# Guide\n\nRun the command.',
      },
    },
    markdown: `来源：AnySearch · [Guide](https://example.org/guide)

# Guide

Run the command.`,
  },
  {
    name: 'unified content retrieval',
    renderer: 'retrieval',
    result: {
      status: 'success',
      data: {
        provider: 'anysearch',
        results: [
          {
            url: 'https://example.org/guide',
            title: 'Guide',
            text: '# Guide\n\nRun the command.',
          },
        ],
      },
    },
    markdown: `来源：AnySearch · [Guide](https://example.org/guide)

# Guide

Run the command.`,
  },
  {
    name: 'sensitive HTTP 402 response',
    renderer: 'anysearch-search',
    result: {
      status: 'error',
      error: {
        code: 'QUOTA_EXCEEDED',
        message: 'AnySearch 额度已用尽；响应可能包含敏感凭证，详情未保留',
        details: {
          provider: 'anysearch',
          http_status: 402,
          request_id: '5a3f8c27-1e64-4b90-a752-6d9e2f41c083',
        },
      },
    },
    stderr: `错误: AnySearch 额度已用尽；响应可能包含敏感凭证，详情未保留
服务: anysearch
HTTP 状态: 402
请求 ID: 5a3f8c27-1e64-4b90-a752-6d9e2f41c083`,
  },
  {
    name: 'partial model and supplemental search',
    renderer: 'search',
    result: {
      status: 'partial',
      data: {
        answer: {
          model: 'fixture-model',
          text: 'See the release notes.',
        },
        extra_sources: [
          {
            provider: 'anysearch',
            data: {
              results: [
                {
                  url: 'https://go.dev/doc/devel/release',
                  title: 'Go Release Notes',
                  snippet: 'Go release history.',
                },
              ],
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
              provider: 'exa',
              code: 'AUTHENTICATION_ERROR',
              message: 'Exa 拒绝了本次凭证',
              details: {
                http_status: 401,
              },
            },
          ],
        },
      },
    },
    markdown: `> 部分完成: [PARTIAL_FAILURE] 模型搜索已完成，部分补充来源失败
> - exa: [AUTHENTICATION_ERROR] Exa 拒绝了本次凭证
> - HTTP 状态: 401

## 模型回答

模型：fixture-model

See the release notes.

## 补充检索

### AnySearch

#### 1. [Go Release Notes](https://go.dev/doc/devel/release)

Go release history.`,
  },
];
