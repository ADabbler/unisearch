import type { ContractCase } from './types.js';

export const cases: ContractCase[] = [
  {
    name: 'library candidates and access filtering',
    renderer: 'context7',
    result: {
      status: 'success',
      data: {
        provider: 'ctx7',
        results: [
          {
            id: '/example/ui',
            title: 'Example UI',
            description: 'Components for example applications.',
            versions: ['v1.2.0', 'v1.1.0'],
            total_snippets: 42,
            trust_score: 9,
            benchmark_score: 88.5,
            state: 'finalized',
          },
          {
            id: '/websites/example-ui',
            title: 'Example UI Guide',
            description: 'Website documentation.',
          },
        ],
        search_filter_applied: true,
      },
    },
    markdown: `来源：Context7

候选库已按团队访问规则筛选

## 1. Example UI

库 ID：\`/example/ui\`

Components for example applications.

可用版本：\`v1.2.0\`、\`v1.1.0\`

代码片段：42 · 来源评分：9 · 质量评分：88.5 · 索引状态：finalized

## 2. Example UI Guide

库 ID：\`/websites/example-ui\`

Website documentation.`,
  },
  {
    name: 'code, documentation and upstream rules',
    renderer: 'context7',
    result: {
      status: 'success',
      data: {
        provider: 'ctx7',
        library_id: '/example/ui/v1.2.0',
        code_snippets: [
          {
            title: 'Create a button',
            description: 'Create a button with a visible label.',
            url: 'https://example.org/ui/button#example',
            examples: [
              {
                language: 'typescript',
                code: "const button = createButton({ label: 'Save' });\nbutton.mount();",
              },
              {
                language: 'javascript',
                code: "createButton({ label: 'Save' }).mount();",
              },
            ],
          },
        ],
        info_snippets: [
          {
            url: 'https://example.org/ui/button',
            breadcrumb: 'Components > Button',
            content: 'Use a **visible label**. See the [guide](https://example.org/ui/guide).',
          },
        ],
        rules: {
          library_own: ['Examples use the public component API.'],
        },
      },
    },
    markdown: `来源：Context7 · 库：\`/example/ui/v1.2.0\`

## 上游规则

### 库作者

Examples use the public component API.

## 代码与用法

### Create a button

来源：[https://example.org/ui/button#example](https://example.org/ui/button#example)

Create a button with a visible label.

\`\`\`typescript
const button = createButton({ label: 'Save' });
button.mount();
\`\`\`

\`\`\`javascript
createButton({ label: 'Save' }).mount();
\`\`\`

## 文档说明

### Components \\> Button

来源：[https://example.org/ui/button](https://example.org/ui/button)

Use a **visible label**. See the [guide](https://example.org/ui/guide).`,
  },
  {
    name: 'snippet group containing only usage instructions',
    renderer: 'context7',
    result: {
      status: 'success',
      data: {
        provider: 'ctx7',
        library_id: '/example/ui',
        code_snippets: [
          {
            url: 'https://example.org/ui/button',
            description: 'Use a visible label.',
          },
        ],
        info_snippets: [],
      },
    },
    markdown: `来源：Context7 · 库：\`/example/ui\`

## 代码与用法

来源：[https://example.org/ui/button](https://example.org/ui/button)

Use a visible label.`,
  },
  {
    name: 'empty library candidates',
    renderer: 'context7',
    result: {
      status: 'success',
      data: {
        provider: 'ctx7',
        results: [],
      },
    },
    markdown: `来源：Context7

未找到候选库`,
  },
  {
    name: 'empty code and documentation',
    renderer: 'context7',
    result: {
      status: 'success',
      data: {
        provider: 'ctx7',
        library_id: '/example/ui',
        code_snippets: [],
        info_snippets: [],
      },
    },
    markdown: `来源：Context7 · 库：\`/example/ui\`

未找到相关文档`,
  },
  {
    name: 'version not found',
    renderer: 'context7',
    result: {
      status: 'error',
      error: {
        code: 'CONTENT_UNAVAILABLE',
        message: 'Context7 无法提供所请求的库文档',
        details: {
          provider: 'ctx7',
          http_status: 404,
          upstream_code: 'tag_not_found',
          upstream_message: 'Tag v0.1.0 not found for library /example/ui.',
        },
      },
    },
    stderr: `错误: Context7 无法提供所请求的库文档
服务: ctx7
HTTP 状态: 404
上游代码: tag_not_found
上游消息: Tag v0.1.0 not found for library /example/ui.`,
  },
  {
    name: 'library migration',
    renderer: 'context7',
    result: {
      status: 'error',
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'Context7 库已迁移，请使用返回的新库标识',
        details: {
          provider: 'ctx7',
          http_status: 301,
          upstream_code: 'library_redirected',
          redirect_library_id: '/example/ui-next',
        },
      },
    },
    stderr: `错误: Context7 库已迁移，请使用返回的新库标识
服务: ctx7
HTTP 状态: 301
上游代码: library_redirected
新库 ID: /example/ui-next`,
  },
  {
    name: 'upstream diagnostics for authentication failure',
    renderer: 'context7',
    result: {
      status: 'error',
      error: {
        code: 'AUTHENTICATION_ERROR',
        message: 'Context7 认证失败',
        details: {
          provider: 'ctx7',
          http_status: 401,
          upstream_code: 'invalid_api_key',
          upstream_message: 'Invalid API key',
          request_id: 'ctx7-fixture-auth',
        },
      },
      meta: {
        elapsed_ms: 8,
        attempts: [
          {
            duration_ms: 8,
            http_status: 401,
            code: 'AUTHENTICATION_ERROR',
          },
        ],
      },
    },
    stderr: `错误: Context7 认证失败
服务: ctx7
HTTP 状态: 401
上游代码: invalid_api_key
上游消息: Invalid API key
请求 ID: ctx7-fixture-auth`,
  },
];
