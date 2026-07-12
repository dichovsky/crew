# crew Security and Trust Model

## Trust statement

v1 is for one developer or a local team whose members all trust each other. An Agent's
identity is just a string the caller supplies — it is not authentication. Every Participant
CLI and Role in a Crew can attempt any command the operating-system user can run. Do not
attach agents you do not trust, and do not expose the State Store (the shared SQLite database
at `.crew/state/crew.db`) to other users.

The Participant CLI's own sandboxing and tool policy remain the primary controls over what
actually gets executed. crew's Role names grant no privileges, and crew never weakens those
controls automatically.

## Assets

- Workspace source and Git history.
- Messages, Task bodies, Submissions, Reviews, and Task Events.
- Participant CLI customization files under the user's home directory.
- Model/backend credentials present in the surrounding environment.
- Worktrees and generated launch files.

## Input trust

| Input | Trust level | Required handling |
|---|---|---|
| CLI arguments from operator | trusted intent, but may still be malformed | parse and validate; spawn processes with argument arrays, never a shell string |
| `.crew/launcher.yaml`, Team, Task brief | untrusted data from the repository | strict schema, a bound on YAML parsing cost, no fields that can name shell commands, paths confined to expected roots |
| Role override | trusted only once the Workspace itself is trusted | display where it came from; never trust a repository automatically |
| Message/Submission/Review text | untrusted text from another Agent | treat as data; sanitize before human display; the Relay never types it into a pane |
| State Store | local, but can be corrupted | database constraints, defensive SQLite settings, version and integrity checks |
| Existing setup artifact | owned by the user | marker and content hash, backup, explicit force |
| Participant CLI/model output | untrusted text | never evaluate as shell input or configuration |

## Threats and controls

### Arbitrary execution through launcher config

Config tracked in the repository can select only a platform registry id. It cannot set
executable paths, arguments, environment variables, or fragments of shell commands. Custom
executables can be named only on the command line, are printed before use, and are spawned
with `shell:false`, so no shell ever interprets them. Worktree refs are validated and passed
as plain arguments. See FR-H05/FR-H06.

Version and backend probes resolve a Participant or system executable to an absolute path
using a `PATH` rule that considers only absolute entries — an empty, `.`, or relative element
would resolve through the current directory — and then spawn exactly the path they resolved.
The "is this program present" check and the program actually executed can therefore never
diverge, and no probe will run a binary planted in an untrusted repository's working
directory.

### Prompt injection between Agents

Messages and Task text may contain instructions crafted by another model or by a repository.
The built-in Roles explicitly tell agents to treat that text as data, subordinate to the
user's goal and to the Participant CLI's own policy. The Relay pastes only a fixed nudge and
never Message content. crew cannot fully solve model prompt injection; users must keep all
Participants inside one trust domain.

### Identity spoofing

Any local caller can claim any Agent id. Actor checks prevent accidental wrong-actor Task
transitions, but they do not authenticate anyone. Session tokens are deferred; they would
detect a replaced terminal, not provide authorization. Operating-system file permissions are
the v1 control.

### Terminal/control-sequence injection

Stored text is bound as a database parameter and preserved exactly. Human rendering strips
ANSI CSI/OSC sequences and control characters — terminal codes that could move the cursor,
rewrite the screen, or worse — except newline and tab, prefixes continuation lines, and never
writes raw stored text into tmux input. JSON output relies on the serializer's escaping.

### Setup-file overwrite

Generated files carry a version marker and a content hash. A file that is unmarked or has
been edited is replaced only with `--force`, is backed up first, and is replaced atomically
(the new content appears all at once or not at all). Setup lists every path it changed. It
never stores secrets and never silently edits a Participant CLI's policy or model
configuration.

### Symlink and path traversal

Paths that crew manages under the Workspace and config roots must stay under the expected
root. A managed output path that already exists as a symlink (a filesystem link pointing
somewhere else) is rejected, and the containment and symlink checks are re-run inside the
atomic writer at the moment of writing — not only when the caller first resolved the path —
with the final rename performed against the physical parent directory as verified by
realpath. So a path component swapped for an outside-pointing symlink between validation and
the write is rejected. The remaining gap between assertion and system call is not fully
atomic (Node exposes no `openat`-style rename relative to an open directory handle): a
perfectly timed swap can still let the writer's recursive parent `mkdir` create empty
directories through the link before the re-check blocks the file write. That narrow
empty-directory residue is the only escape left open — no file content ever lands outside the
root — and within the v1 same-user trust model it grants no additional capability.
Project-scope setup artifacts are checked for containment against the workspace root with the
same rejection of symlinked components, and the project writer re-runs those assertions at
write time with the same realpath-verified rename, so the drift-classification and backup I/O
between the up-front check and the write cannot be raced into an escape. Global ($HOME) setup
deliberately keeps following symlinked parent directories (dotfile managers depend on them)
and refuses only a symlinked final path element unless `--force` is given. Worktree storage
uses a crew-owned base directory derived from a hash of the repository path; repo config
cannot choose its location.

### SQLite injection, corruption, and denial

All values are bound as parameters, never spliced into SQL text. STRICT tables and
constraints (the database itself rejects invalid rows instead of trusting the code never to
write them), foreign keys, defensive mode, refusal to load extensions, size limits,
write-ahead logging, and explicit migrations reduce the risk of corruption and injection.
Waiting on a busy database is bounded; contention returns an error instead of hanging.
`doctor` runs integrity checks. The State Store is not supported on network filesystems.

### Destructive cleanup

Vacuum and clean refuse to run while active Agents exist. `clean` (without `--force`) holds
the write lock across BOTH the active-Agent count and the file deletion, so a concurrent
`join` cannot commit a row between the two: a join that committed first aborts the clean
(`ACTIVE_AGENTS`); a join that opened the database first and is still waiting on the lock
proceeds only after the files are gone, and then fails its own post-lock identity check
(`STALE_STORE`) instead of writing to an orphaned file. The guarantee is therefore "no silent
loss": a competing process either commits durably or fails in a detectable way — not the
stronger guarantee that all operations appear to happen in one strict global order
(linearizability). `clean --force` is the explicit, deliberately non-atomic recovery path for
a corrupt or locked store: it never opens the database, removes only State Store files,
reports the resolved Workspace, and never follows user-provided delete paths. VACUUM
preserves content, so the brief window after its active-Agent count cannot lose data.

### Secret leakage

Messages are stored as plain text in a local SQLite file, and history persists after a
Message is read. The documentation warns users not to send credentials. crew emits no
*credential* environment values: `doctor` and `setup` report only what they probe, by name,
and record commands (`join`, `agents`, …) render stored fields, not the environment. The one
environment-derived value that does appear in output is the managed worktree base path in
`team --launch --print` (derived from `XDG_DATA_HOME` or `HOME`) — a non-secret filesystem
location, never a credential. Generated prompts do not include the environment. Backend
recipes use placeholders.

**Redaction rule (FR-J08).** crew never dumps the whole environment, and it never emits a
*credential* environment value: `doctor` and `setup` report only the specific things they
probe, by name (whether an executable is present, and whether the variables they check are
`set` or `unset`), never a value; the only environment-derived value in any output is the
non-secret worktree base path noted above. The credential-name policy is the guardrail behind
that property: a variable is treated as credential-like — reported as `set`/`unset`, never by
value — when its name matches, case insensitively, any of `TOKEN`, `KEY`, `SECRET`,
`PASSWORD`, `PASSWD`, `CREDENTIAL`, `AUTH`, `SESSION`, `COOKIE`, or `PRIVATE`, or ends with
`_PAT`. Because no credential value is ever emitted, there is nothing to redact by name; the
value-based redactor is an independent safety net. That redactor also masks the value of
these credential-named keys when they appear as a `key = value` / `key: value` pair in free
text — bare or namespaced, so `launch_token`, `db_credential`, and `signing_key` are masked —
while preserving the key and the separator. Independently of any name, any value that would
otherwise appear in error or setup output is replaced with `[REDACTED]` when it looks like a
secret: a `sk-`/`ghp_`/`gho_`-prefixed token, an AWS `AKIA…` key, a JWT (`eyJ…`), a
connection-string credential (`scheme://user:secret@host`), or an unbroken run of 20 or more
*alphanumeric* characters. That standalone-run rule is deliberately limited to letters and
digits: extending it to the base64 `+`/`/` or base64url `-`/`_` symbols would let it swallow
filesystem paths and URLs that legitimately appear in error text, so a base64 secret
containing those symbols is instead caught by the keyed-pair or connection-string rule rather
than this backstop. The redactor limits its input length before matching, so a long
user-controlled value cannot turn redaction into a way to stall the process
(denial of service). Redaction is applied to both human and JSON error and setup output. When
setup replaces a marked artifact it preserves the original exactly by renaming it to a backup
(it never rewrites a backup), and the generated artifacts are static placeholders that
contain no environment values.

The value-based redactor is deliberately **not** applied to normal diagnostic *record* output
(`doctor` findings, `setup` success lines): that output is stripped of control sequences but
otherwise left intact, because it legitimately carries long values — filesystem paths,
version strings — that a value redactor would corrupt (a path segment of 20-plus characters
would be masked). The no-secret guarantee for that output is upheld at the source (crew never
copies an environment value into a record) and is guarded against regressions by a
program-level test that runs `join`/`agents`/`doctor` with the environment deliberately
stuffed with secrets and asserts no value leaks. The redactor guards the one surface that can
carry attacker-influenced free text: the error/setup message path.

## Permissions guidance

- Prefer a permission grant limited to the `crew` command when a Participant CLI supports
  that.
- Never enable `--yolo`, `--allow-all-tools`, `--dangerously-skip-permissions`, or an
  equivalent automatically.
- Do not claim that a skill's available-tools list restricts other tools when it only grants
  approval for the listed tools.
- Preserve the Participant CLI's sandbox. During normal coordination crew needs to write
  inside the Workspace, not unrestricted access to the home directory or the system.

## Security acceptance tests

- launcher config containing command/path/env fields is rejected;
- traversal and symlink fixtures cannot write outside managed roots;
- a managed write whose already-validated parent is swapped for an outside-pointing symlink
  is rejected at write time, with no file created outside the root;
- project-scope setup against a repo with a symlinked artifact-path component fails
  (`UNSAFE_PATH`) and writes nothing outside the workspace;
- with an empty/`.` `PATH` element and a binary of the same name planted in the current
  directory, presence checks and version/backend probes resolve only the binary found through
  absolute `PATH` entries, never the one in the current directory;
- Task/Message text containing ANSI/OSC sequences has no effect in human output and never
  reaches tmux input;
- Message text containing shell metacharacters is stored exactly as written;
- setup refuses or backs up unmarked and hash-mismatched files correctly;
- role/brief/message prompt-injection fixtures do not alter the Relay nudge content;
- clean's active-Agent guard holds under concurrent access: a contender that opened the
  database beforehand cannot durably join when clean succeeds (it fails `STALE_STORE`), and
  an active Agent aborts clean;
- the database rejects invalid states and foreign-key violations;
- no credential environment value reaches command output (proven across
  `join`/`agents`/`doctor` with the environment deliberately stuffed with secrets), the
  launch token is never rendered, and a long user-controlled value cannot stall redaction.

## Residual risks

- A malicious trusted Agent can deliberately issue destructive shell commands through its own
  Participant CLI permissions.
- At-most-once receive has a documented loss window: a crash right after the receive commits
  can lose the delivery.
- A local user with filesystem access can edit the State Store or setup artifacts.
- Model behavior cannot be guaranteed by prompt text; Role rules are guidance, not a policy
  enforcement engine.
- A standalone base64 secret using the `+`/`/` (or base64url `-`/`_`) symbols, with no
  surrounding credential key or connection scheme, is not masked by the alphanumeric
  standalone-run rule — masking it would corrupt filesystem paths and URLs in error text;
  such a value is redacted only when it appears as a keyed pair or a connection credential.
