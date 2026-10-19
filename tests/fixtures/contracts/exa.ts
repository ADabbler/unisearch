import type { ContractCase } from './types.js';

export const cases: ContractCase[] = [
  {
    name: 'single-page content and highlights',
    renderer: 'exa-fetch',
    result: {
      status: 'success',
      data: {
        provider: 'exa',
        results: [
          {
            url: 'https://example.org/guide',
            title: 'Example guide',
            published_date: '2026-09-01',
            author: 'Example team',
            text: '# Getting started\n\nRead the [reference](https://example.org/api).\n\n```sh\nexample --help\n```',
            highlights: ['The guide describes installation and first use.'],
          },
        ],
        content_sources: [
          {
            url: 'https://example.org/guide',
            source: 'cached',
          },
        ],
      },
    },
    markdown: `来源：Exa

获取方式：[https://example.org/guide](https://example.org/guide) · cached

## 1. [Example guide](https://example.org/guide)

发布日期：2026-09-01 · 作者：Example team

### 摘录

The guide describes installation and first use.

### 正文

# Getting started

Read the [reference](https://example.org/api).

\`\`\`sh
example --help
\`\`\``,
  },
  {
    name: 'successful content with missing highlights',
    renderer: 'exa-fetch',
    result: {
      status: 'success',
      data: {
        provider: 'exa',
        results: [
          {
            url: 'https://example.org/guide',
            title: 'Example guide',
            text: 'Installation instructions.',
            missing_content: ['highlights'],
          },
        ],
      },
    },
    markdown: `来源：Exa

## 1. [Example guide](https://example.org/guide)

未取得请求的附带内容：摘录

### 正文

Installation instructions.`,
  },
  {
    name: 'missing content retains highlights',
    renderer: 'exa-fetch',
    result: {
      status: 'error',
      data: {
        provider: 'exa',
        results: [
          {
            url: 'https://example.org/guide',
            title: 'Example guide',
            highlights: ['Installation requires the example package.'],
          },
        ],
      },
      error: {
        code: 'CONTENT_UNAVAILABLE',
        message: 'Exa 未取得网页正文',
        details: {
          url: 'https://example.org/guide',
          reason: 'empty_content',
        },
      },
    },
    markdown: `> 错误：[CONTENT_UNAVAILABLE] Exa 未取得网页正文
> URL：https://example.org/guide
> 原因：empty_content

来源：Exa

## 1. [Example guide](https://example.org/guide)

### 摘录

Installation requires the example package.`,
  },
  {
    name: 'partial batch success',
    renderer: 'exa-fetch',
    result: {
      status: 'partial',
      data: {
        provider: 'exa',
        results: [
          {
            url: 'https://example.org/a',
            title: 'Guide A',
            text: 'Content A.',
          },
        ],
        content_sources: [
          {
            url: 'https://example.org/a',
            source: 'crawled',
          },
        ],
      },
      error: {
        code: 'PARTIAL_FAILURE',
        message: '部分网页读取失败',
        details: {
          request_id: 'exa-fixture-batch',
          failures: [
            {
              url: 'https://example.org/private',
              code: 'CONTENT_UNAVAILABLE',
              message: 'Exa 无法读取目标网页',
              details: {
                page_status: 403,
                upstream_code: 'CRAWL_HTTP_403',
              },
            },
          ],
        },
      },
    },
    markdown: `> 部分完成：[PARTIAL_FAILURE] 部分网页读取失败
> 请求 ID：exa-fixture-batch
> - https://example.org/private：[CONTENT_UNAVAILABLE] Exa 无法读取目标网页
>   - 页面状态：403
>   - 上游代码：CRAWL_HTTP_403

来源：Exa

获取方式：[https://example.org/a](https://example.org/a) · crawled

## 1. [Guide A](https://example.org/a)

### 正文

Content A.`,
  },
  {
    name: 'all batch entries fail',
    renderer: 'exa-fetch',
    result: {
      status: 'error',
      error: {
        code: 'CONTENT_UNAVAILABLE',
        message: '所有网页读取均失败',
        details: {
          provider: 'exa',
          failures: [
            {
              url: 'https://example.org/a',
              code: 'CONTENT_UNAVAILABLE',
              message: 'Exa 无法读取目标网页',
              details: {
                upstream_code: 'CRAWL_TIMEOUT',
              },
            },
            {
              url: 'https://example.org/b',
              code: 'CONTENT_UNAVAILABLE',
              message: 'Exa 无法读取目标网页',
            },
          ],
        },
      },
    },
    markdown: ``,
    stderr: `错误：所有网页读取均失败
服务：exa

https://example.org/a：Exa 无法读取目标网页
  上游代码：CRAWL_TIMEOUT
https://example.org/b：Exa 无法读取目标网页`,
  },
  {
    name: 'batch count mismatch retains data',
    renderer: 'exa-fetch',
    result: {
      status: 'error',
      data: {
        provider: 'exa',
        results: [
          {
            url: 'https://example.org/a',
            title: 'Guide A',
            text: 'Content A.',
          },
        ],
      },
      error: {
        code: 'INVALID_RESPONSE',
        message: 'Exa 返回的结果数量与请求不符',
        details: {
          reason: 'result_count_mismatch',
        },
      },
    },
    markdown: `> 错误：[INVALID_RESPONSE] Exa 返回的结果数量与请求不符
> 原因：result_count_mismatch

来源：Exa

## 1. [Guide A](https://example.org/a)

### 正文

Content A.`,
  },
  {
    name: 'cancellation during fallback retains earlier content',
    renderer: 'retrieval',
    result: {
      status: 'error',
      data: {
        provider: 'exa',
        results: [
          {
            url: 'https://example.org/guide',
            title: 'Guide',
            text: 'Guide content.',
          },
          {
            url: 'https://example.org/extra',
            title: 'Extra',
            text: 'Extra content.',
          },
        ],
      },
      error: {
        code: 'CANCELLED',
        message: '操作已取消',
        details: {
          failures: [
            {
              provider: 'exa',
              code: 'INVALID_RESPONSE',
              message: 'Exa 返回的结果数量与请求不符',
              details: {
                reason: 'result_count_mismatch',
              },
            },
            {
              provider: 'tavily',
              code: 'CANCELLED',
              message: '操作已取消',
            },
          ],
        },
      },
    },
    markdown: `> 错误：[CANCELLED] 操作已取消
> 
> - exa：[INVALID_RESPONSE] Exa 返回的结果数量与请求不符
>   - 原因：result_count_mismatch
> - tavily：[CANCELLED] 操作已取消

来源：Exa

## [Guide](https://example.org/guide)

Guide content.

## [Extra](https://example.org/extra)

Extra content.`,
  },
];
