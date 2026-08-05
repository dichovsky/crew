import { facts } from '../facts';
import { Explorer, Note, Section } from '../kit';

/**
 * The support matrix. Every value here is read from facts.json, which
 * tests/unit/docs-facts.test.ts derives from src/platforms/registry.ts — the
 * authoritative registry ADR-0006 forbids duplicating.
 */
export function Participants() {
  const { participants, backends, revision } = facts.registry;

  const items = [
    ...participants.map((target) => ({
      id: target.id,
      label: target.id,
      detail: (
        <dl class="spec">
          <dt>Executable</dt>
          <dd>
            <code>{target.executable}</code>
          </dd>
          <dt>Lowest verified version</dt>
          <dd>{target.minimumVerifiedVersion ?? 'not pinned'}</dd>
          <dt>Verified on</dt>
          <dd>{target.verifiedOn}</dd>
          <dt>Global config</dt>
          <dd>
            <code>{target.userPath}</code>
          </dd>
          <dt>Project config</dt>
          <dd>
            <code>{target.projectPath}</code> ({target.format})
          </dd>
          <dt>Start command</dt>
          <dd>
            <code>{target.invocation}</code>
          </dd>
          <dt>Permissions</dt>
          <dd>{target.permissionNote}</dd>
          <dt>Official sources</dt>
          <dd class="spec-links">
            {target.officialSources.map((href) => (
              <a key={href} href={href} target="_blank" rel="noreferrer">
                {href}
              </a>
            ))}
          </dd>
        </dl>
      ),
    })),
    ...backends.map((target) => ({
      id: target.id,
      label: target.id,
      detail: (
        <dl class="spec">
          <dt>Kind</dt>
          <dd>
            Model Backend — a local model server a Participant CLI may use. crew itself never
            contacts it, and it is never an Agent.
          </dd>
          <dt>Executable</dt>
          <dd>
            <code>{target.executable}</code>
          </dd>
          <dt>Lowest verified version</dt>
          <dd>{target.minimumVerifiedVersion ?? 'not pinned'}</dd>
          <dt>Verified on</dt>
          <dd>{target.verifiedOn}</dd>
          <dt>Official sources</dt>
          <dd class="spec-links">
            {target.officialSources.map((href) => (
              <a key={href} href={href} target="_blank" rel="noreferrer">
                {href}
              </a>
            ))}
          </dd>
        </dl>
      ),
    })),
  ];

  return (
    <Section
      title="Supported Participant CLIs"
      lede={
        <>
          crew supports <strong>{participants.length}</strong> Participant CLIs and{' '}
          <strong>{backends.length}</strong> local Model Backends (registry revision {revision}).
          Every value on this page is extracted from the platform registry at build time rather than
          written down here — select a target for its exact paths, versions, and start command.
        </>
      }
      sources={[
        { path: 'src/platforms/registry.ts', label: 'The authoritative registry' },
        { path: 'docs/design/setup-integration.md', label: 'Setup integration matrix' },
        { path: 'docs/adr/0006-platform-registry-is-authoritative.md', label: 'ADR-0006' },
      ]}
    >
      <Explorer items={items} emptyHint="Select a target to see its registry record.">
        {(selected, select) => (
          <div class="matrix">
            <div class="matrix-group">
              <h3>Participant CLIs — join a Crew as Agents</h3>
              <div class="chips">
                {participants.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    class={`chip chip-accent${selected === target.id ? ' is-selected' : ''}`}
                    aria-pressed={selected === target.id}
                    onClick={() => {
                      select(target.id);
                    }}
                  >
                    {target.id}
                  </button>
                ))}
              </div>
            </div>
            <div class="matrix-group">
              <h3>Model Backends — never Agents</h3>
              <div class="chips">
                {backends.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    class={`chip${selected === target.id ? ' is-selected' : ''}`}
                    aria-pressed={selected === target.id}
                    onClick={() => {
                      select(target.id);
                    }}
                  >
                    {target.id}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </Explorer>

      <Note kind="limit">
        The start command is not a literal <code>/crew</code> everywhere: Claude and Gemini use{' '}
        <code>/crew</code>, Codex uses <code>$crew</code>, and in Copilot you run{' '}
        <code>/agent</code>, pick crew, then type the prompt. In v1 the automatic launcher starts
        every pane with the same single Participant CLI; a mixed Crew is run by hand.
      </Note>
    </Section>
  );
}
