# Configuration

[简体中文](../zh-CN/configuration.md) · [README](../../README.md)

## Contents

- [Configure and inspect](#configure-and-inspect)
- [File location and precedence](#file-location-and-precedence)
- [Credential management](#credential-management)
- [Common settings](#common-settings)
- [Model settings](#model-settings)
- [Service settings](#service-settings)
  - [Exa](#exa)
  - [Tavily](#tavily)
  - [Firecrawl](#firecrawl)
  - [Context7](#context7)
  - [Jina](#jina)
  - [Zhipu API](#zhipu-api)
  - [Zhipu MCP](#zhipu-mcp)
  - [AnySearch](#anysearch)
  - [TinyFish](#tinyfish)
- [Examples](#examples)
- [Check and troubleshoot](#check-and-troubleshoot)

## Configure and inspect

For initial configuration, run `unisearch setup` to enter service connection details and choose whether to install the UniSearch Skill. Use `unisearch config` for later queries and changes, or edit the [configuration file](#file-location) directly.

Replace `KEY` with a field name from the configuration tables below. Dots (`.`) separate nested levels in the configuration file: `providers.exa.search.limit` follows the JSON path `providers` → `exa` → `search` → `limit`.

| Command                          | Purpose                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `unisearch config path`          | Show the configuration file path.                                               |
| `unisearch config list`          | Show effective values set in the file or environment, with their sources.       |
| `unisearch config list --all`    | Show effective configuration and sources, including built-in defaults.          |
| `unisearch config get KEY`       | Show one setting or a group of settings with their sources, including defaults. |
| `unisearch config set KEY VALUE` | Set and save one setting.                                                       |
| `unisearch config unset KEY`     | Remove a saved setting or group of settings.                                    |

For example, set, inspect, and remove Exa's search result limit:

```sh
unisearch config set providers.exa.search.limit 10
unisearch config get providers.exa.search.limit
unisearch config unset providers.exa.search.limit
```

To inspect or remove all Exa settings, replace the field name in the `get` or `unset` command above with `providers.exa`.

`VALUE` must match the type and accepted values listed for the field. For arrays, quote the JSON value, as in `'["exa","jina"]'`; setting an array replaces the existing list.

## File location and precedence

### File location

UniSearch reads one user configuration file:

| System  | Default configuration path                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | `$XDG_CONFIG_HOME/unisearch/config.json` when `XDG_CONFIG_HOME` is an absolute path; otherwise `~/.config/unisearch/config.json`.              |
| macOS   | `~/Library/Application Support/unisearch/config.json`                                                                                          |
| Windows | `%LOCALAPPDATA%\unisearch\config.json`; if `LOCALAPPDATA` is unset, use `AppData\Local\unisearch\config.json` under the user's home directory. |

`UNISEARCH_CONFIG_PATH` selects a different file. Relative paths are resolved from the command's working directory. The file must be a UTF-8 JSON object; comments and trailing commas are not accepted. UniSearch does not load project configuration or `.env` files automatically.

When the default file is missing, environment variables and built-in defaults apply. If a custom path has no file yet, initialize it with `unisearch setup` or `unisearch config set`.

### Precedence

For options that support an override, precedence is:

1. The command's explicit option, for that invocation.
2. The field's environment variable.
3. The saved file value.
4. The built-in default.

Configuration changes take effect on the next CLI invocation. `config unset` removes only saved file values. Environment variables still override file values and defaults; change or remove them in the environment that launches the CLI.

## Credential management

Enter API keys through setup's hidden input or set the environment variables listed in the tables. Configuration files store API keys as plain text; query results show `[REDACTED]`.

API keys passed directly on the command line may remain in shell history and process arguments.

## Common settings

In the tables, “None” means no default value and “—” means no environment variable is supported.

### Language

| Field      | Type and values    | Default | Environment variable |
| ---------- | ------------------ | ------- | -------------------- |
| `language` | `en`, `zh`, `auto` | `auto`  | `UNISEARCH_LANG`     |

`auto` follows the system language: Chinese for a Chinese locale and English otherwise. Provider content stays in its original language.

### Execution

| Field                       | Type and values                                                                      | Default | Environment variable        |
| --------------------------- | ------------------------------------------------------------------------------------ | ------- | --------------------------- |
| `execution.timeout_seconds` | Positive integer, in seconds                                                         | `300`   | `UNISEARCH_TIMEOUT_SECONDS` |
| `execution.retries`         | Nonnegative integer, additional retries per request; `0` disables retries            | `2`     | `UNISEARCH_RETRIES`         |
| `execution.fallback`        | `true` or `false`; controls backup models and service switching in unified fetch/map | `true`  | `UNISEARCH_FALLBACK`        |

Use `--timeout SECONDS` to override the time limit for one call. The limit includes retry waits and service switching. Model streaming follows [separate timeout rules](#streaming).

`--no-fallback` disables model or service switching without disabling retries. Provider-specific commands do not switch services.

### Unified fetch and map

| Field             | Type and values                                                         | Default                                                                                    | Environment variable |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------- |
| `fetch.providers` | Ordered string array; supports only the service IDs in the default list | `firecrawl` → `exa` → `tavily` → `jina` → `zhipu` → `zhipu-mcp` → `tinyfish` → `anysearch` | —                    |
| `map.providers`   | Ordered string array; supports only `tavily` and `firecrawl`            | `tavily` → `firecrawl`                                                                     | —                    |

`unisearch fetch` and `unisearch map` select enabled, configured services in list order and can try the next service after a failure when fallback is enabled. Service IDs must be unique; an empty list `[]` makes the command fail. Provider-specific commands are unaffected by these lists.

Unified commands reuse each service's settings. `map --limit` overrides the limit for one call; each service's interpretation of that limit is listed in its configuration table.

### Service switches

| Field                    | Type and values                                 | Default | Environment variable |
| ------------------------ | ----------------------------------------------- | ------- | -------------------- |
| `providers.<id>.enabled` | `true` enables the service; `false` disables it | `true`  | —                    |

`<id>` is `model`, `exa`, `tavily`, `firecrawl`, `ctx7`, `jina`, `zhipu`, `zhipu-mcp`, `anysearch`, or `tinyfish`.

For example, disable Exa:

```sh
unisearch config set providers.exa.enabled false
```

## Model settings

These settings apply to `unisearch search`.

| Field                             | Type and values                                                   | Default     | Environment variable       |
| --------------------------------- | ----------------------------------------------------------------- | ----------- | -------------------------- |
| `providers.model.api_key`         | API key, required                                                 | None        | `UNISEARCH_MODEL_API_KEY`  |
| `providers.model.base_url`        | API root URL, required                                            | None        | `UNISEARCH_MODEL_BASE_URL` |
| `providers.model.protocol`        | `responses`, `chat-completions`                                   | `responses` | `UNISEARCH_MODEL_PROTOCOL` |
| `providers.model.model.id`        | Model ID string, required                                         | None        | `UNISEARCH_MODEL_ID`       |
| `providers.model.model.effort`    | Effort string, optional                                           | None        | `UNISEARCH_MODEL_EFFORT`   |
| `providers.model.fallback_models` | Ordered array of model objects; format below                      | `[]`        | —                          |
| `providers.model.tools`           | Array of tool-type strings or objects; format below               | `[]`        | —                          |
| `providers.model.stream`          | `true` for streaming requests; `false` for non-streaming requests | `false`     | `UNISEARCH_MODEL_STREAM`   |

Set `base_url` to the API root, such as `https://api.x.ai/v1`, without endpoint suffixes such as `/responses` or `/chat/completions`. Choose a `protocol` supported by that API.

Accepted `model.effort` values depend on the model API. Omit it or use `default` for the model's default effort.

### Model selection

Each `fallback_models` entry has the form `{ "id": "...", "effort": "..." }`, with `effort` optional.

Backup models share the primary model's connection and tools but can each have their own effort. ID/effort pairs must be unique across primary and backup models; an omitted effort and `default` count as the same value.

```sh
unisearch config set providers.model.fallback_models '[{"id":"backup-model","effort":"low"}]'
```

`--model ID` selects one model and disables model fallback. Without `--effort`, it inherits the effort of the first saved entry with that ID, or the model service's default if none matches. `--effort` alone overrides only the first model attempted.

### Tool configuration

Each `tools` entry can be a tool-type string or an object with a `type` string.

The string `"web_search"` is equivalent to `{"type":"web_search"}`; do not configure both. To configure xAI search tools:

```sh
unisearch config set providers.model.tools '["web_search","x_search"]'
```

Object entries can include tool parameters. For a model API that supports `filters.allowed_domains`, restrict the search to a domain:

```sh
unisearch config set providers.model.tools '[{"type":"web_search","filters":{"allowed_domains":["example.org"]}}]'
```

`[]` disables tools. Web search requires the model API to support and enable the tools. UniSearch supports only tools executed by the model service.

Setup's xAI shortcut fills in the URL, Responses protocol, and `web_search` and `x_search` tools. For other APIs, configure the tools they support.

### Streaming

`--stream` enables streaming requests and `--no-stream` disables them for the current call. Both modes collect the complete answer before producing output.

Streaming model requests use the timeout duration from `execution.timeout_seconds` or `--timeout`, with these rules:

- The model service must return the first text within the call's total time limit.
- After receiving the first text, UniSearch resets the timer whenever it receives new model text. The request times out if no new text arrives within the timeout duration. Heartbeats and tool progress do not reset the timer.

A request that keeps returning text can exceed the initial total limit; supplementary searches selected with `--extra-sources` remain subject to that limit. Once text starts arriving, an interrupted answer produces an error without retries or model switching.

## Service settings

### Exa

| Field                              | Type and values                        | Default              | Environment variable     |
| ---------------------------------- | -------------------------------------- | -------------------- | ------------------------ |
| `providers.exa.api_key`            | API key, required for search and fetch | None                 | `UNISEARCH_EXA_API_KEY`  |
| `providers.exa.base_url`           | Connection URL                         | `https://api.exa.ai` | `UNISEARCH_EXA_BASE_URL` |
| `providers.exa.search.limit`       | Integer `1–100`, search result limit   | `5`                  | —                        |
| `providers.exa.search.search_type` | Search mode: `auto`, `fast`, `instant` | `auto`               | —                        |

### Tavily

| Field                                    | Type and values                                                               | Default                  | Environment variable        |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ------------------------ | --------------------------- |
| `providers.tavily.api_key`               | API key, required for search, extract, and map                                | None                     | `UNISEARCH_TAVILY_API_KEY`  |
| `providers.tavily.base_url`              | Connection URL                                                                | `https://api.tavily.com` | `UNISEARCH_TAVILY_BASE_URL` |
| `providers.tavily.search.limit`          | Integer `1–20`, search result limit                                           | `5`                      | —                           |
| `providers.tavily.search.search_depth`   | Search depth: `basic`, `advanced`, `fast`, `ultra-fast`                       | `basic`                  | —                           |
| `providers.tavily.extract.extract_depth` | Extraction depth: `basic`, `advanced`; also used by unified fetch             | `basic`                  | —                           |
| `providers.tavily.map.limit`             | Positive integer, maximum links processed by map; fewer links may be returned | `50`                     | —                           |

### Firecrawl

| Field                              | Type and values                                     | Default                        | Environment variable           |
| ---------------------------------- | --------------------------------------------------- | ------------------------------ | ------------------------------ |
| `providers.firecrawl.api_key`      | API key, required for search, scrape, and map       | None                           | `UNISEARCH_FIRECRAWL_API_KEY`  |
| `providers.firecrawl.base_url`     | Connection URL                                      | `https://api.firecrawl.dev/v2` | `UNISEARCH_FIRECRAWL_BASE_URL` |
| `providers.firecrawl.search.limit` | Integer `1–100`, search result limit                | `5`                            | —                              |
| `providers.firecrawl.map.limit`    | Integer `1–100000`, maximum returned map links      | `50`                           | —                              |
| `providers.firecrawl.map.sitemap`  | Sitemap use when mapping: `include`, `skip`, `only` | `include`                      | —                              |

Unified fetch uses Firecrawl's scrape operation.

### Context7

| Field                     | Type and values                                                                   | Default                    | Environment variable      |
| ------------------------- | --------------------------------------------------------------------------------- | -------------------------- | ------------------------- |
| `providers.ctx7.api_key`  | API key, optional for library and docs queries; omitted keys use anonymous access | None                       | `UNISEARCH_CTX7_API_KEY`  |
| `providers.ctx7.base_url` | Connection URL                                                                    | `https://context7.com/api` | `UNISEARCH_CTX7_BASE_URL` |

### Jina

| Field                         | Type and values                                     | Default             | Environment variable        |
| ----------------------------- | --------------------------------------------------- | ------------------- | --------------------------- |
| `providers.jina.api_key`      | API key, optional for fetch and required for search | None                | `UNISEARCH_JINA_API_KEY`    |
| `providers.jina.reader_url`   | Reader connection URL for fetch                     | `https://r.jina.ai` | `UNISEARCH_JINA_READER_URL` |
| `providers.jina.search_url`   | Search connection URL                               | `https://s.jina.ai` | `UNISEARCH_JINA_SEARCH_URL` |
| `providers.jina.search.limit` | Integer `1–20`, search result limit                 | `5`                 | —                           |

### Zhipu API

| Field                           | Type and values                                    | Default                                      | Environment variable       |
| ------------------------------- | -------------------------------------------------- | -------------------------------------------- | -------------------------- |
| `providers.zhipu.api_key`       | API key, required for search and fetch             | None                                         | `UNISEARCH_ZHIPU_API_KEY`  |
| `providers.zhipu.platform`      | `bigmodel`, `zai`                                  | `bigmodel`                                   | `UNISEARCH_ZHIPU_PLATFORM` |
| `providers.zhipu.base_url`      | Connection URL                                     | Depends on platform; see below               | `UNISEARCH_ZHIPU_BASE_URL` |
| `providers.zhipu.search.engine` | Search engine depends on platform; see below       | BigModel: `search_std`; Z.AI: `search-prime` | —                          |
| `providers.zhipu.search.limit`  | Integer `1–50`; Sogou and Quark restrictions below | `10`; no default for Quark                   | —                          |

Default connection URLs: `https://open.bigmodel.cn/api/paas/v4` for BigModel and `https://api.z.ai/api/paas/v4` for Z.AI.

The search engine parameter, `search.engine`, accepts `search_std`, `search_pro`, `search_pro_sogou`, or `search_pro_quark` on BigModel, and `search-prime` on Z.AI. Sogou accepts `search.limit` values of `10`, `20`, `30`, `40`, or `50`.

Quark, and Sogou with both domain and time filters, reject `search.limit` and `--limit`. If `search.limit` is saved, remove it with `unisearch config unset providers.zhipu.search.limit`.

After switching platforms, check any manually set `base_url` and `search.engine` values; they do not change automatically.

### Zhipu MCP

| Field                          | Type and values                                                            | Default                        | Environment variable           |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------ | ------------------------------ |
| `providers.zhipu-mcp.api_key`  | API key, required; use the credential for the selected Coding Plan service | None                           | `UNISEARCH_ZHIPU_MCP_API_KEY`  |
| `providers.zhipu-mcp.platform` | `bigmodel`, `zai`                                                          | `bigmodel`                     | `UNISEARCH_ZHIPU_MCP_PLATFORM` |
| `providers.zhipu-mcp.base_url` | MCP root URL                                                               | Depends on platform; see below | `UNISEARCH_ZHIPU_MCP_BASE_URL` |

Default connection URLs: `https://open.bigmodel.cn/api/mcp` for BigModel and `https://api.z.ai/api/mcp` for Z.AI.

### AnySearch

| Field                              | Type and values                                                            | Default                     | Environment variable           |
| ---------------------------------- | -------------------------------------------------------------------------- | --------------------------- | ------------------------------ |
| `providers.anysearch.api_key`      | API key, optional; omitted keys use anonymous access for online operations | None                        | `UNISEARCH_ANYSEARCH_API_KEY`  |
| `providers.anysearch.base_url`     | Connection URL                                                             | `https://api.anysearch.com` | `UNISEARCH_ANYSEARCH_BASE_URL` |
| `providers.anysearch.search.limit` | Integer `1–10`, general search result limit                                | `5`                         | —                              |

### TinyFish

| Field                           | Type and values                        | Default                          | Environment variable            |
| ------------------------------- | -------------------------------------- | -------------------------------- | ------------------------------- |
| `providers.tinyfish.api_key`    | API key, required for search and fetch | None                             | `UNISEARCH_TINYFISH_API_KEY`    |
| `providers.tinyfish.search_url` | Search connection URL                  | `https://api.search.tinyfish.ai` | `UNISEARCH_TINYFISH_SEARCH_URL` |
| `providers.tinyfish.fetch_url`  | Fetch connection URL                   | `https://api.fetch.tinyfish.ai`  | `UNISEARCH_TINYFISH_FETCH_URL`  |

## Examples

Configure Exa search and let unified fetch try Exa followed by Jina:

```json
{
  "providers": {
    "exa": { "api_key": "example-exa-key", "search": { "limit": 10 } }
  },
  "fetch": { "providers": ["exa", "jina"] }
}
```

Replace the example API key with your credential, or remove `api_key` and set the `UNISEARCH_EXA_API_KEY` environment variable.

A model connection with xAI search tools:

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

Replace the example API key and model ID with your own settings. For another model API, adjust the URL, protocol, and tools to its requirements. Each example can be used on its own; to configure both, combine the services under one `providers` object.

## Check and troubleshoot

Start with local inspection:

```sh
unisearch config path
unisearch config get providers.model
unisearch status
```

`status` checks local configuration:

| State      | Meaning                                  |
| ---------- | ---------------------------------------- |
| `ready`    | Required settings are present and valid. |
| `missing`  | Required settings are missing.           |
| `disabled` | The service is disabled.                 |
| `invalid`  | Configuration is invalid.                |

For `missing` or `invalid`, follow the reported issues to complete or correct the settings. `ready` means only that local configuration is valid. Use `doctor` to verify credentials and connectivity.

For an online check, choose a configured provider:

```sh
unisearch doctor exa
```

Without a service name, `doctor` checks all enabled, configured services, including anonymous services, and may consume quota. Diagnostics do not retry or switch services. `passed` means that check succeeded, not that every service operation is available.

### A saved value is not taking effect

Run `unisearch config get KEY` to inspect the effective value and source, then check overrides against the [precedence rules](#precedence). If the source is an environment variable, update or remove it in the shell or Agent launcher.

### The file cannot be read or parsed

Use `unisearch config path` to locate the file, then check read permissions and JSON syntax. See [File location](#file-location) for file requirements and missing-file behavior. Edit malformed JSON directly; remove unknown fields with `unisearch config unset KEY`.

### A service is disabled or missing settings

Run `unisearch status` and `unisearch config get providers.SERVICE`, replacing `SERVICE` with the service ID. Use the results to [enable the service](#service-switches) and supply required fields. Credential requirements are listed under [Service settings](#service-settings).

### Authentication, protocol, or model errors

Check the API key's platform and permissions, along with the URL, protocol, and model ID. See [Model settings](#model-settings) for API root, tool, and effort requirements.

### Timeouts or repeated requests

Add `--verbose` to the failing command to inspect its execution records. Check connectivity and service limits before increasing the timeout; some services have shorter limits per request. See [Execution](#execution) for retries and switching, and [Streaming](#streaming) for streamed timeouts.
