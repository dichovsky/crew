---
status: accepted
---

# Lexical FTS5 search over Messages and Task Events

## Context

Issue #8 asks for indexed search over stored Messages and Task Events so that an Operator can
find a past Message or a past Task transition without crew running a model. It gates itself on
one open question — whether FTS5 is available in `node:sqlite` — and on its own promotion bar:
requirements, a data and CLI contract, an ADR, and tests before any build. This ADR is the
design half of that bar. **Nothing here is implemented.** No `src/` module, no schema, and no
command changes in the change that introduces this ADR; the implementation is a separate change
that must satisfy the group-S requirements (`docs/design/srs.md` §3.2), the command surface in
[cli-contract.md](../design/cli-contract.md), and the schema-v8 specification in
[data-model.md](../design/data-model.md) recorded alongside it.

The gating question is answered. Probed against this project's own runtime — Node `v24.19.0`,
SQLite `3.53.3` as bundled in `node:sqlite` — `sqlite_compileoption_used('ENABLE_FTS5')` returns
`1`, and `MATCH`, prefix queries, `bm25()` ranking, and `snippet()` all work. The result that
decides the design is that **external-content tables are supported**:

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id');
```

An external-content table stores only the inverted index and reads the document text back from
the table it names, so the index points *at* `messages` and `task_events` rather than holding a
second copy of their text. That matters more than convenience. The schema-v1 `STRICT` tables
with their `CHECK` constraints are the single source of truth for stored content
([ADR-0002](./0002-local-sqlite-state-store.md)), and a design that stored every Message body
twice would end that — two copies, one of them not constrained, both claiming to be the content.
With external content the index is *derived* state: it can be dropped and rebuilt from the rows
it indexes, and nothing is lost when it is.

The cost is that SQLite does not keep an external-content index in sync on its own. Every write
to `messages` or `task_events` has to be mirrored into the index by something, and an index that
silently falls behind is worse than no search at all — a search that quietly misses a Message
gives a wrong answer with the same confidence as a right one. Deciding what does the mirroring,
and how a wrong answer is detected and repaired rather than believed, is most of what this ADR
decides.

Two existing constraints shape those decisions. The Store opens defensively — `defensive: true`,
`foreign_keys = ON`, no extension loading (FR-I04), WAL (FR-I05), and `trusted_schema = OFF`,
which is set at `src/store/index.ts:252` but which no requirement currently names (tracked
separately). That last pragma restricts which virtual tables and functions may be named from
inside schema objects such as triggers, so whether FTS5 can be driven from a trigger at all had
to be measured rather than assumed. And `findSchemaDrift` (`src/store/schema.ts`) compares
every application object in `sqlite_schema` against the released SQL on every open and **rejects
anything it does not expect**, which an FTS5 table cannot satisfy unaided: creating one adds a
virtual table plus four shadow tables, none of which is `STRICT` and whose SQL text is written by
FTS5 rather than by crew.

## Decision

**The index is external-content, not a standalone copy.** Two virtual tables —
`messages_fts` over `messages.content` and `task_events_fts` over `task_events.detail` — are
declared with `content=` and `content_rowid=` pointing at those tables' own `INTEGER PRIMARY KEY
AUTOINCREMENT` ids. The alternative, a standalone FTS5 table holding its own copy of the text,
was rejected: it roughly doubles the stored size of the two largest columns in the Store, it
creates a second unconstrained copy of content whose `CHECK`-enforced original is supposed to be
authoritative, and it makes divergence between the copy and the original *unrecoverable* rather
than merely repairable, because after divergence there is no longer a single answer to what the
Message said. The price accepted in exchange is the sync burden below, and one structural
consequence worth stating plainly: because FTS5 resolves `content=` inside the same database
file, the index must live in `crew.db`. A sidecar index database was considered for exactly this
reason and rejected — it would buy schema separation at the cost of giving up external content,
which is the property the whole design rests on.

**The index is kept in sync by SQLite triggers, not by explicit maintenance in the Store.** Six
`AFTER INSERT`/`AFTER UPDATE`/`AFTER DELETE` triggers — three per indexed table — carry each
write into the index using FTS5's documented external-content commands. The decisive argument is
not convenience but reach: a trigger is part of the schema, so it applies to *every* write, and
crew has writers that would otherwise have to remember. `prune` deletes Messages and Task Events
with its own direct `DELETE` statements (`src/store/maintenance.ts`), the `ON DELETE CASCADE`
edges from `tasks` remove Messages and Task Events without any crew code naming them, and a
future writer would have to be told. Explicit Store-side maintenance can only be as complete as
the enumeration of write paths that someone remembered to keep current, and a missed path fails
silently — the exact failure mode this design is trying to avoid.

The second argument is that triggers are already pinned by machinery that exists. `findSchemaDrift`
compares live trigger SQL against the released text on every open, so a dropped or edited sync
trigger is an `INTEGRITY` failure at the next command rather than a search result that is quietly
short. Store-side maintenance has no equivalent guard; it is ordinary code, and ordinary code can
be deleted without anything noticing. crew already relies on this pattern — the `agent_mutations`
and `observable_mutations` counters are trigger-maintained for the same reason (schema v5 and v7).

**`trusted_schema = OFF` does not block any of this, which was measured rather than assumed.**
Against a connection opened with the Store's exact options (`allowExtension: false`,
`defensive: true`, `enableForeignKeyConstraints: true`) and its exact pragmas (`trusted_schema =
OFF`, `cell_size_check = ON`, WAL), creating an external-content FTS5 table succeeded, creating
triggers whose bodies write that virtual table succeeded, and inserting, updating, and deleting
rows through those triggers all succeeded and moved the index. `defensive: true` refuses direct
writes to a shadow table (`table messages_fts_docsize may not be modified`) but permits reads of
one and permits every write the design actually performs, all of which go through the virtual
table rather than around it. Two related facts were measured at the same time, because both are
easy to get wrong from documentation alone: an `ON DELETE CASCADE` from `tasks` **does** fire the
`AFTER DELETE` triggers on `messages` and `task_events` with `recursive_triggers` left at its
default `OFF`, so no pragma change is required and none is made; and `bm25()` scores are
identical whether an index was built incrementally by triggers or rebuilt in one pass, so the
two paths cannot disagree about ranking.

**What is searchable is Message content and Task Event detail, and nothing else.** Those are the
two columns the issue names, they are the two places durable free text actually accumulates, and
both live in tables whose `id` is an explicit `INTEGER PRIMARY KEY AUTOINCREMENT`. That last point
is a requirement, not a coincidence. **Task titles and bodies are deliberately excluded**, even
though they are free text an Operator might reasonably want to search, because `tasks.id` is a
`TEXT PRIMARY KEY` — the table therefore has no explicit `INTEGER PRIMARY KEY`, and SQLite
documents that `VACUUM` may renumber the rowids of exactly such tables. `prune --vacuum` runs
`VACUUM`. An external-content index keyed on `tasks.rowid` would rest on undocumented behavior,
and when it broke it would break by pointing at the wrong Tasks rather than by failing — a probe
on this SQLite version happened not to renumber, which is precisely why the risk is unacceptable:
it is invisible in testing and arrives later. Giving `tasks` a stable surrogate integer key is a
larger schema change than this feature justifies, so Task text stays reachable through `task
list` and `task show`, and a follow-up ADR may revisit it if field use shows the gap is real.

**Ranking is `bm25()` within one index, made into a total order, and never combined across
indexes.** Results from one scope are ordered by `bm25()` ascending (FTS5 returns more negative
scores for better matches), then by `created_at` descending, then by `id` descending — three keys
of which the last is unique, so the order is total and no tie can be broken differently by two
runs. This satisfies the determinism the repository's tests depend on without giving up
relevance, and it was checked rather than assumed: identical corpora produced byte-identical
scores across insertion orders and across a rebuild. What is deliberately **not** done is fuse
the two scopes into one ranked list. `bm25()` is computed from the statistics of one index —
document count and term frequencies — so a score from `messages_fts` and a score from
`task_events_fts` are not comparable, and ordering them together would be inventing a number. A
search covering both scopes therefore emits its Message results, ranked, and then its Task Event
results, ranked, in that fixed order; every record carries its own `rank`, so a consumer that
wants some other arrangement can compute one from data crew did not fabricate.

**The query is compiled by crew, never passed through to FTS5.** The command accepts a small
closed language — whitespace-separated terms, `"quoted phrases"`, and a trailing `*` for a prefix
match — and compiles it into a `MATCH` expression in which every user token appears as an FTS5
string literal joined by `AND`. Passing the raw string through was rejected on two counts. It
exposes FTS5's whole operator surface as an accidental contract, including column filters
(`content : lease`), `NEAR(...)`, and the initial-token `^` operator, all of which were confirmed
to work and none of which crew wants to promise or to keep working across SQLite versions. And it
makes malformed input a SQLite error: `lease AND (` raises `fts5: syntax error near ""` with the
generic `SQLITE_ERROR` code, which crew could only classify by matching the text of a SQLite error
message — the thing the migration contract already forbids. Compiling instead means a syntactically
invalid `MATCH` expression cannot be produced at all, an operator word the user typed is treated as
the word they typed, and the error message for bad input is crew's own. The query string itself is
always a bound parameter; it is never concatenated into SQL.

**The schema goes to version 8, and an existing Workspace is backfilled by the migration.** The
`7 -> 8` step creates the two virtual tables and the six triggers, then runs FTS5's `'rebuild'`
command on each so that every Message and Task Event already in the Store is indexed before the
step commits — a Workspace that upgrades gets a complete index, not one that only covers what it
does next. Because the drift check rejects unexpected schema objects, it learns two new
categories at the same time: the expected virtual tables, whose declaration SQL is pinned like any
other object, and their shadow tables, which are identified through `pragma_table_list`'s `shadow`
type and required to belong to an expected virtual table rather than being compared against pinned
text — FTS5 writes that text, and pinning it would make a future SQLite version look like
corruption. Neither category is subject to the `STRICT` requirement, which a virtual table cannot
satisfy.

**A missing index fails loudly; a stale one is detected and repairable.** Those are different
failures and get different answers. A *missing* or altered index object is schema drift, so the
existing check fails the open with `INTEGRITY` exactly as it would for a missing table — search
cannot silently degrade to "no results". A *stale* index — right objects, wrong contents — cannot
be caught that way, so `doctor` gains a read-only staleness check comparing the row counts of
`messages` and `task_events` against the number of indexed documents in each index's `_docsize`
shadow table, reported as a `SEARCH_INDEX_STALE` finding. It is deliberately a cheap count
comparison rather than FTS5's own `'integrity-check'`: `doctor` opens read-only by contract, and
`'integrity-check'` is issued as an `INSERT`, which a read-only connection refuses. The repair is
`crew search --reindex`, which reruns `'rebuild'` on both indexes. Rebuilding is always safe
precisely because the index is derived — there is no state in it that the indexed rows do not
already contain.

**Search is lexical, and never semantic.** It matches the tokens that are stored, ranked by a
formula over term statistics. It computes no embedding, calls no model provider, and reaches no
network — which is the constraint that makes this feature admissible at all under FR-A06 and the
product's standing rule that crew never runs a model. A semantic or embedding-backed search would
require exactly what crew refuses to do, and no amount of usefulness makes it in scope; if the
lexical answer is not good enough for some query, the answer is a better query language, not
inference. `unicode61 remove_diacritics 2` is the tokenizer, so matching folds diacritics and case
(`cafe` finds `CAFÉ`) — a purely mechanical transformation, with no dictionary, stemmer, or model
behind it.

**Search reads what `crew history` already reads, and marks nothing.** It exposes no Message that
`crew history` does not already expose to whoever can run the CLI in that Workspace, so it widens
no boundary; crew's trust domain is the local user (`docs/design/security.md`). Like `pending`, it
only looks: it marks no Message read, refreshes no Agent's activity, and writes nothing —
`--reindex` is the single, explicitly requested exception. Its `--json` records carry a derived
`snippet` rather than stored content, so the rule that JSON output never rewrites stored bytes
holds unchanged; the full text is fetched with `crew history` or `crew task show` using the id the
result carries.

## Consequences

- Issue #8's blocking question is closed and the feature is specified, but **`crew search` does
  not exist**. Until the implementation change lands, the group-S requirements, the contract
  section, and the schema-v8 block describe intended behavior, and they say so; `PRAGMA
  user_version` stays at 7 and the released DDL block is unchanged.
- The State Store gains derived state for the first time. Every table before this one held facts
  crew was told; `messages_fts` and `task_events_fts` hold a restatement of two columns, and the
  rule that keeps them honest — the index can always be rebuilt from the rows it indexes, and is
  never itself the answer to what was said — has to survive future changes to those tables. A
  change to `messages.content` or `task_events.detail` now has a second obligation.
- The schema-drift check is no longer "every object matches pinned SQL." It gains a documented
  exception for FTS5-owned shadow tables, and that exception is a hole an unexpected object could
  hide in if it is drawn too wide. It is drawn narrowly on purpose: shadow tables are recognized
  through `pragma_table_list`, and each must belong to a virtual table crew expects.
- `doctor` gains a finding that can be false-negative. Equal row counts do not prove equal
  contents — a Message whose text was somehow reindexed wrongly counts the same as one indexed
  correctly. The check catches the failure that can actually occur here (a write that never
  reached the index), and the deeper check — `'integrity-check', 1`, whose `rank` argument is
  load-bearing because the one-argument form detects nothing — remains available to a future writable
  diagnostic if one is ever wanted.
- Task text stays unsearchable, and that will be noticed. The reason is a rowid-stability
  property of `tasks`, not a judgment that Task titles do not matter; fixing it means giving
  `tasks` a stable integer key, which is a schema change with its own ADR.
- Ranking is honest about what it cannot compare, at the cost of a combined search that reads as
  two lists rather than one. If a single fused ordering is later wanted, it needs a defined
  cross-scope rule — recency is the obvious candidate, since it is the only key the two scopes
  genuinely share — and not a comparison of two `bm25()` scores that mean different things.
- The compiled query language is a floor, not a ceiling: `OR`, negation, and field-scoped search
  can be added later as crew syntax that compiles to FTS5, without ever widening the pass-through
  surface this ADR closed.
- Doing nothing was the other real option and was rejected. `crew history` already answers "what
  did this Agent say", and search only earns its schema change for the question history cannot
  answer — "where was this mentioned" across a Workspace that has accumulated more than an
  Operator can page through. Scanning with `LIKE '%term%'` was rejected as the cheap middle
  ground: it needs no schema change, but it cannot use an index, so its cost grows with the whole
  Store on every query, it has no ranking at all, and it matches inside words in ways a user
  cannot predict or turn off. Its only genuine advantage — nothing to keep in sync — is bought by
  making every search slower than the last.
