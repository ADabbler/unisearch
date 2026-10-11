import type { ContractCase } from './types.js';

export const cases: ContractCase[] = [
  {
    name: 'model success without structured sources',
    renderer: 'search',
    result: {
      status: 'success',
      data: {
        answer: {
          model: 'search-primary',
          text: '当前端点未提供实时搜索能力。',
        },
      },
    },
    markdown: `模型：search-primary

当前端点未提供实时搜索能力。`,
  },
  {
    name: 'model and Exa success',
    renderer: 'search',
    result: {
      status: 'success',
      data: {
        answer: {
          model: 'grok-4.7',
          text: '示例文档介绍了命令用法。[文档](https://example.org/docs)',
          sources: [
            {
              url: 'https://example.org/docs',
              title: '示例文档',
            },
          ],
        },
        extra_sources: [
          {
            provider: 'exa',
            data: {
              results: [
                {
                  title: '示例文档',
                  url: 'https://example.org/docs',
                },
              ],
            },
          },
        ],
      },
    },
    markdown: `## 模型回答

模型：grok-4.7

示例文档介绍了命令用法。[文档](https://example.org/docs)

### 模型提供的来源

- [示例文档](https://example.org/docs)

## 补充检索

### Exa

1. [示例文档](https://example.org/docs)`,
  },
  {
    name: 'model success with Exa timeout',
    renderer: 'search',
    result: {
      status: 'partial',
      data: {
        answer: {
          model: 'grok-4.7',
          text: '模型已完成回答。',
        },
      },
      error: {
        code: 'PARTIAL_FAILURE',
        message: '模型搜索已完成，部分补充来源失败',
        details: {
          failures: [
            {
              provider: 'exa',
              code: 'TIMEOUT',
              message: '本次调用的总执行时间已用尽',
              details: {
                timeout_scope: 'total',
              },
            },
          ],
        },
      },
    },
    markdown: `> 部分完成: [PARTIAL_FAILURE] 模型搜索已完成，部分补充来源失败
> - exa: [TIMEOUT] 本次调用的总执行时间已用尽
> - 超时范围: total

模型：grok-4.7

模型已完成回答。`,
  },
  {
    name: 'model failure with successful empty Exa results',
    renderer: 'search',
    result: {
      status: 'error',
      data: {
        extra_sources: [
          {
            provider: 'exa',
            data: {
              results: [],
            },
          },
        ],
      },
      error: {
        code: 'AUTHENTICATION_ERROR',
        message: '模型搜索失败',
        details: {
          failures: [
            {
              provider: 'model',
              code: 'AUTHENTICATION_ERROR',
              message: '模型服务拒绝了本次凭证',
              details: {
                model: 'grok-4.7',
                http_status: 401,
              },
            },
          ],
        },
      },
    },
    markdown: `> 错误: [AUTHENTICATION_ERROR] 模型搜索失败
> - model: [AUTHENTICATION_ERROR] 模型服务拒绝了本次凭证
> - 模型: grok-4.7
> - HTTP 状态: 401

## 补充检索

### Exa

未找到结果`,
  },
  {
    name: 'all sources fail',
    renderer: 'search',
    result: {
      status: 'error',
      error: {
        code: 'INVALID_RESPONSE',
        message: '模型搜索失败',
        details: {
          failures: [
            {
              provider: 'model',
              code: 'INVALID_RESPONSE',
              message: '模型响应没有完整正文',
              details: {
                model: 'grok-4.7',
                http_status: 200,
              },
            },
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
    stderr: `错误: 模型搜索失败
  model: 模型响应没有完整正文
  模型: grok-4.7
  HTTP 状态: 200
  exa: Exa 拒绝了本次凭证
  HTTP 状态: 401`,
  },
  {
    name: 'fallback summary with multiple source results',
    renderer: 'search',
    result: {
      status: 'success',
      data: {
        answer: {
          model: 'search-backup',
          text: '备用模型已完成回答。',
        },
        extra_sources: [
          {
            provider: 'exa',
            data: {
              results: [],
            },
          },
        ],
      },
      meta: {
        model_fallbacks: [
          {
            from: 'search-primary',
            to: 'search-backup',
            code: 'MODEL_UNAVAILABLE',
            message: '指定模型不可用',
          },
        ],
        elapsed_ms: 200,
        attempts: [
          {
            provider: 'model',
            model: 'search-primary',
            duration_ms: 50,
            http_status: 404,
            code: 'MODEL_UNAVAILABLE',
          },
          {
            provider: 'exa',
            duration_ms: 150,
            http_status: 200,
          },
          {
            provider: 'model',
            model: 'search-backup',
            duration_ms: 150,
            http_status: 200,
          },
        ],
      },
    },
    markdown: `> 模型回退：search-primary → search-backup；[MODEL_UNAVAILABLE] 指定模型不可用

## 模型回答

模型：search-backup

备用模型已完成回答。

## 补充检索

### Exa

未找到结果`,
  },
  {
    name: 'same model ID fallback with different effort',
    renderer: 'search',
    result: {
      status: 'success',
      data: {
        answer: {
          model: 'grok-4.7',
          text: '本次候选已完成回答。',
        },
      },
      meta: {
        model_fallbacks: [
          {
            from: 'grok-4.7(high)',
            to: 'grok-4.7(low)',
            code: 'INVALID_RESPONSE',
            message: '模型响应没有完整正文',
          },
        ],
      },
    },
    markdown: `> 模型回退：grok-4.7(high) → grok-4.7(low)；[INVALID_RESPONSE] 模型响应没有完整正文

模型：grok-4.7

本次候选已完成回答。`,
  },
  {
    name: 'user cancellation retains completed supplements',
    renderer: 'search',
    result: {
      status: 'error',
      data: {
        extra_sources: [
          {
            provider: 'exa',
            data: {
              results: [],
            },
          },
        ],
      },
      error: {
        code: 'CANCELLED',
        message: '操作已取消',
      },
    },
    markdown: `> 错误: [CANCELLED] 操作已取消

## 补充检索

### Exa

未找到结果`,
  },
];
