# AGENTS.md

## Implementation

- Base changes on confirmed requirements or reproducible defects. Inspect the relevant code and tests before editing; clarify requirements or acceptance criteria when they are unclear.
- Keep normal execution paths simple and complete. Reuse existing implementations, dependencies, and platform conventions; add custom logic or abstractions only when requirements justify them.
- Validate external inputs where they enter the system. Trust established internal types; do not add redundant validation or recovery paths for hypothetical failures.
- Expose failures explicitly and fix their causes. Do not swallow errors, silently degrade behavior, or use defaults or success results to conceal invalid data.
- Deliver complete, runnable code. Remove dead code and obsolete compatibility branches; preserve backward compatibility only when explicitly required.

## Code Conventions

- Use strict TypeScript and ESM with NodeNext resolution. Relative imports use `.js` extensions; type-only imports use `import type`.
- Edit source files and rebuild. Do not hand-edit or commit generated files under `dist/` or `.test-build/`.
- Route interface text through the existing typed messages in `src/i18n/`, maintaining Chinese and English together. Preserve provider content in its original language.
- Keep filesystem and subprocess behavior portable across Linux, macOS, and Windows. Use Node path utilities and pass subprocess arguments as arrays.

## Commands

Use Node.js 24 or newer and npm. Install locked dependencies with `npm ci --ignore-scripts`.

- `npm run typecheck`: Type-check source and tests without emitting files.
- `npm run build`: Compile source into `dist/`.
- `npm test`: Clean build outputs, compile source and tests, and run `node:test`.
- `npm run format:check`: Check repository formatting with Prettier.
- `npm run check:package`: Build, inspect package contents, and verify an isolated installation.
- `npm run check`: Run the complete CI check sequence.

## Verification

- Match checks to the changed behavior and risk. Cover normal flows, confirmed boundaries, and reproducible defects; update affected output fixtures when behavior changes.
- Use temporary configuration and local fixtures for automated tests. Real provider calls require explicit authorization; never use personal credentials or configuration implicitly.
- Run relevant checks before delivery. Include package verification when changing distributed files or installation behavior; use the full check sequence for changes spanning the repository.
- Report only checks actually run and any remaining gaps. Repeat passing checks only when subsequent changes or unresolved concerns warrant it.

## Documentation and Comments

- Write for the intended reader, using terminology and detail appropriate to their task.
- Replace outdated descriptions directly and update both language versions of affected documents. Keep current behavior and necessary explanations; omit session narration, editing history, and appended corrections or change summaries.
- Document non-obvious behavior, failure conditions, and constraints where readers need them. Do not restate code or duplicate explanations across files.

## Git

- Commit or push only when explicitly requested.
- Keep each commit cohesive and verifiable. Split unrelated changes; include the code, tests, and documentation needed for the same goal together.
- Before committing, review the diff and inspect `git log -n 5 --oneline` for the repository's message style. Use `<type>(<scope>): <description>` by default.
