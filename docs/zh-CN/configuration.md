# 配置

[English](../en/configuration.md) · [README](../../README.zh-CN.md)

## 目录

- [配置与查询](#配置与查询)
- [文件位置与优先级](#文件位置与优先级)
- [凭证管理](#凭证管理)
- [公共设置](#公共设置)
- [模型配置](#模型配置)
- [服务配置](#服务配置)
  - [Exa](#exa)
  - [Tavily](#tavily)
  - [Firecrawl](#firecrawl)
  - [Context7](#context7)
  - [Jina](#jina)
  - [智谱 API](#智谱-api)
  - [智谱 MCP](#智谱-mcp)
  - [AnySearch](#anysearch)
  - [TinyFish](#tinyfish)
- [配置示例](#配置示例)
- [检查与排障](#检查与排障)

## 配置与查询

首次配置运行 `unisearch setup`，按提示填写服务连接信息，并选择是否安装 UniSearch Skill。后续可用 `unisearch config` 查询、修改设置，或直接编辑[配置文件](#文件位置)。

`KEY` 填写下方配置表中的字段名。点号 `.` 分隔配置文件中的嵌套层级，例如 `providers.exa.search.limit` 对应 JSON 中的 `providers` → `exa` → `search` → `limit`。

| 命令                             | 作用                                                 |
| -------------------------------- | ---------------------------------------------------- |
| `unisearch config path`          | 显示配置文件路径。                                   |
| `unisearch config list`          | 查看文件或环境变量中已设置的生效值及来源。           |
| `unisearch config list --all`    | 查看生效配置及来源，包括内置默认值。                 |
| `unisearch config get KEY`       | 查看一个配置项或一组配置的生效值及来源，包括默认值。 |
| `unisearch config set KEY VALUE` | 设置并保存一个配置项。                               |
| `unisearch config unset KEY`     | 删除已保存的配置项或整组配置。                       |

例如，设置、查询并删除 Exa 的搜索结果数量上限：

```sh
unisearch config set providers.exa.search.limit 10
unisearch config get providers.exa.search.limit
unisearch config unset providers.exa.search.limit
```

查询或删除 Exa 的整组配置时，将上述 `get` 或 `unset` 命令中的字段名替换为 `providers.exa`。

`VALUE` 的类型与取值见下方配置表。数组使用 JSON 格式并用引号包住，例如 `'["exa","jina"]'`；设置数组会替换原有列表。

## 文件位置与优先级

### 文件位置

UniSearch 读取一个用户配置文件：

| 系统    | 默认配置路径                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Linux   | `XDG_CONFIG_HOME` 为绝对路径时使用 `$XDG_CONFIG_HOME/unisearch/config.json`，否则使用 `~/.config/unisearch/config.json`。    |
| macOS   | `~/Library/Application Support/unisearch/config.json`                                                                        |
| Windows | `%LOCALAPPDATA%\unisearch\config.json`；未设置 `LOCALAPPDATA` 时，使用用户主目录下的 `AppData\Local\unisearch\config.json`。 |

`UNISEARCH_CONFIG_PATH` 可以指定其他文件，相对路径从命令的工作目录解析。文件须为 UTF-8 编码的 JSON 对象，不接受注释或尾随逗号。UniSearch 不自动加载项目配置或 `.env` 文件。

默认文件不存在时，使用环境变量和内置默认值。自定义路径尚无文件时，先用 `unisearch setup` 或 `unisearch config set` 初始化。

### 生效优先级

支持覆盖的选项按以下优先级生效：

1. 本次命令显式传入的选项。
2. 对应字段的环境变量。
3. 配置文件中的值。
4. 内置默认值。

配置修改在下次 CLI 调用时生效。`config unset` 只删除文件中的保存值；环境变量仍会覆盖文件值和默认值，需要在启动 CLI 的环境中单独修改或移除。

## 凭证管理

使用 setup 的隐藏输入填写 API Key，或设置表格中对应的环境变量。配置文件以明文保存 API Key，查询结果会显示为 `[REDACTED]`。

直接在命令行传入 API Key 可能将其留在 shell 历史和进程参数中。

## 公共设置

表格中的“无”表示没有默认值，“—”表示不支持环境变量覆盖。

### 界面语言

| 字段       | 类型与取值         | 默认值 | 环境变量         |
| ---------- | ------------------ | ------ | ---------------- |
| `language` | `en`、`zh`、`auto` | `auto` | `UNISEARCH_LANG` |

`auto` 跟随系统语言：中文环境使用中文，其他环境使用英文。服务返回的内容保留原文。

### 执行设置

| 字段                        | 类型与取值                                                 | 默认值 | 环境变量                    |
| --------------------------- | ---------------------------------------------------------- | ------ | --------------------------- |
| `execution.timeout_seconds` | 正整数，单位为秒                                           | `300`  | `UNISEARCH_TIMEOUT_SECONDS` |
| `execution.retries`         | 非负整数，每个请求的额外重试次数；`0` 关闭重试             | `2`    | `UNISEARCH_RETRIES`         |
| `execution.fallback`        | `true`、`false`，控制备用模型和统一 fetch/map 的跨服务切换 | `true` | `UNISEARCH_FALLBACK`        |

单次调用可用 `--timeout SECONDS` 覆盖时限。时限包含重试等待和服务切换；模型流式请求采用[单独的超时规则](#流式请求)。

`--no-fallback` 关闭模型或服务切换，不影响重试。服务专用命令不会跨服务切换。

### 统一 fetch 与 map

| 字段              | 类型与取值                                   | 默认值                                                                                     | 环境变量 |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| `fetch.providers` | 有序字符串数组，仅支持默认列表中的服务 ID    | `firecrawl` → `exa` → `tavily` → `jina` → `zhipu` → `zhipu-mcp` → `tinyfish` → `anysearch` | —        |
| `map.providers`   | 有序字符串数组，仅支持 `tavily`、`firecrawl` | `tavily` → `firecrawl`                                                                     | —        |

`unisearch fetch` 和 `unisearch map` 按列表顺序选择已启用且配置完整的服务，启用回退时可在失败后尝试下一服务。列表中的服务 ID 不能重复，空列表 `[]` 会导致对应命令报错；服务专用命令不受列表影响。

统一命令复用各服务的配置。`map --limit` 可覆盖本次的数量设置，各服务对数量的定义见下方配置表。

### 服务开关

| 字段                     | 类型与取值                | 默认值 | 环境变量 |
| ------------------------ | ------------------------- | ------ | -------- |
| `providers.<id>.enabled` | `true` 启用，`false` 禁用 | `true` | —        |

`<id>` 为 `model`、`exa`、`tavily`、`firecrawl`、`ctx7`、`jina`、`zhipu`、`zhipu-mcp`、`anysearch` 或 `tinyfish`。

例如，禁用 Exa：

```sh
unisearch config set providers.exa.enabled false
```

## 模型配置

这些配置用于 `unisearch search`。

| 字段                              | 类型与取值                                  | 默认值      | 环境变量                   |
| --------------------------------- | ------------------------------------------- | ----------- | -------------------------- |
| `providers.model.api_key`         | API Key，必需                               | 无          | `UNISEARCH_MODEL_API_KEY`  |
| `providers.model.base_url`        | API 根地址，必需                            | 无          | `UNISEARCH_MODEL_BASE_URL` |
| `providers.model.protocol`        | `responses`、`chat-completions`             | `responses` | `UNISEARCH_MODEL_PROTOCOL` |
| `providers.model.model.id`        | 模型 ID 字符串，必需                        | 无          | `UNISEARCH_MODEL_ID`       |
| `providers.model.model.effort`    | 思考等级字符串，可选                        | 无          | `UNISEARCH_MODEL_EFFORT`   |
| `providers.model.fallback_models` | 有序模型对象数组，格式见下文                | `[]`        | —                          |
| `providers.model.tools`           | 工具类型字符串或对象的数组，格式见下文      | `[]`        | —                          |
| `providers.model.stream`          | `true` 启用流式请求，`false` 使用非流式请求 | `false`     | `UNISEARCH_MODEL_STREAM`   |

`base_url` 填写 API 根地址，例如 `https://api.x.ai/v1`，不包含 `/responses` 或 `/chat/completions` 等接口后缀。`protocol` 选择该 API 支持的协议。

`model.effort` 的可选值由模型 API 决定；未设置或填 `default` 时，使用该模型的默认思考等级。

### 模型选择

`fallback_models` 的每项格式为 `{ "id": "...", "effort": "..." }`，`effort` 可省略。

备用模型共用主模型的连接和工具配置，可分别指定思考等级。主模型与备用模型的 ID、思考等级组合不能重复；省略思考等级与 `default` 视为相同值。

```sh
unisearch config set providers.model.fallback_models '[{"id":"backup-model","effort":"low"}]'
```

`--model ID` 指定单个模型并关闭模型回退。未提供 `--effort` 时，沿用第一个同名配置的思考等级，找不到时使用模型服务的默认值。单独使用 `--effort` 只覆盖首先尝试的模型。

### 工具配置

`tools` 的每项可以是工具类型字符串，或包含 `type` 字符串的对象。

字符串 `"web_search"` 等价于 `{"type":"web_search"}`，两者不能重复配置。配置 xAI 搜索工具：

```sh
unisearch config set providers.model.tools '["web_search","x_search"]'
```

对象形式可以携带工具参数。例如，对支持 `filters.allowed_domains` 的模型 API，限定搜索域名：

```sh
unisearch config set providers.model.tools '[{"type":"web_search","filters":{"allowed_domains":["example.org"]}}]'
```

`[]` 表示不使用工具。联网搜索需要模型 API 支持并启用对应工具；UniSearch 仅支持由模型服务执行的工具。

setup 的 xAI 快捷项会自动填写地址、Responses 协议及 `web_search`、`x_search`。其他 API 应按其支持情况配置工具。

### 流式请求

`--stream` 启用流式请求，`--no-stream` 关闭，均只对本次调用生效。两种模式都在收到完整回答后输出。

模型流式请求的超时时长由 `execution.timeout_seconds` 或 `--timeout` 指定，按以下规则计时：

- 模型服务须在本次调用的总时限内返回首段文本。
- UniSearch 收到首段文本后，每次收到新的模型文本都会重置计时；超过设定时长未收到新文本，该请求即超时。心跳和工具进度不会重置计时。

持续返回文本的请求可超过最初的总时限；`--extra-sources` 指定的补充检索仍受该时限约束。开始返回文本后若回答中断，会报错且不再重试或切换模型。

## 服务配置

### Exa

| 字段                               | 类型与取值                          | 默认值               | 环境变量                 |
| ---------------------------------- | ----------------------------------- | -------------------- | ------------------------ |
| `providers.exa.api_key`            | API Key，搜索和 fetch 必需          | 无                   | `UNISEARCH_EXA_API_KEY`  |
| `providers.exa.base_url`           | 连接地址                            | `https://api.exa.ai` | `UNISEARCH_EXA_BASE_URL` |
| `providers.exa.search.limit`       | 整数 `1–100`，搜索结果数量上限      | `5`                  | —                        |
| `providers.exa.search.search_type` | 搜索模式：`auto`、`fast`、`instant` | `auto`               | —                        |

### Tavily

| 字段                                     | 类型与取值                                             | 默认值                   | 环境变量                    |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------ | --------------------------- |
| `providers.tavily.api_key`               | API Key，搜索、extract 和 map 必需                     | 无                       | `UNISEARCH_TAVILY_API_KEY`  |
| `providers.tavily.base_url`              | 连接地址                                               | `https://api.tavily.com` | `UNISEARCH_TAVILY_BASE_URL` |
| `providers.tavily.search.limit`          | 整数 `1–20`，搜索结果数量上限                          | `5`                      | —                           |
| `providers.tavily.search.search_depth`   | 搜索深度：`basic`、`advanced`、`fast`、`ultra-fast`    | `basic`                  | —                           |
| `providers.tavily.extract.extract_depth` | 提取深度：`basic`、`advanced`；统一 fetch 也使用此设置 | `basic`                  | —                           |
| `providers.tavily.map.limit`             | 正整数，map 处理的链接数量上限；实际返回数量可能更少   | `50`                     | —                           |

### Firecrawl

| 字段                               | 类型与取值                                  | 默认值                         | 环境变量                       |
| ---------------------------------- | ------------------------------------------- | ------------------------------ | ------------------------------ |
| `providers.firecrawl.api_key`      | API Key，搜索、scrape 和 map 必需           | 无                             | `UNISEARCH_FIRECRAWL_API_KEY`  |
| `providers.firecrawl.base_url`     | 连接地址                                    | `https://api.firecrawl.dev/v2` | `UNISEARCH_FIRECRAWL_BASE_URL` |
| `providers.firecrawl.search.limit` | 整数 `1–100`，搜索结果数量上限              | `5`                            | —                              |
| `providers.firecrawl.map.limit`    | 整数 `1–100000`，map 返回链接数量上限       | `50`                           | —                              |
| `providers.firecrawl.map.sitemap`  | 站点地图使用方式：`include`、`skip`、`only` | `include`                      | —                              |

统一 fetch 使用 Firecrawl 的 scrape 操作。

### Context7

| 字段                      | 类型与取值                                      | 默认值                     | 环境变量                  |
| ------------------------- | ----------------------------------------------- | -------------------------- | ------------------------- |
| `providers.ctx7.api_key`  | API Key，库定位与文档查询可选；未提供时匿名请求 | 无                         | `UNISEARCH_CTX7_API_KEY`  |
| `providers.ctx7.base_url` | 连接地址                                        | `https://context7.com/api` | `UNISEARCH_CTX7_BASE_URL` |

### Jina

| 字段                          | 类型与取值                    | 默认值              | 环境变量                    |
| ----------------------------- | ----------------------------- | ------------------- | --------------------------- |
| `providers.jina.api_key`      | API Key，fetch 可选，搜索必需 | 无                  | `UNISEARCH_JINA_API_KEY`    |
| `providers.jina.reader_url`   | Reader 连接地址，用于 fetch   | `https://r.jina.ai` | `UNISEARCH_JINA_READER_URL` |
| `providers.jina.search_url`   | Search 连接地址               | `https://s.jina.ai` | `UNISEARCH_JINA_SEARCH_URL` |
| `providers.jina.search.limit` | 整数 `1–20`，搜索结果数量上限 | `5`                 | —                           |

### 智谱 API

| 字段                            | 类型与取值                          | 默认值                                       | 环境变量                   |
| ------------------------------- | ----------------------------------- | -------------------------------------------- | -------------------------- |
| `providers.zhipu.api_key`       | API Key，搜索和 fetch 必需          | 无                                           | `UNISEARCH_ZHIPU_API_KEY`  |
| `providers.zhipu.platform`      | `bigmodel`、`zai`                   | `bigmodel`                                   | `UNISEARCH_ZHIPU_PLATFORM` |
| `providers.zhipu.base_url`      | 连接地址                            | 按平台，见下文                               | `UNISEARCH_ZHIPU_BASE_URL` |
| `providers.zhipu.search.engine` | 按平台选择搜索引擎，见下文          | BigModel：`search_std`；Z.AI：`search-prime` | —                          |
| `providers.zhipu.search.limit`  | 整数 `1–50`；搜狗和夸克的限制见下文 | `10`；夸克无默认值                           | —                          |

默认连接地址：BigModel 为 `https://open.bigmodel.cn/api/paas/v4`，Z.AI 为 `https://api.z.ai/api/paas/v4`。

搜索引擎参数 `search.engine` 的可选值：BigModel 为 `search_std`、`search_pro`、`search_pro_sogou` 和 `search_pro_quark`；Z.AI 为 `search-prime`。搜狗的 `search.limit` 仅支持 `10`、`20`、`30`、`40`、`50`。

使用夸克，或使用搜狗且同时按域名和时间过滤时，不能指定 `search.limit` 或 `--limit`。如已保存 `search.limit`，运行 `unisearch config unset providers.zhipu.search.limit` 删除。

切换平台后，检查已手动设置的 `base_url` 和 `search.engine`，它们不会自动更换。

### 智谱 MCP

| 字段                           | 类型与取值                                     | 默认值         | 环境变量                       |
| ------------------------------ | ---------------------------------------------- | -------------- | ------------------------------ |
| `providers.zhipu-mcp.api_key`  | API Key，必需；使用所选 Coding Plan 服务的凭证 | 无             | `UNISEARCH_ZHIPU_MCP_API_KEY`  |
| `providers.zhipu-mcp.platform` | `bigmodel`、`zai`                              | `bigmodel`     | `UNISEARCH_ZHIPU_MCP_PLATFORM` |
| `providers.zhipu-mcp.base_url` | MCP 根地址                                     | 按平台，见下文 | `UNISEARCH_ZHIPU_MCP_BASE_URL` |

默认连接地址：BigModel 为 `https://open.bigmodel.cn/api/mcp`，Z.AI 为 `https://api.z.ai/api/mcp`。

### AnySearch

| 字段                               | 类型与取值                                  | 默认值                      | 环境变量                       |
| ---------------------------------- | ------------------------------------------- | --------------------------- | ------------------------------ |
| `providers.anysearch.api_key`      | API Key，可选；未提供时联网操作使用匿名访问 | 无                          | `UNISEARCH_ANYSEARCH_API_KEY`  |
| `providers.anysearch.base_url`     | 连接地址                                    | `https://api.anysearch.com` | `UNISEARCH_ANYSEARCH_BASE_URL` |
| `providers.anysearch.search.limit` | 整数 `1–10`，通用搜索结果数量上限           | `5`                         | —                              |

### TinyFish

| 字段                            | 类型与取值                 | 默认值                           | 环境变量                        |
| ------------------------------- | -------------------------- | -------------------------------- | ------------------------------- |
| `providers.tinyfish.api_key`    | API Key，搜索和 fetch 必需 | 无                               | `UNISEARCH_TINYFISH_API_KEY`    |
| `providers.tinyfish.search_url` | Search 连接地址            | `https://api.search.tinyfish.ai` | `UNISEARCH_TINYFISH_SEARCH_URL` |
| `providers.tinyfish.fetch_url`  | Fetch 连接地址             | `https://api.fetch.tinyfish.ai`  | `UNISEARCH_TINYFISH_FETCH_URL`  |

## 配置示例

配置 Exa 搜索，并让统一 fetch 依次尝试 Exa 和 Jina：

```json
{
  "providers": {
    "exa": { "api_key": "example-exa-key", "search": { "limit": 10 } }
  },
  "fetch": { "providers": ["exa", "jina"] }
}
```

将示例 API Key 替换为自己的凭证，或删除 `api_key` 字段并设置 `UNISEARCH_EXA_API_KEY` 环境变量。

配置模型连接及 xAI 搜索工具：

```json
{
  "providers": {
    "model": {
      "base_url": "https://api.x.ai/v1",
      "api_key": "example-model-key",
      "model": { "id": "your-model-id" },
      "tools": ["web_search", "x_search"]
    }
  }
}
```

将示例 API Key 和模型 ID 替换为自己的配置。使用其他模型 API 时，按其要求修改地址、协议和工具。两个示例可以独立使用；同时配置时，将各服务合并到同一个 `providers` 对象中。

## 检查与排障

先检查本地配置：

```sh
unisearch config path
unisearch config get providers.model
unisearch status
```

`status` 检查本地配置：

| 状态       | 含义                     |
| ---------- | ------------------------ |
| `ready`    | 必要设置齐全且格式有效。 |
| `missing`  | 缺少必要设置。           |
| `disabled` | 服务已禁用。             |
| `invalid`  | 配置无效。               |

出现 `missing` 或 `invalid` 时，按提示补齐或修正配置。`ready` 只表示本地配置有效；验证凭证和连接请使用 `doctor`。

需要联网检查时，选择已配置的服务：

```sh
unisearch doctor exa
```

不指定服务时，`doctor` 检查所有已启用且配置可用的服务，包括匿名服务，可能消耗额度。诊断不重试或切换服务。`passed` 表示该项诊断成功，不保证该服务的所有操作均可用。

### 保存值没有生效

执行 `unisearch config get KEY` 查看生效值和来源，再按[优先级](#生效优先级)检查覆盖关系。若来源是环境变量，在 shell 或 Agent 的启动环境中修改或移除该变量。

### 配置文件无法读取或解析

通过 `unisearch config path` 定位文件，检查读取权限和 JSON 格式。文件要求及缺失文件的处理见[文件位置](#文件位置)。已有文件的 JSON 格式错误须直接编辑修正，未知字段可用 `unisearch config unset KEY` 删除。

### 服务被禁用或缺少设置

执行 `unisearch status` 和 `unisearch config get providers.SERVICE`，将 `SERVICE` 替换为实际服务 ID。根据结果[启用服务](#服务开关)并补齐必要字段；凭证要求见对应的[服务配置](#服务配置)。

### 认证、协议或模型报错

检查 API Key 对应的平台与访问权限，以及地址、协议和模型 ID 是否正确。模型的根地址、工具和思考等级要求见[模型配置](#模型配置)。

### 超时或重复请求

在失败命令后添加 `--verbose` 查看执行记录，先检查网络连接和服务限制，再考虑增加超时。部分服务的单次请求时限可能更短。重试和切换见[执行设置](#执行设置)，流式超时见[流式请求](#流式请求)。
