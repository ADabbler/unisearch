# Contributing

[简体中文](CONTRIBUTING.zh-CN.md) · [README](README.md)

## Development setup

Use Node.js 24 or later and npm. Install dependencies and run the CLI from the repository directory:

```sh
npm ci --ignore-scripts
npm run dev -- --help
```

`npm run dev -- <arguments>` builds the source, then passes the arguments to the CLI. To build without running the CLI, use `npm run build`.

`dist/` and `.test-build/` contain generated files; do not edit or commit them.

## Code organization

- `src/cli.ts` loads the package version and runs the CLI. `src/cli/` defines commands, help, and terminal prompts.
- `src/config/` defines fields and resolves, queries, and saves configuration. `src/i18n/` owns interface language and typed Chinese/English messages.
- `src/search.ts` combines model and supplementary searches. `src/retrieval.ts` selects and switches services for unified fetch/map.
- `src/execution.ts` manages request deadlines, retry waits, cancellation, and execution records. `src/providers/` constructs provider requests and interprets responses.
- `src/result.ts` and `src/errors.ts` define results and failures. `src/output/` renders results and delivers them to streams or files.
- `src/setup.ts`, `src/doctor.ts`, and `src/skills/` implement interactive configuration, online diagnostics, and Skill copy management.
- `tests/` contains Node tests and fixtures. `scripts/check-package.mjs` verifies the distributed package through an isolated installation.

Commands resolve the configuration they need before running an operation. Model and supplementary searches run in parallel and retain separate results. Unified fetch/map tries configured candidates in order. Both paths use the shared request executor, then present results through the output module.

## Checks

- `npm run typecheck`: Check source and test types without emitting files.
- `npm run format:check`: Check formatting. Use `npm run format` to format the repository, or invoke the local Prettier binary on the files you changed.
- `npm test`: Clean generated outputs, compile source and tests, and run the Node test suite.
- `npm run check:package`: Build and verify package contents, installation, upgrades, and preservation of configuration and Skills after uninstalling.
- `npm run check`: Run the complete formatting, type, test, and package checks used by CI.

Choose checks that cover the change. Run `npm run check:package` for changes to dependencies, command entry points, packaged resources, or installation behavior. CI runs the complete check sequence on Linux, macOS, and Windows with Node.js 24.

Automated tests require no live service credentials. They use mock responses, local HTTP servers, and temporary directories without reading personal configuration or calling live services. When writing tests, reuse the helpers in [tests/helpers.ts](tests/helpers.ts) and the service fixtures under `tests/`. If you verify a change against a live service, include the service, operations, and results in your PR.

`npm run check:package` packs and installs in a temporary directory, then prints the verified package path. To build and create a `.tgz` package without running the checks, use `npm pack`.

## Changes and pull requests

For bug fixes, add a test that reproduces the problem. When adding or changing features, update the relevant tests and documentation.

Source and tests use strict TypeScript with ESM and NodeNext resolution. Relative imports use `.js` extensions and type-only imports use `import type`. Use Node.js path utilities and pass subprocess arguments as arrays to support Linux, macOS, and Windows.

For a provider change, review its configuration fields, command definitions, request construction, response handling, output rendering, and relevant tests together. Keep provider-specific logic in its module and reuse the request executor for common request behavior. New interface text belongs in both language versions of `src/i18n/` messages.

Update both [English](docs/en/configuration.md) and [Chinese](docs/zh-CN/configuration.md) configuration references when settings change. When adding or removing packaged files, update `files` in `package.json` and the package-check allowlist together.

Keep each commit focused on one change and use `<type>(<scope>): <description>` for commit messages. Describe the problem, resulting behavior, and checks you ran in the PR so maintainers can reproduce and review the change.

When reporting a problem through [Issues](https://github.com/ADabbler/unisearch/issues), include the UniSearch and Node.js versions, operating system, reproduction steps, expected results, and actual results.
