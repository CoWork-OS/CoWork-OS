# Inbox Agent Product Plan — Implementation Spec

This document satisfies the product-planning deliverables: Phase 1 UX requirements, cross-system signal mapping, chosen first implementation slice, and success metrics. It complements [inbox-agent.md](inbox-agent.md) and the roadmap plan (do not edit the plan file in `.cursor/plans/`).

## Current Implementation Status

Inbox Agent has moved past the original saved-view slice into the email-client replacement foundation. The current working system includes:

- Classic three-pane mode plus Today lanes for `Needs action`, `Happening today`, `Good to know`, and `More to browse`
- richer classifier fields: `todayBucket` and `domainCategory`
- domain chips for travel, packages, receipts, bills, newsletters, shopping, work, and all domains
- Ask Inbox as a right-sidebar mailbox chat with live run steps, hybrid retrieval, final answers, and matched evidence
- `@Inbox` / `@inbox ...` main-composer routing into Ask Inbox
- hybrid mailbox search over local FTS, semantic mailbox embeddings, provider-native mail search where available, and attachment text
- sender cleanup digest and cleanup center
- attachment metadata capture during Gmail sync and on-demand text extraction for supported file types
- autosync with cached mail shown immediately on startup
- provider-backed read/unread actions where supported
- `Mark done` for threads already handled outside CoWork OS
- editable AI-generated draft replies
- manual reply, reply-all, and forward from the thread detail view without requiring AI draft generation
- direct provider send through Gmail API, AgentMail reply-all, or SMTP depending on account type
- replacement-client schema/types/IPC for folders, labels, identities, signatures, compose drafts, outgoing messages, queued actions, sync health, and client settings

The remaining replacement-client gaps are native new-mail compose, provider-backed draft persistence in the visible UI, attachment upload, full outgoing queue draining, Microsoft Graph mail execution, folder/label navigation, notifications, and broader provider reconciliation.

## 1. Phase 1 UX Requirements

### AI auto-labels and saved views

- **Create flow**: User provides a **name** and **natural-language instructions** (what should belong in this view). Optional: seed from the **currently open thread**.
- **Preview**: Before saving, show a **sample of matching threads** (ranked) with checkmarks to include/exclude; user confirms **Save view**.
- **Persistence**: Saved views are workspace-scoped, stored locally, and appear as **filters** alongside existing category chips.
- **Inbox behavior**: `show_in_inbox` (default on) means matching threads remain in the main inbox list; when off, matching threads are **only** visible when the saved view is selected (implemented as filter + optional `local_inbox_hidden` in a later iteration).

### Label similar (example-based)

- **Entry**: Button on thread detail: **“Find similar & save view”**.
- **Behavior**: Uses the open thread’s subject, snippet, and summary (if any) plus user instructions to find **similar threads** in the cached mailbox via an LLM-ranked candidate set.
- **Output**: Same preview/confirm flow as auto-labels, then persists memberships for the new view.

### Quick reply chips

- **When**: After a thread has enough context (summary or last message), show **up to three** short reply suggestions.
- **Constraints**: No suggestions for no-reply senders (same policy as draft generation). User taps a chip to **fill the reply composer** (does not send automatically).

### Snippets / templates

- **Storage**: Per-workspace snippets with **shortcut label** and **body** (optional subject hint for future send flows).
- **UX**: Snippet picker near the reply area; choosing one **inserts** text into the composer.

### Learning feedback (lightweight)

- **Events**: On **reclassify**, **archive**, **trash**, **mark read**, and **dismiss proposal**, record an optional **feedback row** (thread id, kind, timestamp) for future classifier and ranking improvements.
- **Privacy**: Stored locally only; no new cloud sync.

### Onboarding loop (later Phase 1 polish)

- Short questionnaire: priorities, domains to deprioritize, VIP senders — used to **seed** saved views and automations. Not required for the first code slice.

## 2. Cross-System Hooks (CoWork OS)

| Signal | Mission Control | Automations / triggers | Heartbeat | Briefing | Knowledge Graph | Memory / playbooks |
|--------|-----------------|-------------------------|-----------|----------|-----------------|--------------------|
| Saved view created / thread matched | Optional handoff from high-priority view | Rule or schedule **bridge** from saved view | Pulse can use view membership as context in future | Mention “N saved views active” in mailbox section | Entity extraction from threads in view | Playbook capture for repeated triage patterns |
| Triage feedback | Issue updates if linked | Refine trigger conditions over time | Lower noise if user consistently dismisses class | — | Reinforce entity confidence | Reinforcement signals |
| Quick reply / snippet usage | — | — | — | Usage counts in productivity metrics | — | Style / template preferences |

Mailbox events (`thread_classified`, `mission_control_handoff_created`, etc.) continue to flow through [MailboxAutomationHub](../src/electron/mailbox/MailboxAutomationHub.ts) as today.

## 3. First Implementation Slice (completed foundation)

The original smallest set that improves **perception** and **differentiation** without rewriting the mailbox:

1. **Saved views** — DB + list/filter + create from “label similar” preview.
2. **Quick reply suggestions** — LLM-backed chips in thread detail.
3. **Snippets** — CRUD + insert into reply.
4. **Triage feedback** — Record rows on key actions (foundation for learning).
5. **Mission Control back-link** — Handoff records in thread detail with **Open in Mission Control** (company + issue).
6. **Saved view → automation bridge** — Create a **scheduled review** task for the view (reminder patrol) using existing mailbox schedule APIs.

Additional implemented slices since then:

7. **Today mode** — Classifier-backed Today buckets with lane-specific grouping.
8. **Domain categories** — Life/work domain classification and filtering.
9. **Ask Inbox** — Right-sidebar mailbox chat with live agentic steps, hybrid retrieval, optional LLM summary, attachment evidence, and `@Inbox` main-composer routing.
10. **Attachment indexing** — Metadata during sync, bytes/text on demand.
11. **Sender cleanup** — Noisy sender ranking with estimated weekly reduction.
12. **Manual email compose** — Reply, reply-all, and forward from the thread detail view.
13. **Editable AI drafts** — Generated draft subject/body can be edited before send.
14. **Autosync and read-state polish** — Background refresh, clearer unread cards, provider-backed mark read/unread where supported.
15. **Ask Inbox architecture** — Dedicated `MailboxAgentSearchService`, query planning, local FTS/vector/provider/attachment channels, shortlist-then-read behavior, run-scoped `mailbox:askEvent` progress streaming, and Ask Inbox sidebar transcript.

## 4. Success Metrics

| Metric | Definition | Target direction |
|--------|------------|------------------|
| Time to triage | Median seconds from open thread to archive/mark-read or reply | Decrease |
| Saved view usage | % of active users with ≥1 saved view; filters used per session | Increase |
| Quick reply adoption | Chips clicked / threads with suggestions shown | Increase |
| Snippet usage | Inserts per week | Increase |
| Handoff traceability | % of MC handoffs opened from inbox vs created-only | Increase |
| Automation bridge | Schedules created from saved views | Increase (secondary) |
| Feedback volume | Triage feedback rows per user (opt-in analytics locally) | Increase slowly (signal quality) |

---

## Code references

- UI: [InboxAgentPanel.tsx](../src/renderer/components/InboxAgentPanel.tsx)
- Service: [MailboxService.ts](../src/electron/mailbox/MailboxService.ts)
- Search service: [MailboxAgentSearchService.ts](../src/electron/mailbox/MailboxAgentSearchService.ts)
- Types: [mailbox.ts](../src/shared/mailbox.ts)
- Mission Control: [useMissionControlData.ts](../src/renderer/components/mission-control/useMissionControlData.ts)
- Architecture: [Ask Inbox Architecture](ask-inbox-architecture.md)
