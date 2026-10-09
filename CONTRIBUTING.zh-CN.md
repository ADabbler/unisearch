# 贡献指南

[English](CONTRIBUTING.md) · [README](README.zh-CN.md)

## 开发环境

使用 Node.js 24 或更高版本及 npm，在仓库目录安装依赖并运行 CLI：

```sh
npm ci --ignore-scripts
npm run dev -- --help
```

`npm run dev -- <参数>` 会先构建源码，再将参数传给 CLI。仅需构建时运行 `npm run build`。

`dist/` 和 `.test-build/` 是生成目录，不手动编辑或提交。

## 代码组织

- `src/cli.ts` 读取包版本并运行 CLI，`src/cli/` 定义命令、帮助与终端交互。
- `src/config/` 定义配置字段并负责解析、查询和保存，`src/i18n/` 管理界面语言与带类型的中英文消息。
- `src/search.ts` 组合模型与补充检索，`src/retrieval.ts` 为统一 fetch/map 选择和切换服务。
- `src/execution.ts` 管理请求截止时间、重试等待、取消和执行记录，`src/providers/` 构造服务请求并解析响应。
- `src/result.ts` 和 `src/errors.ts` 定义结果与失败，`src/output/` 渲染结果并写入输出流或文件。
- `src/setup.ts`、`src/doctor.ts` 和 `src/skills/` 分别实现交互配置、联网诊断和 Skill 副本管理。
- `tests/` 包含 Node 测试与夹具，`scripts/check-package.mjs` 通过隔离安装验证分发包。

命令先解析所需配置，再执行操作。模型与补充检索并行运行，分别保留结果；统一 fetch/map 按配置顺序尝试候选服务。两者复用请求执行层，最后由输出模块呈现结果。

## 开发检查

- `npm run typecheck`：检查源码与测试类型，不生成文件。
- `npm run format:check`：检查格式。使用 `npm run format` 格式化仓库，或用本地 Prettier 只格式化修改的文件。
- `npm test`：清理生成目录，编译源码与测试，再运行 Node 测试。
- `npm run check:package`：构建并验证安装包内容、安装、升级，以及卸载后保留配置和 Skill 的行为。
- `npm run check`：运行 CI 使用的完整格式、类型、测试与包检查。

按修改范围选择检查；涉及依赖、命令入口、随包资源或安装行为时，运行 `npm run check:package`。CI 在 Linux、macOS 和 Windows 上使用 Node.js 24 执行完整检查。

自动化测试无需真实服务凭证，使用模拟响应、本地 HTTP 服务和临时目录，不读取个人配置或调用真实服务。编写测试时可复用 [tests/helpers.ts](tests/helpers.ts) 中的辅助函数及 `tests/` 下的服务夹具。如进行了真实服务验证，在 PR 中注明服务、操作和结果。

`npm run check:package` 使用临时目录打包和安装，完成后输出已验证的安装包路径。仅需构建并生成 `.tgz` 安装包时，运行 `npm pack`。

## 修改与提交

修复缺陷时，补充能复现问题的测试；新增或调整功能时，同步更新相关测试和文档。

源码和测试采用严格模式 TypeScript、ESM 与 NodeNext 模块解析。相对导入使用 `.js` 扩展名，类型导入使用 `import type`。文件路径使用 Node.js 路径工具，子进程参数以数组传入，保持 Linux、macOS 和 Windows 支持。

修改服务接入时，一并检查配置字段、命令定义、请求构造、响应处理、结果渲染和相关测试。服务特有逻辑保留在对应模块，通用请求逻辑复用公共执行层。新增界面文案须同时补齐 `src/i18n/` 中的中英文消息。

配置变更同步更新[英文](docs/en/configuration.md)和[中文](docs/zh-CN/configuration.md)配置文档。新增或移除随包文件时，同步更新 `package.json` 的 `files` 和包检查白名单。

每个提交聚焦一个改动，提交信息使用 `<type>(<scope>): <description>`。PR 说明解决的问题、修改后的行为和已运行的检查，方便维护者复现和审阅。

通过 [Issues](https://github.com/ADabbler/unisearch/issues) 反馈问题时，提供 UniSearch 和 Node.js 版本、操作系统、复现步骤、预期结果及实际结果。
