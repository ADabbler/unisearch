# Contract fixtures

The TypeScript case tables pair public results with expected output and an explicit renderer. Case names are English so test reports use one language; `tests/contracts.test.ts` checks the Chinese output for each case independently. The `markdown` field describes stdout content; failures without usable data use `stderr`. Expected text is stored as multiline strings beside its input; comparisons ignore trailing whitespace. The optional `details` field checks verbose execution output.

`model-prompt.txt` contains the static search instructions. `tests/model.test.ts` appends a fixed test time after a blank line and checks request construction against `model-requests.json`.

Keep complete cases for meaningful layout and content combinations. Small field variations belong in focused tests near the relevant behavior. Provider request mapping, response conversion, and execution are tested with the local HTTP fixtures.

The fixtures are local examples, not evidence of production provider compatibility. User-facing examples belong in the public documentation.
