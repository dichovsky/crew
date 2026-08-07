# Release & publishing runbook

How `@dichovsky/crew` is released to npm. This is the end-to-end procedure; the
credentialed matrix detail lives in [live-smoke-checklist.md](./live-smoke-checklist.md)
and the canonical gate list in
[product-spec.md](../design/product-spec.md#release-gates).

## Publishing model

- **`0.1.0` (first release) — done manually.** npm's OIDC Trusted Publishing can only
  attach to a package that already exists, so the first-ever publish cannot use OIDC
  (the "publisher bootstrap" problem — see [npm/cli#8544](https://github.com/npm/cli/issues/8544)).
  `0.1.0` was therefore published once by hand with an authenticated `npm publish`. It
  does not carry CI-generated provenance.
- **`0.1.1` onward — automated via OIDC.** Publishing a GitHub Release runs
  [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml), which
  authenticates to npm with a short-lived OIDC token (no `NPM_TOKEN` secret in CI) and
  publishes with provenance. The trusted publisher is configured on npmjs.com against
  this repository and the workflow file `publish.yml`, permitting `npm publish` /
  `npm stage publish`.

## One-time setup (already completed for 0.1.0)

1. **Bootstrap publish.** From the exact release commit on `main`:
   ```sh
   npm run build
   npm publish --access public      # authenticated via `npm login` or a granular token
   ```
2. **Configure the trusted publisher** on npmjs.com → package `@dichovsky/crew` →
   *Settings → Trusted Publisher*: provider **GitHub Actions**, repository
   `dichovsky/crew`, workflow filename **`publish.yml`**. (An optional GitHub
   *Environment* may be named here; if you do, add a matching `environment:` to the
   workflow's `publish` job, or the OIDC claims will not match.)

## Cutting a release (every version, including re-cutting `v0.1.0`)

1. **Prove the gate is green on `main`** (CI must be passing).
2. **Regenerate the automated release-smoke record** (needs the real Participant CLIs
   installed):
   ```sh
   npm run build
   CREW_RELEASE_SMOKE=1 npx vitest run tests/tools/release-smoke.test.ts
   ```
3. **Work through [live-smoke-checklist.md](./live-smoke-checklist.md)** in a throwaway
   `HOME` — all eight Participant CLIs (Claude Code, Codex, Gemini, Copilot, Antigravity,
   Pi, Little Coder, opencode) at their pinned minimum versions, plus the Ollama and LM Studio Model-Backend
   tool-call smokes.
4. **Commit the evidence:** `docs/release/artifacts-<date>.json`, and update the gate
   statuses in the [release-gate table](../design/product-spec.md#release-gates). Its
   [retained-evidence](./README.md#retained-evidence) row is written at step 7, once
   there is a published release to record.
5. **Bump the version and refresh the release status** — all three in the same commit:
   - `package.json`: the new version.
   - `CHANGELOG.md`: move items out of `[Unreleased]` into a dated section.
   - [`docs/README.md`](../README.md), **Current readiness**: name the new version as the
     current published release. That section is the single source of truth for release
     status, so nothing else records it — and nothing checks it, since it is free text.
     The `[Unreleased]` move above is also the moment to re-check that section's feature
     claims against what the release actually ships; the two rot together.

   Merge to `main`.
6. **Publish the GitHub Release** with tag `vX.Y.Z` at the release commit (release notes
   from the changelog). This triggers `publish.yml`:
   - it verifies the tag matches `package.json`, runs the full gate, then
   - **preflights npm:** if `X.Y.Z` is already published it **skips** the publish step
     and exits green; otherwise it publishes with provenance via OIDC.
   > Re-cutting `v0.1.0` is safe: the preflight sees `0.1.0` already on npm and skips,
   > so the Release still validates the pipeline end-to-end without a double publish.
7. **Verify the result, then record it:**
   ```sh
   npm view @dichovsky/crew version dist-tags
   npm install -g @dichovsky/crew && crew --version
   ```
   For OIDC publishes, confirm the provenance badge/attestation on the npm package page.
   - **If it published:** add the release's row to the
     [retained-evidence record](./README.md#retained-evidence), dating it from
     `npm view @dichovsky/crew time --json`. This is the first point at which a
     `Published` date exists, so it is the only point at which the row may be written.
   - **If it did not:** the step-5 readiness update now names a version that is not
     published. Revert that paragraph in [`docs/README.md`](../README.md) before anything
     else — leaving it is exactly the drift step 5 exists to prevent.

## Notes

- No npm secret is ever stored in CI. The first publish used a credential on the
  maintainer's machine only; every subsequent publish uses a short-lived OIDC token.
- A pre-release GitHub Release publishes under the `next` dist-tag, so betas/RCs never
  displace `latest`.
- **Hardening follow-up (optional, not blocking):** the `publish` job carries
  `id-token: write` for the whole job, so the OIDC-token environment is present during
  `npm ci` / build / test. To shrink that surface, split into a `build` job (no
  `id-token`) that uploads the built artifact and a minimal `publish` job that alone
  holds `id-token: write`. Deferred because the split has to carry `dist/` across the job
  boundary itself: there is **no** `prepack`/`prepublishOnly` hook — it was removed so each
  publish path builds exactly once from a visible step — so nothing rebuilds during
  `npm publish`. A `publish` job that neither runs `npm run build` nor downloads the
  `build` job's artifact packs a tarball with **no `dist/`**, and npm reports the missing
  `bin` target as a warning rather than an error, so that publish exits **0** and
  irreversibly ships a code-less version to `latest`. Any split must therefore restore
  `dist/` in the publishing job and assert it is there before publishing. The current
  single-job shape matches npm's documented trusted-publishing example and cannot fail
  that way.
- `1.0.0` is reserved for a later stability milestone, once the CLI and Store contracts
  are declared stable.
