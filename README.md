<h1 align="center">UniSearch</h1>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/unisearch-cli"><img src="https://img.shields.io/npm/v/unisearch-cli?label=unisearch-cli" alt="unisearch-cli npm version"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D24-339933" alt="Node.js 24 or later">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

UniSearch is a unified retrieval CLI for AI agents. It combines model search, web search, page reading, site link discovery, and library or repository documentation lookup.

It connects to model APIs, [Exa](https://exa.ai/), [Tavily](https://www.tavily.com/), [Firecrawl](https://www.firecrawl.dev/), [Context7](https://context7.com/), [Jina](https://jina.ai/), [Zhipu API](https://bigmodel.cn/), [Zhipu MCP](https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server), [AnySearch](https://anysearch.com/), and [TinyFish](https://www.tinyfish.ai/).

## Install

Use Node.js 24 or later and npm on Linux, macOS, or Windows.

```sh
npm install -g unisearch-cli
unisearch --version
```

Ensure `unisearch` is available on the PATH of the process running your agent.

## Configure

Setup runs in an interactive terminal. Choose the connections you need, enter their settings, and optionally install the Skill for your agents. Review the changes before saving.

```sh
unisearch setup
```

After configuring, check local settings or test connectivity:

```sh
unisearch status
unisearch doctor
```

- `status` checks local configuration without making network requests.
- `doctor` runs online checks for enabled services with usable diagnostic settings and may consume quota. Use `unisearch doctor exa` to check only one service.

See [Configuration](docs/en/configuration.md) for all settings, credentials, environment variables, model protocols, and configuration troubleshooting.

## Connect an agent

If you did not install the Skill during setup, install it for selected agents:

```sh
unisearch skills install --targets codex,claude
unisearch skills status --targets codex,claude
```

These examples install the bundled UniSearch Skill under `~/.codex/skills/` and `~/.claude/skills/`. Omit `--targets` during installation to select agents interactively; `skills status` without this option checks all targets. `unisearch skills install --help` lists the supported targets.

`install` creates missing copies and synchronizes existing ones with the package. `status` compares installed copies without changing them. Synchronization replaces the managed Skill directory with the bundled version, including any local edits.

## Upgrade and uninstall

Upgrade the CLI and synchronize installed Skill copies:

```sh
npm update -g unisearch-cli
unisearch skills update --targets codex,claude
```

To remove the Skill copies and uninstall the CLI:

```sh
unisearch skills remove --targets codex,claude
npm uninstall -g unisearch-cli
```

Use the targets you actually installed. Running npm uninstall alone preserves both configuration and Skill copies. To delete configuration as well, locate it with `unisearch config path` before uninstalling and remove that file separately.

## Contributing

See the [contributing guide](https://github.com/ADabbler/unisearch/blob/main/CONTRIBUTING.md) for development and contribution instructions. Report problems through [Issues](https://github.com/ADabbler/unisearch/issues).

## Reference project

UniSearch was rebuilt with reference to [Smart Search](https://github.com/konbakuyomu/smartsearch).

## License

This project is licensed under the [MIT License](LICENSE).
