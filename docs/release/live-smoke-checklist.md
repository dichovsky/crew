# Release live-smoke checklist (Gates 2 & 3)

The maintainer works through this checklist before publishing `crew`. It covers the
**interactive / credentialed** steps — the ones that need a human at the keyboard or
real credentials, which automated CI on a fork cannot run. The **automated** part (each
CLI's `--version`, the content-hash of each generated file, and the prerequisite checks)
is captured by the recorder into `artifacts-<date>.json`:

```sh
npm run build
CREW_RELEASE_SMOKE=1 npx vitest run tests/tools/release-smoke.test.ts
```

Run every interactive step in a **clean, throwaway `HOME`** directory, so nothing reads
or writes your real configuration, e.g.:

```sh
export HOME="$(mktemp -d)"      # throwaway home for the smoke session
```

For each checkbox below, record the outcome (pass or fail, plus the version tested and
the date) alongside the generated `artifacts-<date>.json`. If a minimum version changes,
update the platform registry's `minimumVerifiedVersion` / `verifiedOn`.

## Gate 2 — Participant CLI matrix (eight CLIs, pinned minimum versions)

For each of **Claude Code**, **Codex CLI**, **Gemini CLI**, **Copilot CLI**,
**Antigravity CLI**, **Pi CLI**, **Little Coder**, **opencode CLI**:

- [ ] `crew --version` matches the package version being released.
- [ ] crew's registry version probe is at or above `minimumVerifiedVersion`
      (`crew doctor --system` shows no `VERSION_FLOOR` warning). Most targets use
      `<cli> --version`; Little Coder reads its adjacent npm package metadata because its
      wrapper reports the bundled Pi version.
- [ ] `crew setup <id>` generates the CLI's skill/config file with no error, and the
      `content-hash` marker inside the generated file matches the recorder's
      `artifact_content_hash`.
- [ ] Start the CLI, invoke the crew skill/command it installed, and confirm it can run
      a **scoped, bounded** crew command (`crew doctor`, `crew join …`) — the permission
      you grant must cover only crew commands, not all shell commands, and must never be
      `--dangerously-skip-permissions`.
- [ ] **Copilot specifically:** confirm that the installed Copilot version accepts the
      scoped shell-rule syntax `--allow-tool='shell(crew:*)'` and that the grant is
      limited to `crew` commands.
- [ ] **opencode specifically:** confirm the `permission.bash` allowlist
      `{ "*": "ask", "crew *": "allow" }` in `opencode.json` auto-approves only `crew`
      commands (catch-all listed first, last-match-wins); do not enable `--auto`.
- [ ] **Pi specifically:** pi has no permission model, so confirm scoping comes from the
      Workspace/OS boundary — there is no scoped-approval flag and no bypass flag to avoid.
- [ ] **Little Coder specifically:** with any existing custom prefixes preserved, export
      `LITTLE_CODER_BASH_ALLOW="${LITTLE_CODER_BASH_ALLOW:+$LITTLE_CODER_BASH_ALLOW,}crew "`;
      confirm `crew doctor` is allowed while an unrelated non-whitelisted command remains
      blocked. Confirm the installed package is 1.11.0 even though `little-coder --version`
      prints Pi's version. Never use `LITTLE_CODER_PERMISSION_MODE=accept-all`.
- [ ] **Pi, Little Coder, and opencode readiness:** in a launched pane, read
      `tmux display -p '#{pane_current_command}'`; if it cleanly reports `pi`,
      `little-coder`, or `opencode`,
      tighten that target's `readinessMode` from `not-shell` to `names`.

## Gate 3 — Model Backend recipes (Ollama, LM Studio)

For each of **Ollama** and **LM Studio**:

- [ ] `crew setup <backend>` prints the recipe and its prerequisite checks pass (the
      `server` is reachable and a model that can make tool calls is available) — the
      recorder's `checks` for this backend are all `ok`.
- [ ] Point a supported Participant CLI at the backend and run a **tool-call smoke**:
      confirm, end to end, that the local model, working through the Participant CLI,
      successfully runs a `crew` command (for example, it joins and reads its inbox).

## Sign-off

- [ ] `artifacts-<date>.json` is committed under `docs/release/`.
- [ ] The gate statuses in the release-gate table in `docs/design/product-spec.md` are
      updated (Gates 2 & 3 closed).
- [ ] The release is published: `0.1.0` was a one-time manual `npm publish`; for
      `0.1.1`+ the maintainer publishes a GitHub Release, which runs `publish.yml` and
      publishes via npm OIDC Trusted Publishing (no long-lived npm secret in CI). See
      [publishing.md](./publishing.md).
