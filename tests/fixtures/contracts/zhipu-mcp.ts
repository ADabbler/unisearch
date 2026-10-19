import type { ContractCase } from './types.js';

export const cases: ContractCase[] = [
  {
    name: 'search with text evidence',
    renderer: 'mcp-search',
    result: {
      status: 'success',
      data: {
        provider: 'zhipu-mcp',
        text: '## Installation guide\n\n[Official guide](https://example.org/guide)\n\nUse npm to install the package.',
      },
    },
    markdown: `来源：智谱 MCP

## Installation guide

[Official guide](https://example.org/guide)

Use npm to install the package.`,
  },
  {
    name: 'documentation with structured evidence',
    renderer: 'mcp-docs',
    result: {
      status: 'success',
      data: {
        provider: 'zhipu-mcp',
        repo: 'example/project',
        text: 'Run `npm install` before building.',
        structured_content: {
          sources: [
            {
              path: 'README.md',
              url: 'https://github.com/example/project/blob/main/README.md',
            },
          ],
        },
      },
    },
    markdown: `来源：智谱 MCP

仓库：example/project

Run \`npm install\` before building.

结构化内容：

\`\`\`json
{
  "sources": [
    {
      "path": "README.md",
      "url": "https://github.com/example/project/blob/main/README.md"
    }
  ]
}
\`\`\``,
  },
  {
    name: 'repository tree listing',
    renderer: 'mcp-tree',
    result: {
      status: 'success',
      data: {
        provider: 'zhipu-mcp',
        repo: 'example/project',
        path: 'src',
        text: 'src/\n├── index.ts\n└── client.ts\n',
      },
    },
    markdown: `来源：智谱 MCP

仓库：example/project

路径：src

\`\`\`text
src/
├── index.ts
└── client.ts
\`\`\``,
  },
  {
    name: 'file content reading',
    renderer: 'mcp-read-file',
    result: {
      status: 'success',
      data: {
        provider: 'zhipu-mcp',
        repo: 'example/project',
        path: 'src/index.ts',
        text: 'export const ready = true;\n',
      },
    },
    markdown: `来源：智谱 MCP

仓库：example/project

路径：src/index.ts

\`\`\`text
export const ready = true;
\`\`\``,
  },
  {
    name: 'dedicated and unified fetch',
    renderer: 'mcp-fetch',
    result: {
      status: 'success',
      data: {
        provider: 'zhipu-mcp',
        results: [
          {
            url: 'https://example.org/guide',
            text: '# Installation\n\nRun `npm install`.',
          },
        ],
      },
    },
    markdown: `来源：智谱 MCP · [https://example.org/guide](https://example.org/guide)

# Installation

Run \`npm install\`.`,
  },
  {
    name: 'content with annotations and source resources',
    renderer: 'mcp-docs',
    result: {
      status: 'success',
      data: {
        provider: 'zhipu-mcp',
        repo: 'example/project',
        content: [
          {
            type: 'text',
            text: 'The installation guide applies to the current release.',
            annotations: {
              lastModified: '2026-09-30T08:00:00Z',
            },
          },
          {
            type: 'resource_link',
            uri: 'https://example.org/guide',
            name: 'Installation guide',
            mimeType: 'text/markdown',
            description: 'Setup steps and prerequisites.',
          },
        ],
      },
    },
    markdown: `来源：智谱 MCP

仓库：example/project

The installation guide applies to the current release.

内容属性：

\`\`\`json
{
  "annotations": {
    "lastModified": "2026-09-30T08:00:00Z"
  }
}
\`\`\`

[Installation guide](https://example.org/guide)

Setup steps and prerequisites.

资源类型：text/markdown`,
  },
  {
    name: 'reading failure retains metadata',
    renderer: 'mcp-fetch',
    result: {
      status: 'error',
      data: {
        provider: 'zhipu-mcp',
        results: [
          {
            url: 'https://example.org/guide',
          },
        ],
        structured_content: {
          title: 'Installation guide',
        },
      },
      error: {
        code: 'CONTENT_UNAVAILABLE',
        message: '智谱 MCP 未返回网页正文',
        details: {
          provider: 'zhipu-mcp',
          reason: 'empty_content',
        },
      },
    },
    markdown: `> 错误：[CONTENT_UNAVAILABLE] 智谱 MCP 未返回网页正文
> 服务：zhipu-mcp
> 原因：empty_content

来源：智谱 MCP · [https://example.org/guide](https://example.org/guide)

结构化内容：

\`\`\`json
{
  "title": "Installation guide"
}
\`\`\``,
  },
  {
    name: 'tool failure with structured diagnostics',
    renderer: 'mcp-docs',
    result: {
      status: 'error',
      error: {
        code: 'UPSTREAM_ERROR',
        message: '智谱 MCP 工具调用失败',
        details: {
          provider: 'zhipu-mcp',
          operation: 'tools/call',
          upstream_message: 'The repository is not indexed.',
          upstream_data: {
            indexed: false,
            indexed_files: 0,
            suggestion: 'Check whether the public repository is available on zread.ai.',
          },
        },
      },
    },
    markdown: ``,
    stderr: `错误：智谱 MCP 工具调用失败
操作：tools/call
服务：zhipu-mcp
上游消息：The repository is not indexed.

上游详情：

\`\`\`json
{
  "indexed": false,
  "indexed_files": 0,
  "suggestion": "Check whether the public repository is available on zread.ai."
}
\`\`\``,
  },
  {
    name: 'partial root search',
    renderer: 'search',
    result: {
      status: 'partial',
      data: {
        answer: {
          model: 'example-model',
          text: 'Install the package with npm.',
        },
      },
      error: {
        code: 'PARTIAL_FAILURE',
        message: '模型搜索已完成，部分补充来源失败',
        details: {
          failures: [
            {
              provider: 'zhipu-mcp',
              code: 'AUTHENTICATION_ERROR',
              message: '智谱 MCP 拒绝了当前凭证。',
              details: {
                http_status: 401,
                operation: 'initialize',
              },
            },
          ],
        },
      },
    },
    markdown: `> 部分完成：[PARTIAL_FAILURE] 模型搜索已完成，部分补充来源失败
> - zhipu-mcp：[AUTHENTICATION_ERROR] 智谱 MCP 拒绝了当前凭证。
>   - 操作：initialize
>   - HTTP 状态：401

模型：example-model

Install the package with npm.`,
  },
];
