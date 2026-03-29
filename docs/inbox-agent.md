# Inbox Agent

Inbox Agent is the local-first email workspace in CoWork OS. It keeps mail cached in the app, lets you review sent and received conversations side by side, and turns email into structured work instead of a long scroll of threads.

It is no longer just a mailbox viewer. The inbox now feeds a mailbox event pipeline that updates Knowledge Graph, Heartbeat v3, triggers, playbooks, and the daily briefing whenever sync, classification, summarization, draft generation, commitment extraction, or actions happen.

## What It Does

Inbox Agent helps you move from "read everything" to "act on the few items that matter":

- classify threads into `Unread`, `Action Needed`, `Suggested Actions`, and `Open Commitments`
- keep `Inbox`, `Sent`, and `All` views separate so outbound mail does not clutter the inbox
- show sent-mail content as thread content when you open a sent conversation
- sort by `Recent` or `Priority`
- multi-select threads for bulk archive, trash, mark-read, and cleanup flows
- generate thread summaries and draft replies before anything is sent
- extract commitments, edit commitment details, and track follow-up tasks
- expose contact intelligence and related entities in the research rail
- flag sensitive content so users can review outbound actions more carefully
- keep synced mail visible locally so a restart does not blank the inbox

## Why It Is Useful

The main advantage of Inbox Agent is speed without losing context:

- **Less manual triage** - important threads are surfaced directly instead of forcing you to scan the full mailbox
- **Fewer missed replies** - action-needed mail is separated from newsletters and system notifications
- **Clear next steps** - every thread can move toward a draft, a task, a commitment, or dismissal
- **Local-first persistence** - inbox state is stored in the local database and survives app restarts
- **Safer outbound mail** - generated drafts and sent-mail review stay visible before you confirm external actions
- **Better contact memory** - repeated conversations enrich contact intelligence and relationship context over time
- **Cross-system handoff** - inbox events can feed briefings, Heartbeat, triggers, playbooks, and the Knowledge Graph

## Core Surfaces

| Surface | What It Does |
|---------|--------------|
| Metric cards | Show unread mail, action-needed mail, suggested actions, and open commitments at a glance. |
| View filters | Switch between `Inbox`, `Sent`, and `All`. |
| Sort controls | Toggle between `Recent` and `Priority`. |
| Thread groups | Group threads by reply pressure, priority, or everything else when no narrow filter is active. |
| Thread list | Browse the mailbox with selection, bulk actions, and live filter/sort updates. |
| Thread detail | Inspect the full conversation, including received and sent message sections, summary, drafts, and commitments. |
| Agent rail | Run cleanup, follow-up, thread prep, todo extraction, scheduling, and intel refresh actions. |
| Research rail | Review contact memory, related entities, recent subjects, and follow-up signals. |

## Typical Workflow

1. Open Inbox Agent and let it load the cached mailbox from the local database.
2. Review the metric cards to decide whether to focus on unread, action-needed, suggested actions, or commitments.
3. Switch between `Inbox`, `Sent`, and `All` if you want to isolate received mail from outbound mail.
4. Sort by `Recent` when you want the newest messages first, or `Priority` when you want the highest-signal threads first.
5. Open a thread and inspect the message body, summary, and related context.
6. Use `Prep thread` to generate a concise summary, extract commitments, and draft a response.
7. Send the draft, discard it, or turn commitments into follow-up tasks.
8. Edit commitment details inline when the due date, title, or owner needs correction.
9. Use `Refresh intel` when a thread changed and you want the summary, commitment extraction, and contact signals refreshed together.
10. Use bulk selection when you want to clear low-value mail faster.

## Actions In Practice

- **Cleanup** - suggests low-value mail that can be archived or handled in bulk
- **Follow-up** - surfaces stale threads that still need a response
- **Prep thread** - prepares the thread for action by summarizing it and drafting a reply
- **Extract todos** - finds commitments and turns them into trackable follow-up items
- **Schedule** - proposes or creates calendar time for the thread when a meeting is needed
- **Refresh intel** - re-runs the thread analysis and contact intelligence for the selected conversation
- **Remind later** - snoozes a thread by creating a timed follow-up task
- **Bulk archive / trash / mark read** - clears multiple threads at once

## Event Pipeline

Every meaningful mailbox action emits a normalized mailbox event. Those events can be consumed by other parts of the system without special-case wiring.

Mailbox events currently drive:

- Knowledge Graph enrichment for people, organizations, projects, and observations
- Heartbeat signal submission for stale threads, open loops, and cleanup candidates
- trigger evaluation for downstream actions
- playbook capture for repeated inbox patterns
- briefing summaries so the daily brief can show mailbox health

## Notes

- `Unread` remains provider-backed and deterministic.
- `Action Needed`, `Suggested Actions`, and `Open Commitments` are AI-assisted surfaces.
- Sent mail is shown as content when you select a sent thread, not hidden behind a separate abstraction.
- Sending, archiving, trashing, marking read, and scheduling are still gated by the connected mailbox/calendar provider.
- Sensitive-content detection is surfaced as a warning and metadata cue, not a hard block.
- The inbox can re-sync in the background while still showing cached mail immediately.

For a higher-level overview of the product surface, see [Features](features.md). For copy-paste prompts that exercise inbox workflows, see [Use Cases](use-cases.md).
