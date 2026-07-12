/**
 * Shared renderer for the cross-agent Agent Skills artifact
 * (setup-integration.md §4.2/§4.5). Codex CLI and Antigravity CLI both discover
 * project skills at `<repo>/.agents/skills`, so their `crew` artifacts must be
 * byte-identical: `setup` classifies an existing file only by its marker and
 * content hash, and divergent renders would make the outcome depend on which
 * target ran `setup` first.
 */
import { renderSharedWorkflow, withContentHash } from './shared.js';

/** The one canonical `.agents/skills/crew/SKILL.md` body, shared by both targets. */
export function renderAgentSkillsArtifact(): string {
  return withContentHash(
    'markdown',
    (marker) => `---
name: crew
description: Join and coordinate through the local crew inbox and reviewed task workflow. Use when the user asks to start or act as a crew role.
---

${marker}

Use the finite crew workflow below for the role and optional id supplied by the user.
${renderSharedWorkflow('the role and optional id given after `$crew` (Codex CLI) or `/crew` (Antigravity CLI)')}
`,
  );
}
