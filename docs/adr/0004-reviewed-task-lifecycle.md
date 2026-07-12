---
status: accepted
---

# Separate Submission from accepted Task completion

A Task — a durable unit of assigned work — moves through the statuses
`queued -> in_progress -> submitted -> completed`. A Worker (the Agent doing the work) starts
the Task and submits its result; that result is a Submission, not a finished Task. An Inspector
(the reviewing Agent) then either approves the Submission or sends the Task back to the queue
with a reason. Every status change appends a Task Event — a permanent record of what changed
and who did it — and increases a revision number, which lets a writer detect that someone else
changed the Task first (compare-and-swap). This keeps us from calling a Worker's output
"completed" before the review step has actually accepted it.
