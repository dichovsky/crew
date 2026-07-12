---
status: accepted
---

# Generate setup and launch behavior from one platform registry

Each Participant CLI (a terminal AI application such as Claude Code or Codex CLI that takes
part in a Crew) has its own install path, launch command syntax, executable name, permission
guidance, and readiness check — and each of these facts changes on its own schedule. One
platform registry must be the single source of those facts, feeding `setup`, `doctor`, Team
display, and the Launcher's pane commands alike. If each module kept its own copy in a static
template, the copies would inevitably drift apart. Facts about the official platforms are
verified against each release; the recipes for local model backends never rewrite a third
party's configuration without saying so.
