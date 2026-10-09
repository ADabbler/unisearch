import type { ContractCase } from './types.js';

export const cases: ContractCase[] = [
  {
    name: 'successful search',
    renderer: 'tavily-search',
    result: {
      status: 'success',
      data: {
        provider: 'tavily',
        results: [
          {
            url: 'https://example.com/releases',
            title: 'Release policy',
            content: 'The policy lists the supported releases.',
            published_date: 'Tue, 01 Sep 2026 00:00:00 GMT',
            score: 0.81025416,
            text: '# Release policy\n\nSee the [support policy](https://example.com/support).',
          },
        ],
      },
    },
    markdown: `来源：Tavily

## 1. [Release policy](https://example.com/releases)

发布或更新日期：Tue, 01 Sep 2026 00:00:00 GMT · 相关性评分：0.81025416

### 摘要或片段

The policy lists the supported releases.

### 正文

# Release policy

See the [support policy](https://example.com/support).`,
  },
  {
    name: 'empty search results',
    renderer: 'tavily-search',
    result: {
      status: 'success',
      data: {
        provider: 'tavily',
        results: [],
      },
    },
    markdown: `来源：Tavily

未找到结果`,
  },
  {
    name: 'successful batch content extraction',
    renderer: 'tavily-extract',
    result: {
      status: 'success',
      data: {
        provider: 'tavily',
        content_type: 'page',
        results: [
          {
            url: 'https://example.com/a',
            text: '# A\n\nArticle A.',
          },
          {
            url: 'https://example.com/b',
            text: '# B\n\nArticle B.',
          },
        ],
      },
    },
    markdown: `来源：Tavily

## [https://example.com/a](https://example.com/a)

# A

Article A.

---

## [https://example.com/b](https://example.com/b)

# B

Article B.`,
  },
  {
    name: 'successful relevant snippets',
    renderer: 'tavily-extract',
    result: {
      status: 'success',
      data: {
        provider: 'tavily',
        content_type: 'snippets',
        results: [
          {
            url: 'https://example.com/a',
            text: 'Supported releases receive updates. [...] See the release schedule.',
          },
        ],
      },
    },
    markdown: `来源：Tavily · 相关片段

## [https://example.com/a](https://example.com/a)

Supported releases receive updates. [...] See the release schedule.`,
  },
  {
    name: 'partial extraction failure',
    renderer: 'tavily-extract',
    result: {
      status: 'partial',
      data: {
        provider: 'tavily',
        content_type: 'page',
        results: [
          {
            url: 'https://example.com/a',
            text: '# A\n\nArticle A.',
          },
        ],
      },
      error: {
        code: 'PARTIAL_FAILURE',
        message: '部分网页提取失败',
        details: {
          request_id: 'extract-example-1',
          failures: [
            {
              url: 'https://example.com/b',
              code: 'UPSTREAM_ERROR',
              message: '网页提取失败',
              details: {
                reason: 'extraction_failed',
                upstream_message: 'Failed to retrieve content',
              },
            },
          ],
        },
      },
    },
    markdown: `> 部分完成: [PARTIAL_FAILURE] 部分网页提取失败
> 请求 ID: extract-example-1
> - https://example.com/b: [UPSTREAM_ERROR] 网页提取失败
> - 上游消息: Failed to retrieve content
> - 原因: extraction_failed

来源：Tavily

## [https://example.com/a](https://example.com/a)

# A

Article A.`,
  },
  {
    name: 'empty content for one URL',
    renderer: 'tavily-extract',
    result: {
      status: 'error',
      error: {
        code: 'UPSTREAM_ERROR',
        message: '未取得网页正文',
        details: {
          provider: 'tavily',
          url: 'https://example.com/empty',
          reason: 'empty_content',
        },
      },
    },
    stderr: `错误: 未取得网页正文
服务: tavily
URL: https://example.com/empty
原因: empty_content`,
  },
  {
    name: 'all batch entries fail',
    renderer: 'tavily-extract',
    result: {
      status: 'error',
      error: {
        code: 'UPSTREAM_ERROR',
        message: '网页提取失败',
        details: {
          provider: 'tavily',
          failures: [
            {
              url: 'https://example.com/a',
              code: 'UPSTREAM_ERROR',
              message: '未取得网页正文',
              details: {
                reason: 'empty_content',
              },
            },
            {
              url: 'https://example.com/b',
              code: 'UPSTREAM_ERROR',
              message: '网页提取失败',
              details: {
                reason: 'extraction_failed',
                upstream_message: 'Failed to retrieve content',
              },
            },
          ],
        },
      },
    },
    stderr: `错误: 网页提取失败
服务: tavily
  https://example.com/a: 未取得网页正文
  原因: empty_content
  https://example.com/b: 网页提取失败
  上游消息: Failed to retrieve content
  原因: extraction_failed`,
  },
  {
    name: 'successful site mapping',
    renderer: 'tavily-map',
    result: {
      status: 'success',
      data: {
        provider: 'tavily',
        results: ['https://example.com/docs', 'https://example.com/api'],
      },
    },
    markdown: `来源：Tavily

- [https://example.com/docs](https://example.com/docs)
- [https://example.com/api](https://example.com/api)`,
  },
  {
    name: 'empty site mapping',
    renderer: 'tavily-map',
    result: {
      status: 'success',
      data: {
        provider: 'tavily',
        results: [],
      },
    },
    markdown: `来源：Tavily

未发现站点链接`,
  },
  {
    name: 'multiple source success preserves Tavily then Exa order',
    renderer: 'search',
    result: {
      status: 'success',
      data: {
        answer: {
          model: 'fixture-model',
          text: 'See the [release policy](https://example.com/releases).',
        },
        extra_sources: [
          {
            provider: 'tavily',
            data: {
              results: [
                {
                  url: 'https://example.com/releases',
                  title: 'Release policy',
                  content: 'The policy lists supported releases.',
                  score: 0.81025416,
                },
              ],
            },
          },
          {
            provider: 'exa',
            data: {
              results: [],
            },
          },
        ],
      },
    },
    markdown: `## 模型回答

模型：fixture-model

See the [release policy](https://example.com/releases).

## 补充检索

### Tavily

#### 1. [Release policy](https://example.com/releases)

相关性评分：0.81025416

##### 摘要或片段

The policy lists supported releases.

### Exa

未找到结果`,
  },
  {
    name: 'quota exhausted',
    renderer: 'tavily-map',
    result: {
      status: 'error',
      error: {
        code: 'QUOTA_EXCEEDED',
        message: 'Tavily 额度已用尽或达到使用上限',
        details: {
          provider: 'tavily',
          http_status: 433,
          upstream_message: 'This request exceeds the pay-as-you-go limit.',
        },
      },
    },
    stderr: `错误: Tavily 额度已用尽或达到使用上限
服务: tavily
HTTP 状态: 433
上游消息: This request exceeds the pay-as-you-go limit.`,
  },
];
