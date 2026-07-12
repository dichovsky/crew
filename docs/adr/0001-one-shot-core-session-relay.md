---
status: accepted
---

# Keep the core one-shot and make wake-up an optional session Relay

Every `crew` command is one-shot: it opens the local state, does a limited amount of work, and
exits — nothing stays running. Automatic wake-up cannot be handled by a shell script that reads
Messages off the queue, because terminal AI CLIs do not start a model turn just because new text
appeared on the terminal. So in launched mode, crew may run one Relay per tmux session — a helper
that checks how many unread Messages each Agent's Inbox holds (without reading their content and
without marking anything as read) and types a fixed wake-up line into the tmux panes. In manual
mode, nothing long-lived runs at all.

The consequence is precise wording: crew never requires a permanently running background
process, but automatic wake-up in launched mode does need one running helper. The Relay stops
when its tmux session stops, and it never sees or types Message content.
