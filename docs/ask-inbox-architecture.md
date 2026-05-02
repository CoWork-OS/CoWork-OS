# Ask Inbox Architecture

Ask Inbox is the mailbox-specific agentic question surface inside Inbox Agent. It is not a generic task run and it is not a thin text search box. It is a run-scoped mailbox agent that plans the question, searches multiple evidence sources, reads the strongest matches, streams progress into the UI, and answers with provenance.

The current implementation has two entry points:

- the left Inbox Agent **Ask your mailbox...** quick launcher
- `@Inbox` / `@inbox ...` from the main composer

Both routes open Inbox Agent, switch the right sidebar to the **Ask Inbox** tab, and run the question there.

## Product Model

Ask Inbox sits in the right Inbox Agent sidebar beside **Agent Rail**:

| Tab | Purpose |
|-----|---------|
| Agent Rail | Thread actions, cleanup, follow-up, compose, commitments, snippets, handoff, and thread intelligence. |
| Ask Inbox | Mailbox questions, live agentic steps, final answers, and matched email evidence. |

The left ask field remains a quick launcher. It does not own answer presentation. Submitting a question:

1. creates a session-local ask run
2. switches the right sidebar to **Ask Inbox**
3. appends the user question to the Ask Inbox transcript
4. streams backend progress steps for that run
5. renders the final answer and matched email evidence

The Ask Inbox tab also has its own composer so the user can continue asking follow-up mailbox questions without returning to the left thread list.

## Retrieval Pipeline

Ask Inbox uses a hybrid search pipeline implemented by `MailboxAgentSearchService`.

The pipeline is intentionally broad first, then selective:

1. **Classify instruction/action intent**  
   Detect whether the prompt is a question, a safe mailbox action request, or a follow-up-draft instruction.

2. **Plan mailbox search**  
   Extract entities, organization/sender hints, dates, payment/statement/invoice terms, attachment hints, and provider query variants.

3. **Search local FTS**  
   Search the synced local mailbox text with normalized keyword variants.

4. **Search semantic mailbox index**  
   Use the local mailbox embedding index for prompts where exact words differ from the email wording.

5. **Search provider-native mail when available**  
   Ask connected Gmail or Outlook/Microsoft Graph providers for additive candidates. Provider search is best-effort; local search remains the fallback.

6. **Extract/read attachments when relevant**  
   For invoices, statements, extracts, PDFs, payment notices, and related prompts, include attachment metadata and cached extracted text. Candidate attachment extraction is lazy and local-first.

7. **Shortlist and read evidence**  
   Deduplicate by thread/message, read full body and relevant attachment text for top candidates, and rerank by lexical, semantic, provider, recency, entity, and attachment/body evidence signals.

8. **Generate answer or create drafts**  
   If the prompt is an answerable question, generate a concise answer over the evidence. If it is a safe follow-up-draft request, create reviewable drafts instead of silently sending.

The key behavior is that Ask Inbox can answer prompts such as:

```text
when do I need to make a payment to QNB bank for my credit card
```

even when the relevant email says `QNB E-Ekstre`, `Hesap Ozeti`, or `Son Odeme Tarihi` instead of repeating the exact user wording.

## Evidence Sources

Each result can carry source metadata:

- `local_fts`
- `local_vector`
- `provider_search`
- `attachment_text`

Matched result rows include the ranked thread, optional matched attachment, snippet, score, matched fields, evidence snippets, and search-source labels. The UI shows those source labels in the Ask Inbox matched-email list and opens the selected thread when clicked.

## Progress Events

Ask Inbox streams transient run-scoped events through a dedicated IPC channel:

```text
mailbox:askEvent
```

The event type is `MailboxAskRunEvent`:

- `runId`
- `timestamp`
- `type`: `started`, `step_started`, `step_completed`, `completed`, or `error`
- `stepId`
- `label`
- `detail`
- `status`: `running`, `done`, or `error`
- optional `payload`

The renderer generates a `runId` and passes it to `askMailbox`. The backend emits only events for that run. The Ask Inbox UI filters by `runId`, so simultaneous or late events do not attach to the wrong transcript item.

These progress events are deliberately separate from persisted mailbox automation events. They must not use `MailboxEvent`, because persisted mailbox events can trigger automations, Heartbeat, Knowledge Graph enrichment, playbook capture, or downstream mailbox rules. Ask progress is UI-only runtime telemetry.

## Action Boundary

Ask Inbox can retrieve, summarize, and create reviewable drafts. It does not add a new destructive automation lane.

Current safe behavior:

- answering questions from local/provider evidence
- showing related emails when evidence is incomplete
- creating reviewable follow-up drafts for explicit follow-up prompts
- reporting searched scopes honestly when provider search or attachment extraction is unavailable

It does not silently send, archive, trash, mark done, bulk mutate, or create destructive rules from an Ask question.

## Local-First Data Boundary

- Mailbox bodies, summaries, excerpts, embedding chunks, and extracted attachment text stay in the local database.
- Attachment bytes are fetched on demand, not during ordinary sync.
- Local embeddings use the app's local embedding pattern and are incrementally updated/backfilled.
- Provider-native search is additive and best-effort. If it fails, Ask Inbox falls back to local FTS/vector evidence and reports the search scope through results and errors.

## Implementation Map

Core files:

- `src/renderer/components/InboxAgentPanel.tsx` — Agent Rail / Ask Inbox tabs, launcher behavior, transcript, step timeline, evidence list, right-sidebar composer
- `src/electron/mailbox/MailboxService.ts` — ask orchestration, action-intent handling, progress emission, answer generation, provider adapters
- `src/electron/mailbox/MailboxAgentSearchService.ts` — query planning, hybrid retrieval, candidate merge/rerank, attachment-aware evidence
- `src/shared/mailbox.ts` — `MailboxAskInput`, `MailboxAskResult`, `MailboxAskRunEvent`
- `src/shared/types.ts` — `MAILBOX_ASK_EVENT`
- `src/electron/ipc/handlers.ts` — `MAILBOX_ASK` handler and transient ask-event forwarding
- `src/electron/preload.ts` — `askMailbox()` and `onMailboxAskEvent()`

Focused checks:

```bash
npx vitest run src/electron/mailbox/__tests__/MailboxAgentSearchService.test.ts
npx tsc -p tsconfig.electron.json
npm run type-check
```

UI regressions to protect:

- submitting from the left ask field switches the right sidebar to **Ask Inbox**
- streamed events update only the matching `runId`
- matched email rows stay aligned across selected/unselected state and long titles
- clicking matched evidence opens the corresponding mailbox thread

