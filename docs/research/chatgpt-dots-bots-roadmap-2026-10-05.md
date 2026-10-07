# ChatGPT Dots: research and a roadmap for CoWork bots

Research date: 5 October 2026. CoWork source baseline: working tree on top of
`596d8ed5fb4e7d16378452dfffa345795bd5b85e`, including existing local changes.

The recommended direction is to make a CoWork bot responsible for ongoing work,
with an inspectable work queue, clear boundaries, useful notifications, and
verified outputs. CoWork already has much of the underlying machinery. The main
work is connecting those capabilities to the bot surface and making unattended
execution reliable across runtimes.

Bot identities and team membership are user configuration. This roadmap does not
assume a global roster, a default coordinator, or particular personal bots. The
concrete delivery plan is in
[Bots implementation improvement plan](/Users/mesut/Downloads/app/cowork/docs/research/bots-implementation-improvement-plan-2026-10-05.md).

This is a research proposal. The CoWork findings below come from source inspection.
The running development app was also observed, but bot execution, channel delivery,
daemon parity, and recovery were not tested in this review. The already-open
ChatGPT Dots page displayed “Dots aren't available on your plan yet”; no live
Dot was created or tested. No product code or configuration was changed during the research review.
Subsequent implementation progress is tracked in the linked implementation plan.

## What is documented about ChatGPT Dots

OpenAI announced Dots on 29 September 2026. It describes a persistent agent powered
by GPT-6 Astra with its own cloud computer and access to connected plugins. The
launch starts with one primary Dot; additional Dots and teams are a future direction.
Organization-owned specialist Dots, with dedicated identities and credentials, are
being introduced through focused enterprise pilots. They should not be treated as
a generally available multi-agent enterprise product. [OpenAI announcement](https://openai.com/index/introducing-dots/)

The documented product patterns are:

| Pattern | What OpenAI documents | Relevant lesson for CoWork |
| --- | --- | --- |
| Ongoing responsibility | A Dot can coordinate multiple tasks, pause and resume work, use background agents, and follow up at a suitable time or supported event. Fixed recurring work has a saved schedule. | Connect bot conversations to explicit responsibilities, work tasks, triggers, and outcomes. |
| Persistent context | Conversation context, ChatGPT memory, and the Dot's private notes serve different purposes. Delegated tasks receive selected context rather than every conversation. | Keep durable summaries and scoped handoff context; avoid indiscriminate transcript copying. |
| Channel continuity | ChatGPT, Slack, Teams, and calls reach the same Dot. Channel transcripts remain distinct and private context does not automatically become shareable. | Bind channels to a verified bot identity and preserve audience boundaries. |
| Separate execution environment | The cloud computer retains files and browser sessions. Local access is optional; an attached local computer must remain online with the app open. | Separate availability, execution location, and authority in the bot profile. |
| Human intervention | Users can inspect the computer, take control, sign in privately, and return control. | Make waiting states and takeover requests easy to find and resume. |
| Action boundaries | Existing app permissions, instructions, optional custom rules, and automatic review govern actions. Unassigned proactive research uses restricted tools. | Enforce research and action modes in the runtime, with a concrete approval preview. |

The first two rows are supported by [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory);
channel behavior by [Messaging](https://learn.chatgpt.com/docs/dots/channels);
execution and takeover by [Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps);
action behavior by [Controls](https://learn.chatgpt.com/docs/dots/controls).

Important current limits and qualifications:

- Pro access is rolling out to adults outside the EEA, UK, and Switzerland;
  Business Premium is rolling out worldwide, and Enterprise access requires an
  administrator to enable it. Eligibility does not guarantee immediate access.
  Portugal is in the excluded Pro region. Conversation usage and Work/Codex task
  usage are accounted for separately. [Availability](https://learn.chatgpt.com/docs/dots#access)
- Texting is coming soon. Users can start voice calls; Dot-initiated calls are
  planned for after launch. [Messaging](https://learn.chatgpt.com/docs/dots/channels)
- Pausing the primary Dot, stopping delegated work, and canceling schedules have
  different effects. This creates an opportunity for clearer collective controls
  in CoWork. [Stop work](https://learn.chatgpt.com/docs/dots/controls#stop-work)
- The FAQ says individual Dot memories cannot currently be viewed, deleted, or
  directly edited. Disconnecting a plugin stops new access but does not erase
  context already retained. [Privacy FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)
- OpenAI says proactive research cannot send messages, modify connected apps, or
  control a computer. Its separate action-review enforcement is outside the
  environment the Dot can modify. These are documented safeguards, not guarantees
  independently established by this review. [Safety design](https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/)

## What CoWork already has

These are source-level findings, not fresh runtime acceptance results.

| Existing foundation | Evidence in the current checkout | Implication |
| --- | --- | --- |
| Persistent bot identities | [AgentRole](/Users/mesut/Downloads/app/cowork/src/shared/types.ts:5933) includes provider/model overrides, capabilities, tool restrictions, heartbeat policy, budget fields, and an operator mandate. | Expand the existing bot rather than create a competing agent identity. |
| Persistent collaboration | [AgentTeamStore](/Users/mesut/Downloads/app/cowork/src/electron/agents/AgentTeamRepository.ts:82) stores workspace-scoped teams and membership. [bot-team.ts](/Users/mesut/Downloads/app/cowork/src/electron/agents/bot-team.ts:10) contained named-role seeding in the reviewed baseline; stage 1 separates this from generic bot lifecycle. | Support explicitly configured collaboration without assuming personal bot identities are product defaults. |
| Durable conversations and handoffs | [Bots guide](/Users/mesut/Downloads/app/cowork/docs/bots-and-conversations.md:191) describes workspace/team checks, stable receipts, recovery, and collaboration projections. | Extend existing task/session projections instead of introducing a second transcript database. |
| Event-aware background decisions | [HeartbeatPulseEngine](/Users/mesut/Downloads/app/cowork/src/electron/agents/HeartbeatPulseEngine.ts:60) handles signals, foreground deferral, cooldowns, and dispatch budgets. | Build on this scheduler rather than add continuous model polling. |
| Shared dispatch throttling | [BackgroundDispatchBudget](/Users/mesut/Downloads/app/cowork/src/electron/agents/BackgroundDispatchBudget.ts:1) coordinates several background producers. | Preserve the shared authority and make its ledger survive restarts. |
| Role-aware channel routing | [router.ts](/Users/mesut/Downloads/app/cowork/src/electron/gateway/router.ts:6857) resolves a role from routing, specialization, session preference, or channel defaults. | Per-bot channel setup can expose an existing runtime capability. |
| Sender provenance | [gateway-sender-identity.ts](/Users/mesut/Downloads/app/cowork/src/electron/gateway/gateway-sender-identity.ts:1) requires positive owner evidence and keeps group/third-party attribution separate. | Cross-channel continuity must preserve these identity protections. |
| Inspectable memory | [MemoryHubSettings](/Users/mesut/Downloads/app/cowork/src/renderer/components/MemoryHubSettings.tsx:95) exposes knowledge, review, sources, health, and settings, including deletion actions. | Make the existing Memory Hub discoverable from a bot. |
| Outcome verification | [WorkSessionContractService](/Users/mesut/Downloads/app/cowork/src/electron/sessions/WorkSessionContractService.ts:253) stores objectives, requirements, waits, and evidence. | Show what was verified and delivered directly in bot results. |
| Shared work context | [WorkContextService](/Users/mesut/Downloads/app/cowork/src/electron/workspaces/WorkContextService.ts:32) links tasks and managed sessions within workspace boundaries. | Use this for durable briefs and handoffs. |
| Existing voice | [useVoiceTalkMode](/Users/mesut/Downloads/app/cowork/src/renderer/hooks/useVoiceTalkMode.ts:46) and [VoiceService](/Users/mesut/Downloads/app/cowork/src/electron/voice/VoiceService.ts:127) provide speech capture and replies. | Add coordination and decision continuity before investing in a separate voice stack. |

CoWork's existing multi-provider configuration, editable roles, team primitives,
local execution, and memory controls are useful foundations for differentiation.
Whether they produce a better experience than Dots needs direct task comparisons.

## Recommended improvements, in priority order

### 1. Give every bot an inspectable work view

The current [BotDetailsRail](/Users/mesut/Downloads/app/cowork/src/renderer/components/BotDetailsRail.tsx:282)
shows the current conversation and notification settings. The
[profile editor](/Users/mesut/Downloads/app/cowork/src/renderer/components/BotProfileDialog.tsx:149)
updates identity, description, instructions, icon, and color. Neither currently
brings the richer role and automation configuration together in that compact surface.

Add a bot work view with **Needs you**, **Working**, **Scheduled**, and **Results**.
Include ordinary work tasks assigned to the bot and its delegated work; querying
only `botConversation: true` would miss much of the useful activity. Retain the
current conversation history separately.

Offer “Give this bot a responsibility” after creation. Capture the desired result,
sources, trigger, permitted actions, review boundary, notification destination,
and budget. Reuse role/mandate fields, WorkContexts, routines, and outcome contracts.
Add binding metadata only where those objects cannot represent the relationship.

Apply the same experience to any user-created bot. If the user configures a team,
allow explicit handoffs between its members. The user should be able to add a
detail or ask for status while work continues.

Acceptance: assign two responsibilities, inspect their tasks and outputs from one
bot, change one priority, and confirm the other task keeps progressing. Opening
the work view must not start execution or create unsolicited model messages.

### 2. Make unattended operation consistent and restart-safe

The Node daemon initializes channels and cron in
[main.ts](/Users/mesut/Downloads/app/cowork/src/daemon/main.ts:438).
Heartbeat and EventTriggerService initialization were found in
[Electron startup](/Users/mesut/Downloads/app/cowork/src/electron/main.ts:3217)
and [the trigger setup](/Users/mesut/Downloads/app/cowork/src/electron/main.ts:3690),
not in the Node daemon startup or AgentDaemon initialization paths inspected here.
Treat this as a concrete service-parity gap to validate before advertising the
complete bot experience as available with the laptop off.

Extract shared automation initialization for desktop and Node, with explicit
capability reporting. A remote daemon can run server-compatible tools; local GUI
work should show that it is waiting for an available desktop.

The shared background dispatch budget explicitly uses an in-memory ledger that
resets on restart, while Heartbeat's separate per-agent limit is database-backed.
Persist workspace budget tickets and per-entity cooldowns so restart does not
reset the shared allowance across producers. This finding is visible in
[BackgroundDispatchBudget](/Users/mesut/Downloads/app/cowork/src/electron/agents/BackgroundDispatchBudget.ts:12).

Acceptance: restart during queued work, waits, and cooldowns; preserve role,
context, next wake, budget, and action identity. Replay an incoming event and
confirm it does not produce duplicate work. Validate server work with the desktop
offline and report unsupported local actions accurately.

### 3. Make Slack and Teams useful decision surfaces

CoWork's [Slack sender](/Users/mesut/Downloads/app/cowork/src/electron/gateway/channels/slack.ts:180)
posts text chunks, and the [Teams sender](/Users/mesut/Downloads/app/cowork/src/electron/gateway/channels/teams.ts:528)
sends text activities. The shared outgoing message supports inline keyboards,
but these two send paths do not render them. Existing approval routing already
knows how to return a child's request to its originating session; extend it.

Add a typed decision/result payload rendered as Slack Block Kit and Teams Adaptive
Cards: draft preview, **Approve**, **Request changes**, **Open result**, and **Stop**.
Keep a text fallback. Platform implementation references are
[Slack Block Kit](https://docs.slack.dev/block-kit/) and
[Teams Universal Actions](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/universal-actions-for-adaptive-cards/work-with-universal-actions-for-adaptive-cards).

Bind each actionable card to a durable request, authorized actor, exact draft
revision, recipient/destination, expiry, and one-use execution identity. A click
should resolve the existing runtime approval, then recheck current policy.
Validate transport authenticity using the platform's supported mechanisms;
see [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/).

Expose “Connect this bot” in the profile using existing role-aware routing.
Different channels can share relevant context without mirroring private messages
or treating every paired sender as the owner.

Acceptance: approve an exact draft in Slack, observe the same result in desktop,
and repeat with Teams. Duplicate clicks, an unauthorized actor, changed content,
revoked access, and a daemon restart must not cause an unintended action.

### 4. Offer safe proactive research with explicit scope

Add a visible “Watch these sources” responsibility that reads permitted updates,
maintains notes, and proposes useful next steps. Unchanged checks should stay
quiet. Connect source freshness and evidence to the existing SuggestionSink,
memory review, and heartbeat signals.

Use distinct execution boundaries for observation and already-authorized action
work. CoWork already has enforced read-only worker profiles, but
[the resolver](/Users/mesut/Downloads/app/cowork/src/electron/security/access-profile-resolver.ts:273)
deliberately blocks shell and dynamically discovered MCP effects. Enabling
proactive connector reads requires a deliberate read-method catalog or existing
scoped ingestion paths; simply loosening that profile would weaken its boundary.

Keep checks cheap: existing events, source changes, cached summaries, cooldowns,
and budgets should precede model calls. Display what the bot is watching, the
last successful check, the next wake, and the reason for any notification.

Acceptance: a relevant source change creates one evidence-linked suggestion;
unchanged data creates none. Source content cannot authorize sends, writes,
computer use, or wider access. Authorized routines keep their own scoped policy.

### 5. Make memory and completion evidence a visible advantage

Add “What this bot knows” and “Why it suggested this” links into the existing
workspace-scoped Memory Hub. Show source, date, subject, and applicable scope;
allow the user to correct or remove supported items. Introduce bot attribution
only where it is missing; do not fork the memory system into a separate store.

Use the WorkSession outcome contract in a compact result card: requested outcome,
artifact, verification evidence, delivery receipt, and remaining limitations.
Distinguish a prepared draft, passed local tests, passed remote checks, and an
acknowledged external delivery. A completed agent run alone is insufficient.

Acceptance: correct a memory and verify subsequent recall and derived summaries
use the correction. Disconnect a source and show that new ingestion stopped;
offer an explicit forget-source operation with clear retention behavior where
supported. Results must surface missing verification and delivery failures.

### 6. Improve collective controls, then add voice coordination and remote computers

Provide clear controls for stopping the current turn, stopping a bot's active
work, and disabling its future routines. If a “Pause all work for this bot”
control is added, define its effect on delegated tasks and unrelated teammate
work, and show a receipt of what stopped and what remains running.

Connect voice to the same responsibilities and WorkSessions: hear a quick status,
change priorities, and persist confirmed decisions while workers continue.
Ending a call should have a clear effect on the conversation and ongoing work.

Persistent per-bot browser/computer environments are a later infrastructure
option. Investigate existing Docker/E2B sandbox and device capabilities first.
Require separate state, accounts, filesystem scope, quotas, inspectability, and
human takeover. A shell sandbox alone is not evidence of a complete persistent
desktop environment. Do not make hosted computers a prerequisite for the first
bot experience improvements.

## Useful external implementation references

CopilotKit's **OpenDots** is a separate open-source template, released on
1 October. It offers specialist agents, Pages, per-agent computers, Slack, calls,
and background work, built around CopilotKit and AG-UI. Its authors explicitly
describe it as an early single-owner starting point. Use its code as a reference
for interaction and isolation patterns; assess hosting, authorization, and data
ownership before adopting services. [CopilotKit announcement](https://www.copilotkit.ai/blog/introducing-opendots),
[source repository](https://github.com/CopilotKit/OpenDots),
[security guidance](https://github.com/CopilotKit/OpenDots/blob/main/SECURITY.md)

AG-UI is worth considering when an external agent needs to stream work into
CoWork's UI. It is an interaction protocol, so CoWork's own policy enforcement
must remain authoritative. Adopting it is optional; current native adapters do
not need to be replaced to add cards. [AG-UI documentation](https://docs.ag-ui.com/introduction)

Early public reactions are mixed. One user thread reports slow simple actions and
computer-use trouble; another finds daily multitasking helpful while describing
unclear context limits and incomplete work. These are anecdotes, not comparative
benchmarks. They suggest testing responsiveness, interruption, clear scope, and
artifact-level completion before making quality claims.
[Critical account](https://www.reddit.com/r/codex/comments/1wtub3i/chatgpt_dots_so_far_too_slow_to_be_useful_for/),
[more positive account](https://www.reddit.com/r/ChatGPT/comments/1wvqb0u/ive_tried_dots_and_it_doesnt_suck/)

The public material reviewed did not establish a supported API for directly
controlling a user's ChatGPT Dot or expose the Dots runtime as open source. Keep
ChatGPT product features, OpenAI agent APIs, and the OpenDots template distinct.

## Delivery order and a concrete first workflow

1. Remove named-role assumptions from startup, conversation recovery, and peer
   discovery while preserving existing user bot records and history.
2. Build the bot work projection; expose assigned work, evidence, routing, and
   availability through that view.
3. Validate/fix desktop–Node automation parity and persist shared dispatch budgets.
   Add explicit responsibilities, scoped observation, and collective stop controls.
4. Add native Slack decisions, then Teams, using the existing approval authority,
   durable channel mappings, and compatibility fallbacks. Evaluate voice and
   persistent remote computers after the core workflow is proven.

A useful first workflow for CoWork itself:

> Give a user-selected bot a responsibility to watch an explicitly selected
> feedback source for recurring CoWork issues. It groups duplicate reports and
> proposes a focused follow-up with source links and expected results. The user
> authorizes implementation when needed; any delegation uses only explicitly
> configured team membership. The bot brings back a review card with the draft
> change, evidence, and remaining checks. Merge and publication remain within
> the user's chosen approval boundary.

Measure useful completed outcomes, time to acknowledge and produce a result,
duplicate work/actions, approval friction, idle model cost, and recovery after
restart. Use fixed scenarios with artifact and delivery checks rather than model
self-reports. Preserve existing workspace/team, sender identity, and access-profile
boundaries throughout implementation.

Before release, the relevant bot, heartbeat, gateway, memory, and WorkSession tests
should pass, both desktop and Node builds should succeed, and authenticated live
acceptance should prove the workflow. This research did not run those checks.
