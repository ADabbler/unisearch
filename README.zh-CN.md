<h1 align="center">UniSearch</h1>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/unisearch-cli"><img src="https://img.shields.io/npm/v/unisearch-cli?label=unisearch-cli" alt="unisearch-cli npm 版本"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D24-339933" alt="Node.js 24 或更高版本">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT 许可证"></a>
</p>

UniSearch 是面向 AI Agent 的统一检索 CLI，整合模型搜索、网页搜索、正文读取、站点链接发现，以及库文档和仓库文档查询。

支持模型 API、[Exa](https://exa.ai/)、[Tavily](https://www.tavily.com/)、[Firecrawl](https://www.firecrawl.dev/)、[Context7](https://context7.com/)、[Jina](https://jina.ai/)、[智谱 API](https://bigmodel.cn/)、[智谱 MCP](https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server)、[AnySearch](https://anysearch.com/) 和 [TinyFish](https://www.tinyfish.ai/)。

## 安装

在 Linux、macOS 或 Windows 上使用 Node.js 24 或更高版本及 npm。

```sh
npm install -g unisearch-cli
unisearch --version
```

确保运行 Agent 的进程能通过 PATH 找到 `unisearch`。

## 配置

setup 在交互终端中运行，选择需要的连接、填写设置，并按需为 Agent 安装 Skill，保存前可以预览修改。

```sh
unisearch setup
```

配置后可按需检查本地设置或测试连接：

```sh
unisearch status
unisearch doctor
```

- `status` 仅检查本地配置，不发起网络请求。
- `doctor` 对已启用且具备诊断配置的服务发起联网检查，可能消耗额度。使用 `unisearch doctor exa` 可只检查指定服务。

完整设置、凭证、环境变量、模型协议和配置排障见[配置文档](docs/zh-CN/configuration.md)。

## 接入 Agent

如果没有在 setup 中安装 Skill，可以为指定 Agent 安装：

```sh
unisearch skills install --targets codex,claude
unisearch skills status --targets codex,claude
```

以上示例将随包的 UniSearch Skill 安装到 `~/.codex/skills/` 和 `~/.claude/skills/` 下。安装时省略 `--targets` 可交互选择 Agent；`skills status` 省略此选项时检查全部目标。支持的目标见 `unisearch skills install --help`。

`install` 创建缺少的副本，并将已有副本同步为随包版本；`status` 只比较差异，不修改文件。同步会用随包版本替换受管理的 Skill 目录，包括其中的本地修改。

## 升级与卸载

升级 CLI 并同步已安装的 Skill：

```sh
npm update -g unisearch-cli
unisearch skills update --targets codex,claude
```

移除 Skill 副本并卸载 CLI：

```sh
unisearch skills remove --targets codex,claude
npm uninstall -g unisearch-cli
```

请使用实际安装过的目标。仅执行 npm uninstall 会保留配置和 Skill 副本。需要同时删除配置时，先在卸载前通过 `unisearch config path` 确认位置，再单独删除该文件。

## 贡献

开发与贡献流程见[贡献指南](https://github.com/ADabbler/unisearch/blob/main/CONTRIBUTING.zh-CN.md)，遇到问题可通过 [Issues](https://github.com/ADabbler/unisearch/issues) 反馈。

## 参考项目

UniSearch 参考 [Smart Search](https://github.com/konbakuyomu/smartsearch) 重构。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
