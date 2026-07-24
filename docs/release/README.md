# Release evidence

This directory holds the evidence files the maintainer produces when releasing `crew`
(release Gates 2 & 3 in [product-spec.md](../design/product-spec.md#release-gates)).
None of it ships in the npm package — the package's `files` allowlist contains only
`dist`, `README.md`, and `LICENSE`.

## Contents

- **`live-smoke-checklist.md`** — a step-by-step manual checklist for the steps that
  need a human at the keyboard or real credentials, which automated CI on a fork cannot
  do: granting each Participant CLI a narrowly scoped permission, checking the Copilot
  `--allow-tool='shell(crew:*)'` syntax, and a smoke test (a quick end-to-end check that
  the basics work) in which a local model behind Ollama / LM Studio runs a crew command
  through a Participant CLI.
- **`artifacts-<date>.json`** — the file the automated recorder writes
  (`tests/tools/release-smoke.test.ts`, run with `CREW_RELEASE_SMOKE=1`). For each
  target in the platform registry it records the version its registry probe found,
  whether that version meets the pinned `minimumVerifiedVersion`, the `content-hash` of
  the generated file, and a pass/absent/below-floor result. Most probes run
  `<cli> --version`; Little Coder reads its adjacent package metadata because its wrapper
  reports bundled Pi's version. For each Model Backend the recorder stores prerequisite
  check results. It records only registry facts that are not secrets.

## Regenerating the automated capture

```sh
npm run build
CREW_RELEASE_SMOKE=1 npx vitest run tests/tools/release-smoke.test.ts
```

Then follow the [release runbook](./publishing.md): work through
`live-smoke-checklist.md`, commit the dated evidence file, and update the gate statuses
in the [release-gate table](../design/product-spec.md#release-gates).
