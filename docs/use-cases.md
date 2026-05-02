# Use Cases: Capability Map + Test Prompts

This doc provides copy-paste prompts you can run to validate each flow end-to-end.

## Ideas Panel

The **Ideas** tab in the sidebar shows use case prompts that use built-in capabilities (channels, inbox, /inbox, /brief, /simplify, /batch, /llm-wiki, browser, file I/O). See [Ideas Capabilities](ideas-capabilities.md) for what’s supported. Advanced use cases (e.g. legal skills) require optional skills and are listed below as copy-paste prompts.

## Use Case Coverage (High Level)

Use cases:
- Stay on top of messages (reply drafting + send-on-confirmation)
- Monitor things (newsletters, transactions)
- Household logistics (capture tasks, keep you on track)
- Booking + forms (find availability, fill forms, stop before final submit)
- Visibility for others (daily digest to family)
- Inbox autopilot / Inbox Agent (triage, drafts, cleanup suggestions, commitment tracking)
- Inbox sent-mail review and follow-up capture
- Contact intelligence enrichment from email threads
- Cross-channel reply from Inbox Agent (Slack, Teams, WhatsApp, Signal, iMessage)
- Manual identity search and link review
- Mission Control handoff for inbox threads
- Inbox-aware briefing and Heartbeat follow-up
- Chief-of-staff briefing (morning executive brief)
- Dev task queue management (agent-ready backlog execution)
- Turn a successful one-off task into a recurring scheduled check from the task menu
- Founder-directed autonomous company operations ("zero-human company" loop)
- Everything Workbench for generated docs, sheets, decks, web pages, PDFs, and previews
- Smart-home orchestration via integrations
- "Figure it out" fallback orchestration for hard tasks

Cowork OS supports these via:
- Channels: Slack, iMessage, WhatsApp, Telegram, Email, etc.
- Scheduling: `/schedule ...`, `schedule_task`, and task view `... > Add automation...`
- Inbox + briefing commands: `/inbox`, `/brief [morning|today|tomorrow|week]`
- Message box shortcuts: one `/` picker for app commands such as `/schedule`, `/clear`, `/plan`, and `/cost`, plus skill-backed workflow aliases from plugin packs
- Slash skill workflows: `/simplify [objective] ...` for quality passes, `/batch <objective> ...` for parallelizable migration/transform workflows, `/llm-wiki <objective> ...` for persistent research vaults, and CoWork Shortcuts aliases such as `/strategy`, `/batch-rename`, `/gmail-summary-drive`, `/multi-source-report`, and `/end-of-day-log`
- Integrations: Notion, Gmail/Google Calendar (if configured), Apple Calendar/Reminders (macOS)
- Web automation: visible Browser Workbench for normal-user site testing, with browser tools, screenshots, annotation, and fallback browser modes when explicitly needed
- Company-ops primitives: venture workspace kit, digital twin operators, strategic planner, and Mission Control ops monitoring
- Everything Workbench: task output cards, sidebar/fullscreen artifact workspaces, follow-up composer, and refresh-after-edit behavior for generated knowledge-work artifacts

For the full founder-operated company recipe, see [Zero-Human Company Operations](zero-human-company.md).
For the unified artifact workflow, see [Everything Workbench](everything-workbench.md).
For live website testing inside the app, see [Browser Workbench](browser-workbench.md).
For turning existing tasks into scheduled checks, see [Task Automations](task-automations.md).
For message-box app commands and skill-backed workflow shortcuts, see [Message Box Shortcuts](message-box-shortcuts.md).

## Test Prompts (Copy/Paste)

Notes:
- If you don't know a chat ID, the prompt below instructs the agent to use `channel_list_chats` first and ask you to pick a `chat_id`.
- For “stop before sending/booking”, the prompts explicitly force a confirmation gate.

### 1) Stay On Top Of Messages (Draft Reply, Ask Before Sending)

Prompt:
```
Use channel_list_chats for channel "imessage" (since "7d", limit 20). Show me the list and ask me which chat_id corresponds to the person I mean.
After I pick a chat_id, use channel_history (limit 40) to pull the recent conversation, summarize it, and draft 2 reply options.
STOP before sending. Ask me whether to send A, send B, or edit.
```

Variant (Slack):
```
Use channel_list_chats for channel "slack" (since "24h", limit 20). Ask me to pick the chat_id for the thread/channel I care about.
Then pull channel_history (limit 80) and draft a crisp reply (2 variants).
STOP before sending and ask me to confirm.
```

### 2) Monitor Things (Newsletter Digest)

Prompt:
```
Use channel_list_chats for channel "slack" (since "24h", limit 20). Ask me to pick the chat_id where newsletters arrive (Substack/email feed).
Then pull channel_history (limit 150, since "24h") and produce a digest: title/link (if present) + 1-2 sentence summary each.
Propose follow-ups, but do not take external actions unless I confirm.
```

Scheduled version (daily 8am):
```
/schedule daily 8am Summarize new newsletter items from the last 24h in this chat: {{chat_messages}}. Output a digest with links and 1-2 sentence summaries.
```

### 3) Monitor Things (Transaction Scan / Fraud Triage)

Prompt (email channel):
```
Use channel_list_chats for channel "email" (since "14d", limit 20). Ask me to pick the chat_id for my card/bank notifications.
Then pull channel_history (limit 200, since "14d") and extract transactions (date, merchant, amount, currency).
Flag anything suspicious (new merchant, rapid repeats, or unusually large amounts) and recommend next steps.
Do not contact anyone or send messages unless I confirm.
```

Prompt (Gmail integration, if configured):
```
Search my Gmail for transaction notifications from the last 14 days (Amex/bank keywords). Extract transactions into a table and flag suspicious charges.
Do not send emails or contact anyone unless I confirm.
```

### 4) Household Logistics (Capture To Notion + Reminders)

Prompt:
```
Turn this into tasks in my Notion database (ask me for the database_id if you don't already have it):

- Buy storage bins for garage
- Return Amazon package
- Book dentist appointment

For each task, create one Notion page (title = task). If a due date is implied, ask me to confirm it.
If Apple Reminders is available, also create reminders for any due tasks.
Return the created Notion page IDs/URLs and reminder IDs.
```

### 5) Booking + Forms (Find Availability, Cross-check Calendar, Stop Before Submit)

Prompt (OpenTable-style):
```
Open this URL and verify the venue name is correct:
https://www.opentable.com/r/amorim-luxury-group-lisboa

Find openings for 2 people in the next 14 days between 6:30pm and 8:30pm.
Cross-check my calendar for conflicts.
Propose the 3 best conflict-free options.
Persist the compiled options to reservation_options.json.
STOP before final booking and ask me to confirm.
```

### 6) Visibility For Others (Daily Digest Draft, Ask Before Sending)

Prompt:
```
Create a daily digest for "tomorrow" with:
- Calendar events (times + titles)
- Any reminders or scheduled tasks I should remember

Draft it as a short message I can send to my family.
STOP before sending and ask me to confirm the final message and where to send it.
```

### 7) Inbox Autopilot (Triage + Drafts + Cleanup, Ask Before Acting)

Prompt:
```
Run inbox triage in Inbox Agent for the last 24h.
Prefer gmail_action; if unavailable use email_imap_unread; if unavailable use Email channel history.

Classify each message as urgent, today, this-week, or no-action, and also flag action-needed, suggested actions, and open commitments where appropriate.
Output:
- Priority table
- Draft replies for urgent/today items
- Cleanup candidates (newsletter/promotions) with unsubscribe/archive suggestions
- Follow-up reminders to create
- Commitment items that should be tracked as real follow-up tasks

STOP before sending, unsubscribing, archiving, deleting, or labeling anything.
Ask me what to execute.
```

Command shortcut:
```
/inbox autopilot 180
```

### 7A) Inbox Sent-Mail Review

Prompt:
```
Open Inbox Agent and switch to Sent view.
Inspect the selected sent thread, show the email body, summarize what was sent, and list any implied follow-ups or commitments.
If the thread references a person or project, suggest what should be updated in contact memory or the Knowledge Graph.
Do not send, archive, or delete anything. Ask me what action to take next.
```

### 7A.1) Inbox Today Mode Review

Prompt:
```
Open Inbox Agent and switch to Today mode.
Review Needs action, Happening today, Good to know, and More to browse.
For each lane, summarize the top threads and explain why they belong there.
Do not archive, mark done, send, or trash anything. Ask me which lane to work through first.
```

### 7A.2) Ask Inbox Evidence Search

Prompt:
```
Use Ask Inbox to find the invoice, receipt, contract, or attachment I mention below.
Search broadly first, including local mailbox FTS, semantic mailbox matches, provider-native search if available, attachment filenames, and indexed attachment text.
If attachment text is not indexed yet, explain which result needs extraction before relying on it.
Return a concise answer plus the evidence threads, and keep the Ask Inbox step feed visible.

Query: <describe what to find>
```

Main-composer shortcut:
```
@inbox when do I need to make payment for my QNB credit card?
```

### 7A.3) Manual Reply Or Forward

Prompt:
```
Open the selected Inbox Agent thread.
Use the manual email composer, not an AI-generated draft.
Prepare a reply, reply-all, or forward with To/Cc/Bcc, subject, and body filled in.
STOP before sending so I can review the exact message.
```

### 7B) Inbox Commitments And Follow-Ups

Prompt:
```
Open Inbox Agent and find the threads with open commitments or overdue follow-ups.
For each one, extract the commitment, due date, owner, and source email.
Return a short table with:
- thread
- commitment
- due date
- status
- next action
STOP before changing any commitment state. Ask me which commitments to update.
```

### 7C) Inbox Knowledge Graph Enrichment

Prompt:
```
Open Inbox Agent and review the current thread and its related contact info.
Extract people, companies, and projects mentioned in the thread and suggest what should be linked or updated in the Knowledge Graph.
Include related threads, recent subjects, and any relationship signals that would help future replies.
Do not make graph changes automatically. Ask me to confirm any updates.
```

### 7D) Inbox Briefing And Heartbeat

Prompt:
```
Open Inbox Agent and build an inbox-first briefing for today.
Include unread mail, action-needed mail, overdue commitments, drafts in progress, and sensitive threads.
Also note which threads should be escalated into follow-ups or cleanup.
Do not send anything externally. Use the result as a briefing item only.
```

### 7E) Inbox Cleanup And Bulk Triage

Prompt:
```
Open Inbox Agent and identify low-value threads that are safe to bulk archive or trash.
Group them by sender or type, explain why each group is a cleanup candidate, and recommend the safest bulk action.
STOP before applying changes. Ask me which groups to execute.
```

### 7F) Cross-Channel Reply From Inbox

Prompt:
```
Open Inbox Agent and select the current thread.
If the contact is active on Slack, Teams, WhatsApp, Signal, or iMessage, show the best reply target first and draft a reply for that channel.
Use the linked channel only if it is the most recent active channel for the contact.
STOP before sending and ask me to confirm the channel and message.
```

### 7G) Mission Control Handoff

Prompt:
```
Open Inbox Agent and hand this thread off to Mission Control.
Build a preview with the recommended company, operator, issue title, and issue summary.
Require explicit confirmation before creating the issue.
After creation, show the linked handoff record and the issue id.
```

### 7H) Manual Identity Review

Prompt:
```
Open Settings > Integrations > Identity.
Search for a contact by name, email, phone, handle, or CRM id.
Show the best candidate matches, then let me manually link the correct handle to the correct contact identity.
Do not auto-link ambiguous matches.
```

### 8) Morning Briefing Agent (Chief Of Staff)

Prompt:
```
Create my morning chief-of-staff brief.
Include:
- Executive summary (3-6 bullets)
- Calendar risks/prep
- Inbox priorities
- Reminders/tasks due soon
- Optional ops signals if available (weather, urgent GitHub notifications, revenue/payment changes)
- Recommended next actions in urgency order

If any signal source is unavailable, add a Missing Data section.
Format for mobile reading.
```

Command shortcuts:
```
/brief morning
/brief schedule morning weekdays 08:00
```

### 9) Smart Home Brain (Integration-First, Confirm Before State Changes)

Prompt:
```
Act as a smart-home orchestrator for this request: "Set evening mode at home".
First discover available smart-home integrations/tools.
Then produce a dry-run action plan (device + action + expected effect + rollback).
Respect quiet hours 22:00-07:00.
STOP and ask me to confirm before any physical state change.
If integrations are missing, give me a setup checklist and fallback manual steps.
```

### 10) Dev Task Queue Agent (Queue + Parallel Execution + Progress)

Prompt:
```
Build a dev task queue for repo owner/repo from open high-priority issues.
For each item include acceptance criteria, dependencies, risk, and suggested owner (agent or human).
Run up to 8 tasks in parallel and provide progress checkpoints.
For any code changes, summarize diffs and STOP before merge/deploy unless I approve.
```

### 11) "Figure It Out" Agent (Fallback Orchestration)

Prompt:
```
Objective: book a table for 2 next week between 7pm-8:30pm and avoid calendar conflicts.

Try the direct path first. If it fails, switch methods/tools and keep an attempt log:
- attempt number
- method/tool used
- observed result
- failure/success reason

Use up to 3 fallback attempts.
Never claim success without evidence.
STOP before irreversible external actions and ask for confirmation.
```

### 12) Deterministic Slash Workflows (`/simplify`, `/batch`, and `/llm-wiki`)

Prompt:
```
Run /simplify this migration summary for readability and concision while preserving intent.
Simplify to a concise format suitable for handoff.
```

Batch transform pattern:
```
Run /batch update docs and code references that refer to the old "execution pipeline" term:
- Keep behavior unchanged.
- Group edits by domain.
- Produce a per-file checklist and diff summary.
```

Command variants:
```
/simplify review this plan for clarity and edge-case coverage.
/batch migrate markdown architecture docs to the new naming standard --parallel 4 --domain writing --external confirm
/llm-wiki build a research vault for CoWork OS competitors --mode ingest --path research/wiki/competitors
```

### 13) Legal Deal Defense (Contract + Demand Letter + Counterpositions)

Prompt:
```
Use the legal-contract-negotiation-review skill with:
- agreement_path: "docs/purchase-agreement.docx"
- disclosure_schedules_path: "docs/disclosure-schedules.docx"
- counterparty_changes_path: "docs/buyer-demand-letter.pdf"
- client_side: "seller"

If any read_file call is windowed/truncated, continue with startChar until all files are fully covered.
Write the final report to artifacts/legal/negotiation-analysis.md.
```

Prompt (demand letter response draft):
```
Use the legal-demand-letter-response-draft skill with:
- agreement_path: "docs/services-agreement.docx"
- demand_letter_path: "docs/demand-letter.pdf"
- facts_path: "docs/fact-timeline.md"
- client_role: "responding party"
- response_output_path: "artifacts/legal/demand-response-draft.md"
- issues_table_output_path: "artifacts/legal/demand-issues-table.md"
```

Prompt (verified legal research memo):
```
Use the legal-verified-research-memo skill with:
- question: "What U.S. federal and state licensing issues apply to operating a custodial crypto wallet product for consumers?"
- jurisdictions: "United States federal + New York + California"
- output_report_path: "artifacts/legal/research-memo.md"

Require primary authority first and include a claim-level verification log.
```

### 14) Programmatic Technical Video (Manim)

Prompt:
```
Use the manim-video skill to create a 75-second 3Blue1Brown-style explainer for gradient descent aimed at software engineers.

Scaffold the project in this workspace.
Create:
- plan.md
- script.py
- concat.txt
- render.sh
- voiceover.md

Render draft quality only if the local Manim prerequisites are satisfied.
If dependencies are missing, stop after scaffolding and tell me exactly what is missing.
```

Prompt (algorithm visualization):
```
Use the manim-video skill to build a Manim animation that visualizes Dijkstra's algorithm step by step.

Target audience: CS students.
Keep it under 90 seconds.
Prefer an algorithm-visualization structure with one clear idea per scene.
Draft first, production later.
```

Prompt (architecture walkthrough):
```
Use the manim-video skill to create an animated architecture diagram for our request path:
browser -> CDN -> API gateway -> app server -> database.

Focus on clarity over visual density.
Scaffold the local Manim project and produce a render checklist, but do not attempt production render until I review the draft plan.
```

### 15) Designed Editorial Documents (Kami)

Prompt:
```
Use the kami skill to turn notes/company-overview.md into a polished English one-pager.

Scaffold the project in this workspace.
Keep the editable source files.
Render a PDF if local dependencies are available.
If rendering tools are missing, stop after editing the source and tell me exactly what is missing.
```

Prompt (resume refresh):
```
Use the kami skill to build a resume PDF from docs/resume-notes.md.

Target document type: resume.
Language: english.
Keep claims factual and do not invent metrics.
Write the editable source files plus a rendered PDF when possible.
```

Prompt (slides):
```
Use the kami skill to create a restrained slide deck for our product brief from docs/briefing.md.

Target document type: slides.
Prefer editable PPTX output first.
If a local Chromium-family browser is available, also export PDF from the same slide source.
If not, leave me with the source and output.pptx only and tell me what browser dependency is missing.
```

After the task completes, open `output.pptx` from the task output card or Files panel to review it in CoWork's presentation viewer. The viewer shows slide text and speaker notes immediately, then loads cached or freshly rendered slide images in the background. Fullscreen mode keeps the follow-up composer visible so you can request deck changes; the preview refreshes after that follow-up completes and updates the deck.

### 16) Everything Workbench: Generated Web Page Review

Prompt:
```
Create a polished single-page HTML status dashboard for our launch checklist.

Save it as artifacts/launch-dashboard.html.
Use local CSS and JavaScript only.
Make it readable on desktop and mobile.
```

Prompt (React build output):
```
Create a small React/Vite prototype for a customer intake flow.

Build it after implementation so dist/index.html exists.
Use local sample data only.
```

After the task completes, open the generated `.html` file or built `dist/index.html` from the task output card. CoWork opens it in the web page artifact viewer: a sandboxed iframe in the resizable sidebar or fullscreen mode. Use fullscreen mode to request visual or behavior changes through the follow-up composer; the preview refreshes after the relevant HTML or build output is updated. If a React-style project exists without `dist`, `build`, or `out` HTML output, CoWork shows a build-output-needed state instead of auto-starting a dev server.

### 17) Everything Workbench: LaTeX Paper with Compiled PDF

Prompt:
```
Write a LaTeX paper explaining how our app-server request path works.

Use TikZ diagrams where they clarify the architecture.
Save the editable source as artifacts/papers/app-server-paper.tex.
Compile it to artifacts/papers/app-server-paper.pdf with the built-in LaTeX compile workflow.
If no TeX engine is installed, keep the .tex source and tell me which dependency is missing.
```

Expected behavior:

- CoWork writes the `.tex` file first so the source remains editable.
- It calls `compile_latex`, which uses an installed `tectonic`, `latexmk`, `xelatex`, `lualatex`, or `pdflatex` binary.
- The task output pairs the `.tex` source and compiled PDF in one artifact workbench with Summary, source, and PDF tabs.
