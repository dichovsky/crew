---
status: accepted
---

# Use bounded at-most-once Message receive in v1

`receive` claims unread Messages with a single `UPDATE ... RETURNING` statement and returns at
most a fixed number of them per call. Because the claim is one atomic database statement, two
Agents receiving at the same time can never both get the same Message. The trade-off is
"at most once" delivery: if the process crashes after the database has committed the claim but
before the caller sees the output, that Message disappears from the Inbox — it is never shown,
though it still exists in history. v1 accepts that narrow crash window in exchange for a
simpler interface; a two-step claim-then-acknowledge design, which would close the window, is
deferred until real usage shows it is worth the added complexity.
