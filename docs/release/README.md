# Release evidence

This directory is where the evidence for release Gates 2 & 3
([product-spec.md](../design/product-spec.md#release-gates)) is kept: the checklist the
maintainer works through, and the dated capture each release deposits beside it. None of
it ships in the npm package — the package's `files` allowlist contains only `dist`,
`README.md`, and `LICENSE`. Which releases actually have a retained capture is recorded
under [Retained evidence](#retained-evidence) below.

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

## Retained evidence

One row per published release. A release with no committed `artifacts-<date>.json` is
recorded as such here rather than left as a silent gap.

| Release | Published | `artifacts-<date>.json` |
|---|---|---|
| `0.1.0` | 2026-07-13 | not retained |
| `0.1.1` | 2026-07-13 | not retained |

Neither gap is back-fillable. The capture records the versions the recorder's probes
found on the maintainer's machine **at the moment it ran**; a capture made today would
describe today's machine, not either release, so writing one and dating it backwards
would manufacture evidence rather than recover it. The requirement itself stands — the
[release-gate table](../design/product-spec.md#release-gates) is the canonical gate list
and this directory does not narrow it — and step 4 of the
[release runbook](./publishing.md) commits the capture and its row from the next release
onward.

## Regenerating the automated capture

```sh
npm run build
CREW_RELEASE_SMOKE=1 npx vitest run tests/tools/release-smoke.test.ts
```

Then follow the [release runbook](./publishing.md): work through
`live-smoke-checklist.md`, commit the dated evidence file and its
[retained-evidence](#retained-evidence) row, and update the gate statuses in the
[release-gate table](../design/product-spec.md#release-gates).
