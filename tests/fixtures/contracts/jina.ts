import type { ContractCase } from './types.js';

export const cases: ContractCase[] = [
  {
    name: 'single-page content and metadata',
    renderer: 'jina',
    result: {
      status: 'success',
      data: {
        provider: 'jina',
        results: [
          {
            url: 'https://example.org/guide',
            title: '安装指南',
            description: '命令行工具安装说明。',
            published_date: '2026-09-28T08:00:00Z',
            text: '# 安装\n\n运行 `npm install example-cli`。',
            metadata: {
              author: ['Example Team', 'Documentation Editors'],
              'og:locale': 'zh_CN',
            },
            external: {
              canonical: {
                'https://example.org/guide': {},
              },
              alternate: {
                'https://example.org/en/guide': {
                  hreflang: 'en',
                },
              },
            },
          },
        ],
      },
    },
    markdown: `来源：Jina · [安装指南](https://example.org/guide)

发布日期：2026-09-28T08:00:00Z

命令行工具安装说明。

# 安装

运行 \`npm install example-cli\`。

页面元数据：

| 字段 | 值 |
| --- | --- |
| author | \\["Example Team","Documentation Editors"\\] |
| og:locale | zh\\_CN |

外部关系：

| 关系 | 链接 | 属性 |
| --- | --- | --- |
| canonical | https://example.org/guide | {} |
| alternate | https://example.org/en/guide | {"hreflang":"en"} |`,
  },
  {
    name: 'document page count and upstream warnings',
    renderer: 'jina',
    result: {
      status: 'success',
      data: {
        provider: 'jina',
        results: [
          {
            url: 'https://example.org/manual.pdf',
            title: 'Manual',
            num_pages: 2,
            text: '# Manual\n\nStart here.',
            warnings: [
              'This is a cached snapshot of the original page, consider retry with caching opt-out.',
            ],
          },
        ],
      },
    },
    markdown: `来源：Jina · [Manual](https://example.org/manual.pdf)

文档页数：2

上游提示：This is a cached snapshot of the original page, consider retry with caching opt-out.

# Manual

Start here.`,
  },
  {
    name: 'web search',
    renderer: 'jina',
    result: {
      status: 'success',
      data: {
        provider: 'jina',
        search_type: 'web',
        results: [
          {
            url: 'https://example.org/release',
            title: 'Release notes',
            description: 'Changes in version 2.',
            text: '## Version 2\n\nAdds export support.',
            site_links: [
              {
                title: 'Downloads',
                url: 'https://example.org/downloads',
              },
            ],
          },
        ],
      },
    },
    markdown: `来源：Jina · 网页搜索

## 1. [Release notes](https://example.org/release)

Changes in version 2.

## Version 2

Adds export support.

站内链接：

- [Downloads](https://example.org/downloads)`,
  },
  {
    name: 'news search',
    renderer: 'jina',
    result: {
      status: 'success',
      data: {
        provider: 'jina',
        search_type: 'news',
        results: [
          {
            url: 'https://news.example.org/launch',
            title: 'New release announced',
            description: 'The team announced version 2.',
            source: 'Example News',
            date: '2 hours ago',
            published_date: '2026-10-01T06:00:00Z',
            text: 'The new release adds export support.',
          },
        ],
      },
    },
    markdown: `来源：Jina · 新闻搜索

## 1. [New release announced](https://news.example.org/launch)

发布日期：2026-10-01T06:00:00Z · 搜索时间标签：2 hours ago · 媒体来源：Example News

The team announced version 2.

The new release adds export support.`,
  },
  {
    name: 'image search',
    renderer: 'jina',
    result: {
      status: 'success',
      data: {
        provider: 'jina',
        search_type: 'images',
        results: [
          {
            url: 'https://example.org/diagram',
            title: 'Architecture diagram',
            image_url: 'https://cdn.example.org/architecture.png',
            image_width: 1600,
            image_height: 900,
            source: 'Example Docs',
            text: '# Architecture\n\nThe client calls the API.',
          },
        ],
      },
    },
    markdown: `来源：Jina · 图片搜索

## 1. [Architecture diagram](https://example.org/diagram)

媒体来源：Example Docs

图片：[architecture.png](https://cdn.example.org/architecture.png) · 1600 × 900

# Architecture

The client calls the API.`,
  },
  {
    name: 'successful empty search',
    renderer: 'jina',
    result: {
      status: 'success',
      data: {
        provider: 'jina',
        search_type: 'web',
        results: [],
      },
    },
    markdown: `来源：Jina · 网页搜索

未找到结果`,
  },
  {
    name: 'useful search entries with missing content',
    renderer: 'jina',
    result: {
      status: 'partial',
      data: {
        provider: 'jina',
        search_type: 'web',
        results: [
          {
            url: 'https://example.org/guide',
            title: 'Guide',
            text: '# Guide\n\nRead the installation steps.',
          },
          {
            url: 'https://example.org/reference',
            title: 'Reference',
            description: 'API reference.',
          },
        ],
      },
      error: {
        code: 'PARTIAL_FAILURE',
        message: 'Jina 搜索结果已取得，部分内容不可用',
        details: {
          failures: [
            {
              url: 'https://example.org/reference',
              code: 'CONTENT_UNAVAILABLE',
              message: 'Jina 未返回网页正文',
              details: {
                index: 1,
                reason: 'empty_content',
              },
            },
          ],
        },
      },
    },
    markdown: `> 部分完成：[PARTIAL_FAILURE] Jina 搜索结果已取得，部分内容不可用
> - https://example.org/reference：[CONTENT_UNAVAILABLE] Jina 未返回网页正文
>   - 原因：empty_content
>   - 结果索引：1

来源：Jina · 网页搜索

## 1. [Guide](https://example.org/guide)

# Guide

Read the installation steps.

---

2. [Reference](https://example.org/reference)

API reference.`,
  },
  {
    name: 'missing images with valid source pages',
    renderer: 'jina',
    result: {
      status: 'partial',
      data: {
        provider: 'jina',
        search_type: 'images',
        results: [
          {
            url: 'https://example.org/diagram',
            title: 'Architecture diagram',
            text: 'The client calls the API.',
          },
        ],
      },
      error: {
        code: 'PARTIAL_FAILURE',
        message: 'Jina 搜索结果已取得，部分内容不可用',
        details: {
          failures: [
            {
              url: 'https://example.org/diagram',
              code: 'CONTENT_UNAVAILABLE',
              message: 'Jina 未返回图片地址',
              details: {
                index: 0,
                reason: 'missing_image',
              },
            },
          ],
        },
      },
    },
    markdown: `> 部分完成：[PARTIAL_FAILURE] Jina 搜索结果已取得，部分内容不可用
> - https://example.org/diagram：[CONTENT_UNAVAILABLE] Jina 未返回图片地址
>   - 原因：missing_image
>   - 结果索引：0

来源：Jina · 图片搜索

## 1. [Architecture diagram](https://example.org/diagram)

The client calls the API.`,
  },
  {
    name: 'retained results remain identifiable after removing entries without sources',
    renderer: 'jina',
    result: {
      status: 'error',
      data: {
        provider: 'jina',
        search_type: 'web',
        results: [
          {
            url: 'https://example.org/reference',
            title: 'Reference',
          },
        ],
      },
      error: {
        code: 'INVALID_RESPONSE',
        message: 'Jina 响应包含无效数据',
        details: {
          provider: 'jina',
          http_status: 200,
          causes: [
            {
              code: 'INVALID_RESPONSE',
              message: 'Jina 条目缺少有效来源 URL',
              details: {
                upstream_index: 0,
              },
            },
          ],
          failures: [
            {
              url: 'https://example.org/reference',
              code: 'CONTENT_UNAVAILABLE',
              message: 'Jina 未返回网页正文',
              details: {
                index: 0,
                reason: 'empty_content',
              },
            },
          ],
        },
      },
    },
    markdown: `> 错误：[INVALID_RESPONSE] Jina 响应包含无效数据
> 服务：jina
> HTTP 状态：200
> - [INVALID_RESPONSE] Jina 条目缺少有效来源 URL
> - 上游条目索引：0
> - https://example.org/reference：[CONTENT_UNAVAILABLE] Jina 未返回网页正文
>   - 原因：empty_content
>   - 结果索引：0

来源：Jina · 网页搜索

1. [Reference](https://example.org/reference)`,
  },
  {
    name: 'page reading error retains returned content',
    renderer: 'jina',
    result: {
      status: 'error',
      data: {
        provider: 'jina',
        results: [
          {
            url: 'https://example.org/private',
            title: 'Access denied',
            text: 'Access denied. Please sign in.',
            warnings: ['Target URL returned error 403: Access denied by the origin server'],
          },
        ],
      },
      error: {
        code: 'CONTENT_UNAVAILABLE',
        message: 'Jina 报告目标页面读取失败',
        details: {
          provider: 'jina',
          url: 'https://example.org/private',
          http_status: 200,
          page_status: 403,
          reason: 'target_http_error',
        },
      },
    },
    markdown: `> 错误：[CONTENT_UNAVAILABLE] Jina 报告目标页面读取失败
> 服务：jina
> URL：https://example.org/private
> HTTP 状态：200
> 页面状态：403
> 原因：target_http_error

来源：Jina · [Access denied](https://example.org/private)

上游提示：Target URL returned error 403: Access denied by the origin server

Access denied. Please sign in.`,
  },
  {
    name: 'model failure with successful Jina supplement',
    renderer: 'search',
    result: {
      status: 'error',
      data: {
        extra_sources: [
          {
            provider: 'jina',
            data: {
              search_type: 'web',
              results: [
                {
                  url: 'https://example.org/release',
                  title: 'Release notes',
                  text: 'Version 2 adds export support.',
                },
              ],
            },
          },
        ],
      },
      error: {
        code: 'TIMEOUT',
        message: '模型搜索失败',
        details: {
          failures: [
            {
              provider: 'model',
              code: 'TIMEOUT',
              message: '本次调用的总执行时间已用尽',
              details: {
                model: 'example-model',
                timeout_scope: 'total',
              },
            },
          ],
        },
      },
    },
    markdown: `> 错误：[TIMEOUT] 模型搜索失败
> - model：[TIMEOUT] 本次调用的总执行时间已用尽
>   - 模型：example-model
>   - 超时范围：total

## 补充检索

### Jina

网页搜索

#### 1. [Release notes](https://example.org/release)

Version 2 adds export support.`,
  },
  {
    name: 'search results containing only content',
    renderer: 'jina',
    result: {
      status: 'success',
      data: {
        provider: 'jina',
        search_type: 'web',
        results: [
          {
            url: 'https://example.org/release',
            title: 'Release notes',
            text: 'Version 2 adds export support.',
          },
        ],
      },
    },
    markdown: `来源：Jina · 网页搜索

## 1. [Release notes](https://example.org/release)

Version 2 adds export support.`,
  },
];
