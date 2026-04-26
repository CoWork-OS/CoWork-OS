# Inbox Agent

Inbox Agent is CoWork OS's local-first, agent-assisted email workspace. It is designed to be more than a mailbox viewer: it keeps recent mail cached locally, syncs in the background, classifies work into action lanes, lets you reply or forward like a normal email client, and turns important threads into tasks, automations, Mission Control issues, and relationship memory.

The current product shape is:

- **Classic inbox remains available** as the familiar three-pane mailbox.
- **Today mode is the agent-first working mode** for deciding what needs attention now.
- **Ask Mailbox and Agent Rail sit beside the thread** so search, cleanup, commitments, drafts, and handoff actions are close to the message.
- **Provider state is authoritative** for read/unread and supported server actions; the local database is the cache plus agent metadata.

## What It Does

Inbox Agent helps you move from "read everything" to "act on what matters":

- sync Gmail and IMAP/SMTP mail into a local encrypted cache, then keep it fresh with background autosync
- classify threads into `Unread`, `Needs reply`, `Suggested actions`, and `Open commitments`
- group the current inbox into Today lanes: `Needs action`, `Happening today`, `Good to know`, and `More to browse`
- classify practical domains such as travel, packages, receipts, bills, shopping, newsletters, work, personal, and finance
- keep `Inbox`, `Sent`, and `All` views separate so outbound mail does not clutter received mail
- make unread mail visually distinct and update read/unread state through the provider when capability is available
- search local mailbox evidence with Mailbox Ask, including attachment metadata and extracted attachment text when indexed
- generate AI summaries and AI reply drafts, while keeping drafts editable before send
- send a manual reply, reply-all, or forward without requiring an AI-generated draft
- extract commitments, edit commitment details, and mark already-handled threads done
- roll up noisy senders into a sender cleanup center
- show attachment chips and fetch/extract attachment text only on demand
- resolve contact identities across email, Slack, Teams, WhatsApp, Signal, iMessage, and CRM-linked handles
- reply via a linked non-email channel when that channel is a better target
- hand off a thread into Mission Control as a company issue and wake the recommended operator
- create inbox automations, reminders, scheduled review patrols, and Gmail forwarding automations
- emit mailbox events into Knowledge Graph, Heartbeat, triggers, playbooks, Mission Control, and daily briefings

## Core Surfaces

| Surface | Current Behavior |
|---------|------------------|
| Classic mode | Three-pane mailbox with filters, thread list, detail pane, and Agent Rail. |
| Today mode | Groups current threads into `Needs action`, `Happening today`, `Good to know`, and `More to browse`. |
| Inbox pulse | Shows unread, needs-reply, suggested-action, and open-commitment counts. |
| View filters | Switch between `Inbox`, `Sent`, and `All`. |
| Category filters | Filter by priority, calendar, follow-up, promotions, updates, and saved views. |
| Domain filters | Filter by domains such as travel, packages, receipts, bills, newsletters, shopping, work, and all domains. |
| Sort controls | Toggle between `Recent` and `Priority`. |
| Thread cards | Show sender, subject, snippet, account, message count, priority/cleanup chips, attachment chips, and stronger unread styling. |
| Thread detail | Shows subject, participants, provider/account chips, AI summary, manual compose, editable AI draft, attachments, received/sent messages, and commitments. |
| Agent Rail | Cleanup, follow-up, reply, forward, mark done, prep thread, extract todos, schedule, refresh intel, handoff, quick replies, snippets, automations, and quick actions. |
| Mailbox Ask | Searches local FTS and evidence; can return ranked threads and attachment matches, with LLM summaries when configured. |
| Sender cleanup | Ranks noisy senders by recent volume, cleanup candidates, read/action rate signals, and estimated weekly reduction. |
| Client readiness | Shows provider backends, capabilities, folders, labels, identities, signatures, compose drafts, queued actions, failed actions, and sync health. |
| Mission Control handoff | Turns a thread into a company issue with mailbox evidence and an operator wake-up. |
| Research rail | Shows contact identity, linked channels, relationship timeline, recent subjects, and preferred channel hints. |

## Normal Email Client Actions

Inbox Agent supports direct email handling in the selected thread:

- **Reply** opens a manual composer with the latest inbound sender prefilled.
- **Reply all** includes the latest inbound sender plus other non-self recipients.
- **Forward** opens a manual composer with a forwarded-message block and no prefilled recipient.
- **Cc/Bcc** are supported in the manual composer.
- **Send** routes through the connected provider path: Gmail API for Gmail, AgentMail reply-all for AgentMail replies, and SMTP for IMAP/SMTP accounts.
- **AI draft send** sends the edited subject/body visible in the draft card, not the original generated text.
- **After send**, reply-needed state and the draft card are cleared for replies. Forwarding does not mark the original thread as handled.

Current compose boundary:

- The replacement-grade compose/outbox schema and IPC APIs exist for provider-backed drafts, scheduled send, undo send, and queued sends.
- The visible thread-level manual composer currently sends directly through the existing provider path.
- A full background outbox worker that drains queued compose drafts into Gmail API, Microsoft Graph, or SMTP is still a future provider execution pass.

## Read, Unread, Done, And Commitments

`Unread` is a provider-backed message state. When supported, `Mark read` and `Mark unread` update the server mailbox, then reconcile local cache state. Gmail requires the Gmail modify scope for read-state changes.

`Needs reply` is an agent classification. It can be cleared when:

- you send a reply from Inbox Agent
- you use `Mark done` after handling the thread elsewhere
- the thread is reclassified and no longer needs a reply

`Open commitments` are extracted follow-up items, not the same thing as unread mail. If a commitment was already handled, use `Mark done` on the thread or update the commitment state in the commitments section.

## Autosync And Local Cache

Inbox Agent loads cached mail immediately on startup and refreshes in the background. Autosync runs periodically while the app is open and syncs a bounded recent batch so the inbox behaves more like a normal mail client without blocking the UI.

Sync principles:

- provider state is the source of truth for read/unread, archive/trash, sent mail, and supported labels/folders
- local state stores cached message content, classification, Today/domain buckets, summaries, commitments, drafts, attachment metadata, and automation state
- ordinary listing is never blocked by attachment text extraction or LLM classification
- the UI can show "syncing", queued, failed, and reconnect states separately from cached mail

## Attachments And Ask

Attachment handling is local-first and on demand:

- sync stores attachment metadata such as filename, MIME type, size, provider message id, and provider attachment id
- attachment bytes are not downloaded during ordinary sync
- text extraction runs only when Ask/search needs attachment text or the user explicitly opens/extracts an attachment result
- extracted text is cached locally for later search
- supported extraction targets include PDF, DOCX, HTML, and plain text-like files where provider fetch support exists
- failures and unsupported types are recorded without breaking inbox listing

Mailbox Ask uses local retrieval first. When an LLM provider is configured, it can add a concise answer over the ranked evidence. Without an LLM, Ask still returns ranked local results.

## Voice Input

The inbox has two voice entry points:

- the microphone next to `Search threads...` fills the search box and reloads matching threads
- `Speak reply` in the reply area appends dictated text into the reply composer without sending

Desktop behavior:

- Electron does not rely on Chromium's Web Speech service because it can request microphone permission but still fail when the speech-recognition backend is unavailable
- desktop transcription uses the configured OpenAI or Azure speech-to-text provider in `Settings > Voice`
- if provider transcription is not configured, the mic button shows a configuration message instead of a generic "service unavailable" error

## Provider Support

| Provider | Current Status |
|----------|----------------|
| Gmail | First-class sync, classification, attachment metadata, read/unread, archive/trash where modify scope is granted, Gmail API send for replies, Mailbox Ask, and Gmail forwarding automations. |
| IMAP/SMTP | Sync/read through IMAP and send through SMTP. Read/unread support depends on account connection and provider capability. Archive/trash/labels are more limited than Gmail. |
| AgentMail | AgentMail sync and reply-all support for AgentMail threads. Manual forwarding is not yet available for AgentMail threads. |
| Outlook / Microsoft Graph | Represented in the provider model and capability surface. Dedicated Microsoft Graph mail execution is still planned; existing Outlook-style accounts currently use IMAP/SMTP fallback where configured. |

## Replacement Client Foundation

Inbox Agent now includes the foundation for a replacement-grade email client:

- `MailboxProviderClient` capability mapping for Gmail API, Microsoft Graph, IMAP/SMTP, and AgentMail
- schema for folders, labels, identities, signatures, provider drafts, compose drafts, outgoing messages, queued actions, sync cursors, client settings, attachment metadata, and action state
- shared types and IPC/preload APIs for client state, compose draft creation/update/send/schedule/discard, undo action, Today digest, sender cleanup digest, Ask, and attachment extraction
- list filters for Today bucket, domain category, folder, label, draft, scheduled, queued, attachment presence, and attachment query
- digest metadata for sync health, queued action counts, failed action counts, compose drafts, and scheduled sends
- action audit/event emission for applied actions and downstream automation hooks

Current replacement-client gap:

- native new-mail compose, provider-backed draft save/update, attachment upload, full outgoing queue draining, Microsoft Graph execution, folder/label navigation, and notification preferences still need the next implementation passes before Inbox Agent can fully replace every email-client workflow.

## Gmail Forwarding Automations

Inbox Agent can create native Gmail forwarding automations from the selected thread with `Auto-forward...`.

What the flow does:

- creates a mailbox automation with sender/domain filters, optional subject keywords, attachment extension filters, and a target recipient
- stores the selected Gmail `providerThreadId` so thread-created automations stay scoped to that Gmail conversation
- supports `dry-run` mode first so candidate messages can be labeled and audited before enabling real sends
- reconstructs and sends a new MIME email with matched attachments instead of relying on Google Apps Script forwarding
- tracks per-message dedupe and a persistent scan watermark so recurring runs survive app restarts and laptop sleep

Operational notes:

- Gmail modify scope is required because the automation creates labels, updates thread labels, fetches attachments, and sends mail
- candidate, rejected, and forwarded Gmail labels are status cues, not permanent search exclusions
- dry-run keeps the scan watermark unchanged so the same candidate set can be inspected repeatedly

## Event Pipeline

Every meaningful mailbox action emits a normalized mailbox event. Events currently drive:

- Knowledge Graph enrichment for people, organizations, projects, and observations
- Heartbeat signals for stale threads, open loops, cleanup candidates, and mailbox health
- trigger evaluation for downstream actions
- playbook capture for repeated inbox patterns
- daily briefing summaries
- unified identity and relationship timeline updates across email and linked channels
- Mission Control handoff records so inbox-originated issues stay traceable

## Privacy And Safety

- Mailbox bodies, summaries, excerpts, and attachment text stay in the local database.
- Attachment bytes are fetched on demand, not during ordinary sync.
- Scripts and unsafe active content in email HTML remain blocked.
- Remote images may load according to the product setting, but active content is not executed.
- Sensitive-content detection is surfaced as a warning and metadata cue, not a hard block.
- Sending, archiving, trashing, marking read/unread, scheduling, and forwarding remain gated by provider permissions.
- Automatic destructive or send actions require explicit future rules; agent suggestions do not silently execute bulk/destructive actions.

## Typical Workflow

1. Open Inbox Agent and let cached mail appear immediately.
2. Use Classic mode for a familiar thread list or Today mode for the agent-first action lanes.
3. Filter by view, category, saved view, domain, account, or search.
4. Open a thread and review summary, message content, attachments, commitments, and the Agent Rail.
5. Use `Reply`, `Reply all`, or `Forward` for normal manual email.
6. Use `Prep thread` or `Draft a reply with AI` when you want agent help, then edit the generated draft before sending.
7. Use `Mark done` when you handled the email elsewhere and want it removed from Needs reply/Open commitments.
8. Use Mailbox Ask for evidence-backed search across threads and attachment text.
9. Use Sender cleanup or bulk selection to clear noisy senders.
10. Hand off company-level issues to Mission Control when email becomes operational work.

## Related Docs

- [Features](features.md) for the broader product feature index
- [Use Cases](use-cases.md) for copy-paste inbox workflow prompts
- [Inbox Agent Product Plan](inbox-agent-product-plan-implementation.md) for roadmap and implementation slices
