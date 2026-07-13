# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] — 2026-07-13

First release published through the automated OIDC Trusted Publishing pipeline, so the
npm artifact now carries build provenance (the manually bootstrapped `0.1.0` did not).
No functional changes to the CLI.

### Changed

- README install instructions now reflect the published package
  (`npm install -g @dichovsky/crew`).

## [0.1.0] — 2026-07-13

The first public release of `crew`, a local coordination CLI for terminal coding
agents (Claude Code, Codex CLI, Gemini CLI, Copilot CLI, and Antigravity CLI). crew
never calls a model provider itself — it coordinates independently running sessions
through a workspace-local SQLite database.

### Added

- **Workspace** — `crew init` creates a `.crew/` directory that holds committed
  configuration (Roles, Teams) and ignored runtime state.
- **Agents** — `crew join` / `crew leave` and a heartbeat-based presence model.
- **Messaging** — a shared inbox with at-most-once `receive`, non-consuming
  `pending` summaries, and full history.
- **Tasks** — a reviewed task workflow: a Worker submits, only an Inspector's
  review completes a Task; leases with staleness detection, requeue, and abandon.
- **Launcher** — deterministic launch planning plus a live tmux launcher with
  per-Worker isolated git worktrees and a Relay that nudges idle panes without
  consuming messages.
- **Console** — `crew ui`, a loopback-only web dashboard with live updates and
  Operator actions, including the Now triage view, a light/dark theme, and Agent
  archive/restore.
- **Maintenance** — `crew doctor`, `crew prune`, `crew clean`, and `crew setup`
  with an authoritative per-platform registry covering five Participant CLIs
  (Claude Code, Codex, Gemini, Copilot, Antigravity) and the Ollama / LM Studio
  Model Backends.
- **Safety** — a schema-versioned STRICT SQLite store with in-database invariants,
  defensive connection settings, bounded busy retries, secret redaction, and
  terminal-escape sanitization of all human-facing output.
