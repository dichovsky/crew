---
status: accepted
---

# Use one local SQLite State Store

All shared, changeable Crew state lives in one SQLite database file, `.crew/state/crew.db` —
the State Store. Each one-shot command opens it on its own through Node's built-in
`node:sqlite` module. Several crew processes can safely use the file at the same time without
any server, because the database is opened with: write-ahead logging (an SQLite mode that lets
readers keep working while one writer writes), enforced foreign keys, defensive mode, a busy
timeout, a bounded number of retries, transactions, and revision counters that detect when two
writers race for the same row. The State Store must sit on a local disk; NFS, SMB, and other
network mounts where write-ahead logging's shared memory does not work are unsupported.
