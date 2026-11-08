---
name: unisearch
description: Use the UniSearch CLI for current web search, source-backed fact checking, page reading, site link discovery, and official, library, API, or public GitHub repository documentation lookup.
---

# UniSearch

## Use the CLI

Use `unisearch` from PATH. Consult the relevant command's `--help` for options as needed.

- If the default search sources or service configuration are unknown, run `unisearch status --json`. `data.search.providers` lists the sources used when `search` has no `--sources` option; `data.services` reports local configuration status without network checks. When a service includes `operations`, check the target operation's state.
- For configuration tasks, use `unisearch config list --all` to inspect effective settings, including defaults; fields without a value are omitted. Use `unisearch config get KEY` to inspect a field or section.

Common options for retrieval commands:

- `--format json`: Structured output; the default is Markdown.
- `--output PATH`: Save the result to a file instead of stdout.
- `--timeout SECONDS`: Override this call's timeout.
- `--verbose`: Show execution details for diagnosing a request.

## Choose an entry

- `unisearch search QUERY`: Search the default sources reported by `status`. `--sources IDS` replaces the entire default list for this call with the comma-separated IDs. Multiple sources run in parallel.
- `unisearch model search QUERY`: Model-assisted web search; requires supported search tools to be configured.
- `unisearch <service> search QUERY`: Direct service search, such as `unisearch exa search QUERY`.
- `unisearch fetch URL`: Read one page using the configured service order.
- `unisearch map URL`: Discover links within a site, then select pages to read.
- `unisearch ctx7 library NAME QUERY`: If the library ID is unknown, find candidates using the library name and the actual documentation question. Select the matching library and version when relevant.
- `unisearch ctx7 docs LIBRARY_ID QUERY`: Retrieve documentation and code examples using the selected candidate's ID and the documentation question. Skip library lookup when an exact matching ID is already known.
- `unisearch zhipu-mcp docs REPO QUERY`: Query repository documentation. Use `owner/repo`; discover directory and file operations through the group help.
- For multiple URLs, prefer a batch operation when the chosen service supports it, such as `unisearch tavily extract URL...`.

Use `search --sources model,exa` to run model search and Exa together. Model-specific options, such as `--model` and `--effort`, are available only when `model` is selected and apply only to its search.

Use dedicated service commands for service-specific filters, content, cache, or discovery options.

## Choose a service

Choose by task, configured availability, and user preference.

- **Exa (`exa`)**: Natural-language web discovery with category, domain, and publication-date filters; page text, excerpts, and batch URL reading.
- **Tavily (`tavily`)**: General, news, or finance search with date and domain filters; batch content extraction.
- **Firecrawl (`firecrawl`)**: Markdown from dynamic or JavaScript-rendered pages, with control over which content to include.
- **Context7 (`ctx7`)**: Library, framework, SDK, and API documentation or code examples, including specific versions.
- **Jina (`jina`)**: Readable web pages and remote PDFs; web, news, and image search.
- **Zhipu API (`zhipu`)**: Web search and page reading through BigModel or Z.AI. BigModel offers Zhipu, Sogou, and Quark search sources; Z.AI uses Search Prime.
- **Zhipu MCP (`zhipu-mcp`)**: Coding Plan web search, page reading, and documentation, directories, or files from supported public GitHub repositories.
- **AnySearch (`anysearch`)**: General search and vertical search with domain-specific tags and parameters.
- **TinyFish (`tinyfish`)**: Web, news, or paper search with location, language, and paper-year conditions; batch URL reading.
- **DeepSeek (`deepseek`)**: Chinese and multilingual web search with authority and rerank scores plus a long summary; single-page reading.

For AnySearch vertical search, use `unisearch anysearch domains` to find an unknown domain and `unisearch anysearch domains DOMAIN` to discover its tags and parameters. Reuse known definitions; general search needs no domain discovery.

For Zhipu API engine selection, check `unisearch config get providers.zhipu.platform` and consult `unisearch zhipu search --help`.

## Form the query

Keep QUERY self-contained and pass it as one quoted argument. Choose its language for the target sources.

- Model search: Describe the research task in natural language, including relevant context, version, date, or region constraints, and any requirements for the findings' language or structure. The model receives no surrounding conversation.
- Direct service search: Use focused search terms or a concise question. Apply supported filters for date, domain, region, or source-language constraints; consult the operation's `--help` for their scope and limits.
- With multiple sources, the same QUERY goes unchanged to every selected service. Keep it concise and focused on retrieval, within each service's query limits. Use separate model and service calls for longer model instructions or different queries and filters.

Model research request:

```bash
unisearch model search 'Check the current Node.js 24 support schedule using official sources. Summarize its status and key dates.' --format json
```

Shared query with multiple sources:

```bash
unisearch search 'Node.js 24 LTS support schedule end-of-life dates' --sources exa,tavily --format json
```

## Read the result

For JSON results, check the exit code and `status`:

- `success` / `0`: Completed; an empty result can be valid.
- `partial` / `6`: Partially completed.
- `error` / other nonzero codes: Failed.

Both `partial` and `error` may contain usable `data`. Preserve accompanying errors and warnings when using it. The shape of `data` depends on the command.

Check for truncated or missing content even when `status` is `success`.

`meta` may contain model or service switching summaries; `--verbose` adds execution details in JSON output.

For `search` and `model search`, match `data.sources` entries by `provider` and read each entry's `data`. Model entries provide search text in `data.text` and optional references in `data.citations`. Source-specific failures are in `error.details.failures`.

Results from other sources are not passed to the model.

With `--verbose`, `meta.searched_sources` lists additional pages the model searched that are outside its citation list.

Cite source URLs. Read the page when a claim depends on details beyond a search snippet; `map` returns links, not page content.
