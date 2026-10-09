import type { ContractCase } from './types.js';

export const cases: ContractCase[] = [
  {
    name: 'successful search and paper information',
    renderer: 'tinyfish-search',
    result: {
      status: 'success',
      data: {
        provider: 'tinyfish',
        page: 0,
        results: [
          {
            url: 'https://example.org/papers/retrieval',
            title: 'Retrieval Evaluation',
            snippet: 'An evaluation of retrieval methods.',
            site_name: 'example.org',
            position: 1,
            authors: ['Alex Chen', 'Sam Lee'],
            venue: 'Example Conference',
            year: 2025,
            cited_by_count: 0,
            pdf_url: 'https://example.org/papers/retrieval.pdf',
          },
        ],
      },
    },
    markdown: `来源：TinyFish · 页码：0

## 1. [Retrieval Evaluation](https://example.org/papers/retrieval)

站点：example.org

作者：Alex Chen、Sam Lee · 刊物：Example Conference · 年份：2025 · 被引次数：0

An evaluation of retrieval methods.

[PDF](https://example.org/papers/retrieval.pdf)`,
  },
  {
    name: 'valid empty search',
    renderer: 'tinyfish-search',
    result: {
      status: 'success',
      data: {
        provider: 'tinyfish',
        page: 2,
        results: [],
      },
    },
    markdown: `来源：TinyFish · 页码：2

未找到结果`,
  },
  {
    name: 'successful single-page reading with additional data',
    renderer: 'tinyfish-fetch',
    result: {
      status: 'success',
      data: {
        provider: 'tinyfish',
        results: [
          {
            url: 'https://example.org/guide',
            final_url: 'https://example.org/docs/guide',
            title: 'Example Guide',
            description: 'Installation and usage.',
            language: 'en',
            author: 'Alex Chen',
            published_date: '2026-09-20',
            text: '# Guide\n\nRun `example --help`.\n\n```sh\nexample init\n```',
            links: ['https://example.org/docs/api'],
            image_links: ['https://example.org/images/diagram.png'],
            page_metadata: {
              canonical: 'https://example.org/docs/guide',
              og: {
                image: ['https://example.org/images/cover.png'],
              },
            },
            unmatched_selectors: ['aside.related'],
          },
        ],
      },
    },
    markdown: `来源：TinyFish · [Example Guide](https://example.org/guide)

最终 URL：https://example.org/docs/guide

发布日期：2026-09-20 · 作者：Alex Chen · 语言：en

Installation and usage.

未匹配的选择器：\`aside.related\`

# Guide

Run \`example --help\`.

\`\`\`sh
example init
\`\`\`

### 页面链接

- [https://example.org/docs/api](https://example.org/docs/api)

### 图片链接

- [https://example.org/images/diagram.png](https://example.org/images/diagram.png)

### 页面元数据

\`\`\`json
{
  "canonical": "https://example.org/docs/guide",
  "og": {
    "image": [
      "https://example.org/images/cover.png"
    ]
  }
}
\`\`\``,
  },
  {
    name: 'successful content with missing additional links',
    renderer: 'tinyfish-fetch',
    result: {
      status: 'success',
      data: {
        provider: 'tinyfish',
        results: [
          {
            url: 'https://example.org/guide',
            text: 'Complete body.',
            missing_content: ['links'],
          },
        ],
      },
    },
    markdown: `来源：TinyFish · [https://example.org/guide](https://example.org/guide)

未返回附带内容：页面链接

Complete body.`,
  },
  {
    name: 'valid selector matches no content on a page',
    renderer: 'tinyfish-fetch',
    result: {
      status: 'partial',
      data: {
        provider: 'tinyfish',
        results: [
          {
            url: 'https://example.org/a',
            text: 'Page A article.',
          },
        ],
      },
      error: {
        code: 'PARTIAL_FAILURE',
        message: '部分网页读取失败',
        details: {
          failures: [
            {
              url: 'https://example.org/b',
              code: 'CONTENT_UNAVAILABLE',
              message: '页面未匹配任何目标选择器',
              details: {
                upstream_code: 'selector_not_matched',
                unmatched_selectors: ['article'],
                candidate_selectors: ['main', '#content'],
              },
            },
          ],
        },
      },
    },
    markdown: `> 部分完成: [PARTIAL_FAILURE] 部分网页读取失败
> - https://example.org/b: [CONTENT_UNAVAILABLE] 页面未匹配任何目标选择器
> - 上游代码: selector_not_matched
> - 未匹配的选择器: \`article\`
> - 候选选择器: \`main\`、\`#content\`

来源：TinyFish · [https://example.org/a](https://example.org/a)

Page A article.`,
  },
  {
    name: 'upstream identifies a challenge page',
    renderer: 'tinyfish-fetch',
    result: {
      status: 'error',
      error: {
        code: 'CONTENT_UNAVAILABLE',
        message: '目标页面触发了反机器人验证',
        details: {
          provider: 'tinyfish',
          url: 'https://example.org/blocked',
          upstream_code: 'bot_blocked',
          request_id: 'tf-blocked-fixture',
        },
      },
    },
    stderr: `错误: 目标页面触发了反机器人验证
服务: tinyfish
URL: https://example.org/blocked
上游代码: bot_blocked
请求 ID: tf-blocked-fixture`,
  },
  {
    name: 'all batch entries succeed',
    renderer: 'tinyfish-fetch',
    result: {
      status: 'success',
      data: {
        provider: 'tinyfish',
        results: [
          {
            url: 'https://example.org/a',
            title: 'Guide A',
            text: 'Complete page A.',
          },
          {
            url: 'https://example.org/b',
            title: 'Guide B',
            text: 'Complete page B.',
          },
        ],
      },
    },
    markdown: `来源：TinyFish

## [Guide A](https://example.org/a)

Complete page A.

## [Guide B](https://example.org/b)

Complete page B.`,
  },
  {
    name: 'partial batch success',
    renderer: 'tinyfish-fetch',
    result: {
      status: 'partial',
      data: {
        provider: 'tinyfish',
        results: [
          {
            url: 'https://example.org/a',
            title: 'Guide A',
            text: 'Complete page A.',
          },
        ],
      },
      error: {
        code: 'PARTIAL_FAILURE',
        message: '部分网页读取失败',
        details: {
          request_id: 'tf-batch-fixture',
          failures: [
            {
              url: 'https://example.org/missing',
              code: 'CONTENT_UNAVAILABLE',
              message: '目标页面不存在',
              details: {
                upstream_code: 'page_not_found',
                page_status: 404,
              },
            },
            {
              url: 'https://example.org/slow',
              code: 'CONTENT_UNAVAILABLE',
              message: '页面读取超时',
              details: {
                upstream_code: 'timeout',
              },
            },
          ],
        },
      },
    },
    markdown: `> 部分完成: [PARTIAL_FAILURE] 部分网页读取失败
> 请求 ID: tf-batch-fixture
> - https://example.org/missing: [CONTENT_UNAVAILABLE] 目标页面不存在
> - 页面状态: 404
> - 上游代码: page_not_found
> - https://example.org/slow: [CONTENT_UNAVAILABLE] 页面读取超时
> - 上游代码: timeout

来源：TinyFish · [Guide A](https://example.org/a)

Complete page A.`,
  },
  {
    name: 'all batch entries fail',
    renderer: 'tinyfish-fetch',
    result: {
      status: 'error',
      error: {
        code: 'CONTENT_UNAVAILABLE',
        message: '所有网页读取均失败',
        details: {
          provider: 'tinyfish',
          failures: [
            {
              url: 'https://example.org/missing',
              code: 'CONTENT_UNAVAILABLE',
              message: '目标页面不存在',
              details: {
                upstream_code: 'page_not_found',
                page_status: 404,
              },
            },
            {
              url: 'https://example.org/slow',
              code: 'CONTENT_UNAVAILABLE',
              message: '页面读取超时',
              details: {
                upstream_code: 'timeout',
              },
            },
          ],
        },
      },
    },
    stderr: `错误: 所有网页读取均失败
服务: tinyfish
  https://example.org/missing: 目标页面不存在
  页面状态: 404
  上游代码: page_not_found
  https://example.org/slow: 页面读取超时
  上游代码: timeout`,
  },
  {
    name: 'invalid metadata retains content',
    renderer: 'tinyfish-fetch',
    result: {
      status: 'error',
      data: {
        provider: 'tinyfish',
        results: [
          {
            url: 'https://example.org/guide',
            text: '# Guide\n\nComplete body.',
          },
        ],
      },
      error: {
        code: 'INVALID_RESPONSE',
        message: '服务响应格式无效',
        details: {
          field: 'results[0].title',
        },
      },
    },
    markdown: `> 错误: [INVALID_RESPONSE] 服务响应格式无效
> 响应字段: results[0].title

来源：TinyFish · [https://example.org/guide](https://example.org/guide)

# Guide

Complete body.`,
  },
  {
    name: 'model and TinyFish success',
    renderer: 'search',
    result: {
      status: 'success',
      data: {
        answer: {
          model: 'example-model',
          text: 'Use the command reference.',
        },
        extra_sources: [
          {
            provider: 'tinyfish',
            data: {
              page: 0,
              results: [
                {
                  url: 'https://example.org/reference',
                  title: 'Command Reference',
                  site_name: 'example.org',
                  position: 1,
                  snippet: 'Arguments and options for each command.',
                },
              ],
            },
          },
        ],
      },
    },
    markdown: `## 模型回答

模型：example-model

Use the command reference.

## 补充检索

### TinyFish

页码：0

#### 1. [Command Reference](https://example.org/reference)

站点：example.org

Arguments and options for each command.`,
  },
  {
    name: 'verbose output retains service timings',
    renderer: 'tinyfish-fetch',
    result: {
      status: 'success',
      data: {
        provider: 'tinyfish',
        results: [
          {
            url: 'https://example.org/guide',
            text: 'Complete body.',
          },
        ],
      },
      meta: {
        elapsed_ms: 25,
        attempts: [
          {
            duration_ms: 25,
            http_status: 200,
            request_id: 'tf-success-fixture',
            page_latencies: [
              {
                url: 'https://example.org/guide',
                latency_ms: 18,
              },
            ],
          },
        ],
      },
    },
    markdown: `来源：TinyFish · [https://example.org/guide](https://example.org/guide)

Complete body.`,
    details: `执行耗时：25 ms
尝试 1：HTTP 200，25 ms，成功，请求 ID tf-success-fixture
  页面读取耗时：https://example.org/guide · 18 ms`,
  },
];
