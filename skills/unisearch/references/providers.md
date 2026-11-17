# Provider guide

## Search

General web search can discover news, papers, and documentation. Choose specialized modes when their source scope or result format helps the task.

- `model`: Search and information synthesis through the configured model, returning findings and available references. Retrieval scope depends on the search tools available to the configured model.
- `exa`: Semantic and natural-language discovery of research, technical documentation, companies, and products. Categories include companies, scholarly publications, news, personal sites, financial reports, and people. Returns ranked links, titles, and query-relevant excerpts.
- `tavily`: Factual lookup and source discovery across general, news, or finance topics. Returns links and relevant snippets or summaries. Supports date and domain filters, language preference, and cache freshness controls.
- `firecrawl`: General web discovery, research websites and PDFs, a developer index for repository material and documentation, or US federal, state, and local government publications. Returns relevant passages when available, otherwise summaries. The default search country is US.
- `jina`: Web, news, or image discovery returning result links and descriptions.
- `zhipu`: Web discovery returning linked titles and summaries. See engine selection below.
- `zhipu-mcp`: Web search through GLM Coding Plan, returning result links and summaries.
- `anysearch`: General search routes by intent, combines sources, and reranks results. Returns links and available snippets or cleaned content. Dedicated commands also support vertical search through discovered tags and parameters.
- `tinyfish`: Web, news, or research-paper search with structured titles, links, and snippets. Paper results may include authors, venue, year, and citation counts. Supports location, language, and paper-year conditions; the default locale is US/en.
- `deepseek`: Multilingual web retrieval with query-focused long summaries, links, and provider-supplied authority and rerank scores. Supports `site:`, `lang:`, `after:`, and `before:` query operators; queries are limited to 128 Unicode characters.

Exa's `auto` mode balances quality and speed; `lite` uses indexed page content for low-latency search, without fetching pages live. `deep-lite` and `deep` offer lightweight and comprehensive research respectively.

Tavily's `basic` balances relevance and latency; `advanced` prioritizes detailed, high-precision retrieval at higher latency. `fast` prioritizes lower latency, and `ultra-fast` minimizes latency and returns one NLP summary per URL. Each search request costs 2 Tavily API credits with `advanced`, or 1 with `basic`, `fast`, or `ultra-fast`.

Firecrawl's `research` category returns pages from research websites. For structured paper metadata, consider TinyFish's paper search. Combine `research` and `pdf` when both scopes are useful; use `developer` or `gov` alone. Their filter and content restrictions are documented in `--help`.

### AnySearch vertical search

Use `unisearch anysearch domains` to find an unknown domain, then `unisearch anysearch domains DOMAIN` to discover its full tags and parameter definitions. Check conditional requirements as well as required fields. Reuse known definitions; general search needs no domain discovery.

### Zhipu platforms and engines

Read `platform` from the relevant `zhipu` or `zhipu-mcp` entry in `data.services` returned by `unisearch status --json`. For `zhipu`, choose an engine for that platform:

- `bigmodel`: `search_std` serves everyday web queries at a lower published per-request price than the pro engines. `search_pro` combines multiple engines. `search_pro_sogou` includes Tencent News, Penguin accounts, and Zhihu; `search_pro_quark` uses Quark's web-search source.
- `zai`: Uses `search-prime`.

Engine choice affects supported result counts and filters. Consult `unisearch zhipu search --help` before combining them.

## Read pages and discover site links

Use `unisearch fetch URL` for a known page and `unisearch map URL` for site links. Search locates sources; map results still need to be fetched for their content.

- `exa`: Batch URL reading with page text and query-relevant excerpts.
- `tavily`: Extract page content from multiple URLs with `extract`; discover links within a site with `map`.
- `firecrawl`: `scrape` for Markdown from dynamic or JavaScript-rendered pages; `map` for site links.
- `jina`: Reader access to web pages and remote PDFs.
- `zhipu` / `zhipu-mcp`: Single-page reading through their respective services.
- `anysearch`: URL content extraction.
- `tinyfish`: Batch URL reading.
- `deepseek`: Single-page reading.

## Documentation

- `ctx7`: Library, framework, SDK, and API documentation or code examples, including specific versions; public-page reading focused on a documentation question.
- `zhipu-mcp`: Documentation questions, directories, and files from supported public GitHub repositories. Start with `unisearch zhipu-mcp docs owner/repo QUERY`; consult group help for `tree` and `read-file`.
