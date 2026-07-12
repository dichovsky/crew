---
status: accepted
---

# Track Crew configuration and ignore only runtime state

Roles (behavior prompts for Agents), Teams (roster templates), launcher configuration, and Task
briefs are project inputs the whole team works on together, so they belong in version control
under `.crew/`. Only the two subdirectories crew itself writes at runtime — `state/` and
`generated/` — are ignored by git. If the entire `.crew/` tree were ignored, the advertised
features that depend on sharing config through the repository (project-level overrides and
shared Teams) could not work.

The ignore rule lives in `.crew/.gitignore` (entries `state/` and `generated/`, applied
relative to `.crew/`), not in the repository's root `.gitignore`. This keeps every file that
`init` writes inside the `.crew/` tree it manages — `init` never touches a file the user owns
at the repository root, with one exception: the explicit `--with-guides` opt-in — and it makes
the workspace self-contained and easy to move. Which paths are ignored, and the guarantee that
`.crew/` is never ignored as a whole, are unchanged; only where the rule lives differs from the
original sketch, which placed it in the root `.gitignore`.
