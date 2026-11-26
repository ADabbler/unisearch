# UniSearch design overview

[简体中文](../zh-CN/design.md) · [README](../../README.md)

UniSearch sits between callers and retrieval services. It chooses sources, runs requests, and returns results. Search keeps results separate per source; page reading and site discovery try services in configuration order until one completes the operation.

This document explains that behavior and its rationale. See [configuration](configuration.md) for fields, defaults, and overrides, and each command's `--help` for its options.

## Commands and entry points

`search`, `fetch`, and `map` give callers a common entry point for each operation, with shared options for output and timeouts. Features specific to a service come from dedicated commands of the form `unisearch <service ID> <operation>`: `unisearch tinyfish search` filters papers by publication year, `unisearch tavily extract` extracts several pages at once, and the commands for documentation lookup are described in [documentation lookup](#documentation-lookup).

## Unified search

Unified `search` determines sources in one of two ways: it uses a fixed list or selects them from the query. The fixed list comes from the `search.providers` configuration or from `--sources` for one call, and an explicit list takes precedence over automatic selection. See [unified search settings](configuration.md#unified-search) for defaults, overrides, and examples.

With a fixed list, the command checks each source before sending any requests: the service must be enabled with its required settings complete, and the query must stay within that service's known limits, such as DeepSeek's 128-character cap. If any check fails, the command reports an error without sending any search requests.

Once sources are known, UniSearch sends the same query to all of them in parallel and keeps each result set in selection order. Callers can compare what each source found and see which ones failed. When a source fails, the command does not substitute another service for it.

### Automatic source and setting selection

`search --auto` splits source and setting selection into two classification steps. The classifier judges the query against each service's capabilities, and the selected services or models perform the retrieval.

1. **Find candidates.** UniSearch starts from services that support unified search and skips those that are disabled, lack required settings, or have known limits the query exceeds. Invalid settings for a candidate, such as a malformed URL, make the command fail.
2. **Choose sources.** With several candidates, UniSearch sends the query and a description of each service's capabilities to the configured classifier model, which judges how well each source matches the query and, when the configured limit allows more than one, estimates how many are needed. The CLI ranks sources scoring at least `0.7` and takes the suggested number, capped by the configured limit; when fewer sources reach the threshold, it selects fewer than suggested.
3. **Choose settings.** When the selected services support automatic setting selection, UniSearch makes a separate classification call with the query and the current values of each service's choosable settings, and the classifier picks among the allowed options, such as general web or news. Saved search modes, depths, and engines are only preferences that the classifier can override. These settings apply to the current call only.

With a single candidate, the CLI selects it directly and calls the classifier only if settings remain to choose. If there are no candidates, no source reaches the threshold, or classification fails, the command reports an error before sending search requests. See [automatic source selection settings](configuration.md#automatic-search-source-selection) for credentials, the switch, and the source limit.

### Model search

Model search runs on its own or as one source of unified `search`. The model service runs the configured search tools and assembles an answer, with citations when available. When other sources run in parallel, their results go directly to the caller and are not passed to the model.

Model search and the classifier are configured separately. The primary and backup models share an API endpoint and credentials. If the current model is unavailable or returns an invalid response, UniSearch can try backup models in the order listed in [model settings](configuration.md#model-settings).

## Page reading and site discovery

`fetch` handles a known page address and returns page text, excerpts, or metadata depending on the service. `map` starts from an address on a site and discovers other links within it, returning links only and no page content. For example, `map` can locate a guide on a documentation site, and `fetch` can then read the selected page.

Both operations need a single service to complete. Each command tries the order in `fetch.providers` or `map.providers`, skips services that are disabled or incompletely configured, and stops on success. With switching enabled, errors such as rate limits and individual request timeouts move to the next service. When a service reports that the target page returned `401`, `404`, `410`, or `451`, `fetch` stops without switching services, because these statuses mean the page itself cannot be read. `--no-fallback` limits the call to the first available service, which can still retry as configured. See [unified fetch and map settings](configuration.md#unified-fetch-and-map) for the candidate lists.

## Documentation lookup

Context7 (`unisearch ctx7`) handles library and API documentation:

- `search` retrieves documentation for the libraries relevant to a question.
- `library` finds a library ID by name for versioned documentation.
- `docs` reads documentation and examples with a library ID and a question.
- `fetch` reads a known public documentation page and can extract only the passages relevant to a question.

Zhipu MCP (`unisearch zhipu-mcp`) queries public code repositories, identified by `owner/repo`:

- `docs` queries repository documentation.
- `tree` lists repository directories.
- `read-file` reads repository files.

## Timeouts, retries, and cancellation

A retry attempts the same service or model again. UniSearch decides whether to retry from the error, the retry limit, and the remaining time; it honors a valid `Retry-After` from the service and otherwise increases the wait between attempts. A switch moves between candidates and happens in only two places: model search moving to a backup model, and unified `fetch` and `map` moving to the next service in their lists. The retry limit and the switching switch are configured separately.

Classification, retrieval, retry waits, and switching share one time budget. An individual service request is limited to the smaller of the total limit and that service's per-request cap, and timeout errors use `error.details.timeout_scope` to state whether the request or the whole call expired. A user interruption stops in-flight requests immediately; the call is reported as cancelled and returns any data obtained so far.

Streaming model requests are timed differently: the model service must return the first text within the total limit; after that, each new piece of model text resets the timer, and the request times out only when no new text arrives within the configured duration. Heartbeats and tool progress do not count. A request that keeps returning text can therefore outlast the initial total limit, while other sources in the same search remain bound by it. Once text starts arriving, an interrupted answer fails the model task without retries or model switching. See [execution settings](configuration.md#execution) for the configuration.

## Results and output

`search` and `model search` both return results grouped by source. If the only source queried fails, the command preserves its error code. A search across multiple sources reports failures by source and keeps any results it obtained.

| `status`  | Exit code           | Meaning                                                                                                                |
| --------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `success` | `0`                 | The command completed. A search can have no hits.                                                                      |
| `partial` | `6`                 | Part of the call failed. The result includes data and an error.                                                        |
| `error`   | Other nonzero value | The call failed. It can still include material obtained before the failure. Check errors and warnings before using it. |

For `error`, the exit code gives the failure category: `2` for command or argument errors, `3` for configuration, authentication, or permission errors, `4` for network, timeout, rate limit, quota, or upstream failures, `5` for local file or internal errors, and `130` for user interruption. The specific cause of each error appears in `error.code` and `error.message`.

Retrieval commands return Markdown by default; `--format json` returns structured results. Page reading identifies the service that returned the content, and truncated text or incomplete extraction is recorded in `warnings`.

`--output PATH` writes the result to a file instead of standard output. Successful calls and failures that carry data write the file; a failure with no data to save, or a cancelled call, writes nothing, leaves the existing file unchanged, and sends the result to standard output instead. A saved file can still contain a partial success or material obtained before a failure, so check the exit code. When a model or service switch occurs, `meta.model_fallbacks` or `meta.service_fallbacks` records both sides and the reason. `--verbose` reports each attempt's service or model, duration, HTTP status, error code, and retry wait. JSON places them in `meta`, and Markdown writes them to standard error.
