import type { ContractCase } from './types.js';

export const cases: ContractCase[] = [
  {
    name: 'search intent and results',
    renderer: 'zhipu',
    result: {
      status: 'success',
      data: {
        provider: 'zhipu',
        search_engine: 'search_pro',
        search_intent: [
          {
            keywords: '新能源汽车 政策',
          },
        ],
        results: [
          {
            url: 'https://example.org/policy',
            title: '政策解读',
            description: '购置支持说明。\n\n[政策全文](https://example.org/full)',
            source: '示例政策网',
            published_date: '2026-09-30',
            refer: 'ref_1',
          },
        ],
      },
    },
    markdown: `来源：智谱 · 引擎：\`search_pro\`

搜索关键词：新能源汽车 政策

## 1. [政策解读](https://example.org/policy)

网站：示例政策网 · 发布日期：2026-09-30 · 引用：\`ref_1\`

购置支持说明。

[政策全文](https://example.org/full)`,
  },
  {
    name: 'model success with partial Zhipu failure retains usable evidence',
    renderer: 'search',
    result: {
      status: 'partial',
      data: {
        answer: {
          model: 'fixture-model',
          text: '请核对政策原文。',
        },
        extra_sources: [
          {
            provider: 'zhipu',
            data: {
              search_engine: 'search_std',
              results: [
                {
                  url: 'https://example.org/policy',
                  title: '政策原文',
                  refer: 'ref_1',
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
              provider: 'zhipu',
              code: 'INVALID_RESPONSE',
              message: '智谱响应包含无效字段，已保留可用数据',
              details: {
                http_status: 200,
                field: 'search_result[1].link',
              },
            },
          ],
        },
      },
    },
    markdown: `> 部分完成：[PARTIAL_FAILURE] 模型搜索已完成，部分补充来源失败
> - zhipu：[INVALID_RESPONSE] 智谱响应包含无效字段，已保留可用数据
>   - 响应字段：search_result[1].link
>   - HTTP 状态：200

## 模型回答

模型：fixture-model

请核对政策原文。

## 补充检索

### 智谱

引擎：\`search_std\`

1. [政策原文](https://example.org/policy)

引用：\`ref_1\``,
  },
  {
    name: 'content and metadata',
    renderer: 'zhipu',
    result: {
      status: 'success',
      data: {
        provider: 'zhipu',
        results: [
          {
            url: 'https://example.org/guide',
            title: '示例指南',
            description: '命令行使用说明。',
            text: '# 指南\n\n~~~sh\nunisearch --help\n~~~\n\n[更多说明](https://example.org/details)',
            metadata: {
              keywords: 'CLI,guide',
              author: 'Example Author',
            },
            external: {
              alternate: {
                'https://example.org/guide.pdf': {
                  type: 'application/pdf',
                },
              },
            },
          },
        ],
      },
    },
    markdown: `来源：智谱 · [示例指南](https://example.org/guide)

命令行使用说明。

# 指南

~~~sh
unisearch --help
~~~

[更多说明](https://example.org/details)

页面元数据：

| 字段 | 值 |
| --- | --- |
| keywords | CLI,guide |
| author | Example Author |

外部关系：

| 关系 | 链接 | 属性 |
| --- | --- | --- |
| alternate | https://example.org/guide.pdf | {"type":"application/pdf"} |`,
  },
  {
    name: 'missing content retains page title and links',
    renderer: 'zhipu',
    result: {
      status: 'error',
      data: {
        provider: 'zhipu',
        results: [
          {
            url: 'https://example.org/guide',
            title: '示例指南',
          },
        ],
      },
      error: {
        code: 'CONTENT_UNAVAILABLE',
        message: '智谱未返回网页正文',
        details: {
          provider: 'zhipu',
          http_status: 200,
          reason: 'empty_content',
        },
      },
    },
    markdown: `> 错误：[CONTENT_UNAVAILABLE] 智谱未返回网页正文
> 服务：zhipu
> HTTP 状态：200
> 原因：empty_content

来源：智谱 · [示例指南](https://example.org/guide)`,
  },
];
