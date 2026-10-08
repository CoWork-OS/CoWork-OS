# Bots, conversations, and tasks

This is the canonical guide to CoWork's persistent bot surface. It combines the
end-user tutorial, the runtime contract, and the maintainer reference for the
sidebar Bots view, bot profiles, bot conversations, and the persistent bot team.

Use this page when you need to understand the difference between a reusable bot
and an ordinary task, build a bot workflow, diagnose an empty or missing
conversation, or change the implementation safely.

A task is a piece of work. A bot is a reusable agent identity: its name,
appearance, description, and instructions persist over time. Each bot can have
many conversations. The Bots roster is the parent surface; opening a bot takes
the user to its latest unarchived conversation, and the conversation history
stays available on that same screen.

Bot conversations use the existing task and event storage. A task assigned to
an agent role is not automatically a bot conversation. Only
`agentConfig.botConversation === true` identifies a conversation in the Bots
surface.

## View a bot's work

Use **Work** on the Bots page, the **View bot work** icon beside a bot in the roster,
or the work counts in a bot chat's details rail. The header shows the bot's character,
status (**Active** or **Paused**), a **Pause bot** / **Resume bot** button and a **⋯**
menu with **Stop all running work**, **Stop all and pause** and **What this bot
knows**. A workspace picker switches between workspaces where the bot has work; when
you open it from a temporary workspace with nothing in it, it starts on the busiest
saved workspace. Opening the view does not create a conversation or execute a task.

- **Needs you** shows pending approvals, input requests, pauses, and interruptions
  that need review. **Respond** opens the task and its decision controls.
- **Working** includes assigned tasks and their delegated descendants, including
  persisted child, external, and reconnect waits. Delegated rows are labeled separately.
- **Scheduled** includes queued tasks, enabled saved cron jobs directly assigned to the
  bot in this workspace, and the schedules of its responsibilities. A schedule that
  would be skipped because the bot or the responsibility is paused is labeled
  **Paused** instead of showing a next run. **Manage** opens it in Setup. Saved jobs show their recorded next run time. The
  view distinguishes an available scheduler from a disabled or stopped runtime;
  a saved time does not guarantee future execution.
- **Results** shows terminal work and its recorded verification verdict (**Checked**,
  **Partly checked**, **Check failed** or **Not checked**). **Details** on a result
  shows its outcome contract, requirement checks, evidence and recorded output
  revisions, each rechecked against the current file (matches, changed,
  missing or unavailable). A completed task does not establish delivery, so external
  delivery stays unknown unless a delivery receipt exists.

Archived work, other workspaces, side chats, and unrelated team tasks are excluded.
Empty completed conversations do not become results. Summary pages contain at most
100 rows (25 by default), without raw prompts or transcripts. Refresh and load-more
controls read existing records. The shared Control Plane method is `bot.work.list`,
with existing `read` authorization:

```json
{"workspaceId":"your-workspace-id","agentRoleId":"your-bot-id","view":"working","limit":25}
```

Responses contain `items`, counts for the four views, scheduler state, and an
optional `nextCursor`. Supply that cursor with the same workspace, bot, and view
for the next page. Desktop uses `listBotWork`; the browser host additionally checks
effective workspace read access. Bot names and team membership do not determine
work ownership.

### Responsibilities

**Setup > Add responsibility** binds the bot to one existing paused
routine (or creates a paused on-demand, hourly, daily or weekday routine inline).
A definition records the objective, mode, selected sources, permitted actions,
expected output, review boundary, destination, execution backend and budget.
**Preview run** shows the trigger, next run time and any blockers; **Save paused**
stores an immutable revision without starting anything. **Turn on**, **Run now**,
**Pause**/**Resume** and **Turn off** are separate, explicit actions; turn it off to
edit it. Each run records the
exact definition revision it was admitted under; editing a responsibility returns
it to paused and never authorizes an earlier pending action.

| Mode | What the run may do |
| --- | --- |
| **Observe** | Read only the selected sources and produce an internal result. |
| **Propose** | Prepare an inspectable draft; no effects. |
| **Act within granted scope** | Perform only the exact selected actions. With the **all effects** review boundary each effect waits for an exact one-time review; otherwise only actions outside the grant need review. |

Supported sources are selected workspace files (`read_file`, `list_directory`),
cached history for one exact chat on an enabled channel, and `list_threads` /
`get_thread` for one selected mailbox account. The supported action is a reviewed
workspace `write_file`. Anything else is shown as a blocker and cannot be activated:
unknown connector methods, other event sources, external outputs, deterministic
workflows, remote targets and Slack/Teams destinations. Untrusted event or message
text is never copied into task instructions.

Scheduled and event responsibilities stay quiet when their selected sources are
missing or unchanged: no task is created and no model is called. A changed source
admits one task, and replayed events admit at most one. The headless Node daemon
runs Observe and in-grant work. An Act responsibility that reviews every effect needs
someone to answer an exact review, so it can only be activated in the desktop app and
only with a manual trigger; on a headless runtime, or with a schedule or event
trigger, it reports why and cannot be activated. For unattended Act work, grant the
exact action and use the **outside granted scope** review boundary.

### Controls, notifications and context

Each running item has its own **Stop**. **Pause bot** stops scheduled and new work
from starting for that bot only; running work and other bots continue. The menu's
**Stop all running work** and **Stop all and pause** act on everything the bot is
running in the workspace. Every control is durable: a one-line status reports what
happened, with **Details**, and cleanup that is still pending or failed stays visible
with **Try again** until it is confirmed. Resume never resolves a pending approval or
replays a completed action.

**Setup** holds the bot's responsibilities (each can be paused, resumed, run now, or
turned off to edit), its notifications and a link to its memory.

**Notifications** (in Setup) first chooses what to hear about: **needs a decision**
and **finishes or fails** (the same toggles as the chat's details rail). Turning on
**Also send to the inbox or desktop** routes decisions, meaningful results and
failures to the app inbox, optionally with a desktop alert, with quiet hours and
digests. Routes are off until you enable them. Receipts say **stored in inbox** or **delivery
unknown**; an unknown delivery can be retried explicitly but is never resent
automatically. Stored or cancelled notification records for finished work, and spent
channel decision routes, are pruned after 90 days; unresolved deliveries and the
receipts that make your requests idempotent are kept.

**What this bot knows** (or **Open memory** in Setup) opens the Memory Hub for the
bot's workspace. Items show
their recorded source and date; historical records without recorded bot provenance
appear as shared workspace context. Correcting or forgetting an item affects every
later run. Private owner context is never given to group or non-owner channel tasks.

### Decisions in a bot chat

When a bot in a local desktop chat needs approval, it pauses and asks in the chat, as
other bot apps do: the decision card shows **Deny** and **Allow once**, the roster row
says **Waiting for your decision**, and the request appears in the bot's **Needs
you**. For reading the web, one **Allow for this chat** covers searching and opening
pages for that chat; it ends if the workspace policy or access profile changes. Chats
linked to Slack, Teams or another channel do not show these cards; they use that
channel's own decision path. Reviews of a responsibility's file writes say whether the
file is one the responsibility may write and warn when it is not.

### Slack and Teams decision cards

With **Decision Cards** enabled on a Slack or Teams channel that has saved owner IDs,
an approval for a task started by that owner in a private conversation is published
as a Block Kit or Adaptive Card. The card shows the exact request revision; Approve
and Deny apply once, only from the owner, and only while the request, permissions and
files are unchanged. Group or public conversations, other requesters and older
tasks without a recorded private context get a "review in CoWork" message instead.
Legacy approval buttons on other channels are bound to the revision they displayed;
file, draft and responsibility-write reviews cannot be approved from them and must be
decided in CoWork.

### Control Plane methods

Desktop and the Node daemon expose the same methods under existing scopes:
`bot.work.list`, `bot.work.result`, `bot.work.control.get` and
`bot.work.control.state` (read), `bot.work.stop` (write; also pause/resume),
`bot.responsibility.list|engines|preview` (read) and
`bot.responsibility.create|revise|activate|pause|run|futureRuns` (write),
`bot.notification.route.get|receipts` (read) and `bot.notification.route.update|retry`
(write), `automation.runtime.status` (read) and `bot.metrics.summary` (read).
`bot.metrics.summary` takes `workspaceId`, optional `agentRoleId` and `windowDays`
(1–90) and returns baseline counters: verified outcomes, unresolved waits, committed
and uncertain effects, recovery and delivery states, dispatch reservations and
denials, model usage outside admitted work, and recent work-view latency. These are
recorded counts, not targets.

## Concepts and boundaries

CoWork uses three related but different objects:

| Object | What it represents | Where it lives |
| --- | --- | --- |
| Bot profile / agent role | A reusable identity and execution configuration: name, description, instructions, appearance, capabilities, model/provider overrides, and optional automation policy | `agent_roles` |
| Bot conversation | A durable message stream assigned to one bot | A normal `tasks` row plus `task_events`, marked with `agentConfig.botConversation: true` |
| Persistent bot team | A workspace-scoped collaboration group that lets bot conversations message verified teammates | `agent_teams` plus `agent_team_members` |

The role is the durable identity. A conversation is the place where a specific
exchange happens. A team is an optional collaboration boundary; it does not
replace the role or the conversation task.

This feature is separate from **Managed Agents**. Managed Agents are reusable
control-plane resources that launch normal runtime tasks. Bots are identity-first
conversations that deliberately appear in the Bots roster and can keep many
conversations under one identity. See [Managed Agents](managed-agents.md) when
you need versioned agent definitions, reusable environments, or managed-session
APIs instead.

## Bot vs normal task

| Surface | Normal task | Bot conversation |
| --- | --- | --- |
| Navigation | Sessions list, one row per task | Bots roster, one row per bot |
| Header | Task title and task actions | Bot identity, current conversation, and bot options |
| History | The Sessions list is the history | Conversation history is a list of that bot's conversation tasks on the bot screen |
| Profile | Assigned role, when present | Edit the persistent bot from its identity or sidebar control |
| Lifecycle | Pin, rename, archive, and fork the task | New conversation, pin, rename, archive, branch, and side chat while the bot identity remains stable |
| Routine | Creates repeatable work | Creates repeatable work assigned to the bot's role |
| Desktop access | Uses the task's normal permission policy | Uses the computer running CoWork OS and its local computer-use permissions |

The composer, model selection, tool execution, approvals, attachments, browser,
output viewers, and task persistence remain shared where they are useful.
Explicit output frames render in both kinds of transcript. Bot conversations
can stay compact for chat while retaining the shared activity and replay
controls when a run uses work tools.

## Tutorial: create and use a bot

### 1. Open the Bots surface

Select **Bots** on the left icon rail. The main view opens the Bots page and the
sidebar panel switches to the bot roster. If a bot conversation is open, CoWork keeps **Bots** selected so the roster remains the navigation
context. The roster shows one row per active bot, its current status indicator,
the latest conversation preview, and relative activity time.

The sidebar shows the bot's display name rather than its internal handle. Search
matches the display name, internal name, description, and latest preview. Recent
previews are intentionally plain text: Markdown markers such as `**bold**`,
headings, links, code fences, and list markers are removed so the compact row
does not apply formatting just because the model used Markdown syntax.

### 2. Create a bot

1. Select **New bot** on the Bots page or in the sidebar, or pick a template under
   **Start from a template** to open the same dialog already filled in.
2. Pick a character. Every bot is drawn as one of the illustrated characters, with
   eyes that follow its state.
3. Enter a display name. A stable internal name is generated from it using
   lowercase letters, numbers, and hyphens.
4. Optionally add what it helps with and instructions.
5. Select **Create bot**.

The internal name is used for storage and bot-team addressing; it is not a
second display label in the sidebar. The simple create dialog gives the bot the
default `code` capability. More advanced role settings can be managed through
the Agent Role APIs or the broader Agents surfaces.

### 3. Start the first conversation

Select a bot row. If the bot has an unarchived conversation in the current
workspace, CoWork opens the latest real transcript. Otherwise it creates a
dormant conversation task and opens it without calling the model.

Type the first message in the composer and send it. That first user message
starts execution. Opening a bot, opening an empty conversation, or selecting a
new conversation does not produce an unsolicited assistant response.

### 4. Continue the conversation

Send follow-ups in the same composer. The bot keeps its role identity and
profile while the transcript accumulates user messages, assistant replies,
tool activity, approvals, artifacts, and other normal task events when the
request needs them.

Bot conversations use `hybrid` conversation routing with `execute` execution
permissions by default. This means a bot can remain conversational for simple
messages while still using the normal governed tool pipeline for real work.
The effective provider, model, access profile, approvals, network policy,
filesystem policy, and tool restrictions still come from CoWork's normal task
runtime.

### 5. Start a separate conversation

Open the bot's header menu and select **New conversation**, or choose **New**
inside **Conversation history**. The new conversation starts as another dormant
task assigned to the same bot. It does not change the profile or erase the
existing transcript.

Use **Conversation history** to switch between current and archived
conversations. Archived conversations remain available for explicit review but
are never selected as the automatic resume target.

The same conversation menu also provides **Copy conversation link**, **Copy as
Markdown**, and **Advanced** actions. Copying a conversation link preserves the
task identity for reopening; copying as Markdown exports the visible transcript
without changing the stored task. Advanced actions expose the shared task
controls rather than a separate bot-only execution path.

### 6. Edit a bot

Open the edit control from a bot row, the bot identity in the conversation
header, or the Bot details rail. The profile editor supports:

- **Character**: how the bot is drawn everywhere it appears. Bots saved with an
  older icon or emoji show the closest character until you save a new one.
- **Name**: the human-readable display name.
- **What it helps with**: context shown to the bot and in the details rail.
- **Instructions**: the role-specific system guidance used for a later run.

Descriptions and instructions preserve line breaks and are normalized before
storage. The editor limits each long text field to 12,000 characters. Saved
profile changes apply when the bot starts its next run; an already-running run
may retain the context with which it started.

The profile dialog keeps the **Delete bot**, **Cancel**, and **Save**
actions visible in a fixed footer while the form body scrolls. This keeps the
destructive and commit actions reachable even when the instructions are long.

The Bot details rail also shows the bot's work counts (**Needs you**, **Working**,
**Scheduled**; each opens that view) with a link to **Responsibilities and setup**,
the current conversation status, history, the same "tell me when it needs a
decision / finishes" toggles as Setup, and the host computer status used by
computer-use tools. **Copy bot link** copies a
`cowork://bots/<role-id>` link for the bot roster surface.

### 7. Delete a bot safely

Open **Edit bot**, select **Delete bot**, and confirm. Deleting a custom bot
removes it from active bot lists and disables its heartbeat/automation profile,
but keeps existing conversations, events, activities, and role references for
history. The database deliberately deactivates the role instead of physically
deleting it because tasks and collaboration records still refer to its ID.

System roles cannot be deleted. If a bot is missing after deletion, use
`getAgentRoles(true)` or inspect the role's `isActive` state rather than deleting
database rows manually.

## User-configured bots and teams

Custom bots belong to the user's configuration. CoWork does not install a named
custom roster, select a coordinator by name, or attach every bot to a team.
Standalone bots use the normal task runtime without team membership.

Teams are optional, workspace-scoped collaboration groups. Existing user bot
records, instructions, conversations, teams, and membership remain intact across
startup and recovery. Startup does not rewrite custom instructions or recreate
deactivated bots. The separate system-role/template catalog remains available.

For a team conversation, runtime guidance lists only currently verified active
members and identifies leadership from the configured team record. Bot IDs are
stable selectors even after a rename; names and display names are convenience
selectors. Replies go to the actual requester using the durable handoff boundary.

## How bot-to-bot collaboration works

A bot conversation can use `send_agent_message` in either of two ways:

- `bot`: address a verified teammate in the selected persistent bot team by
  stable bot ID, internal name, or display name.
- `task_id`: address a descendant child task using the normal agent-message
  contract.

For a bot teammate, CoWork verifies all of the following before delivery:

1. The sender is a bot conversation assigned to an active bot role.
2. The sender belongs to an active, persistent team.
3. The recipient is an active role in that same team and workspace.
4. The recipient is not the sender.

Bot-team messages are durably admitted with sender/recipient provenance and a
stable message ID. A teammate's conversation is reused when a healthy one
exists; otherwise CoWork creates a dormant conversation for that role. The
recipient is then woken asynchronously after queue acceptance through the normal
daemon/runtime path. `send_agent_message` returns the daemon's admission status
(`queued` for normal acceptance, or `delivered` for a duplicate that was
already consumed); it does not wait for the recipient model turn or relay a
synchronous reply. Reusing a message ID with different content is rejected,
and a queued receipt is only restart-recoverable when it was created by an
agent handoff. User-authored child-task follow-ups keep their normal queue
behavior without becoming bot-to-bot messages during recovery.

The daemon rechecks team membership at both admission and restart recovery. It
never repairs an explicit target team by assigning the sender's team: a stale,
foreign, inactive, or non-persistent team reference is unavailable until an
explicit product action fixes it. If membership is revoked after a receipt is
queued, the receipt is terminally quarantined with
`BOT_MESSAGE_TEAM_AUTHORIZATION_REVOKED` rather than delivered to a
conversation outside the team's current boundary. The UI distinguishes
`BOT_TEAM_UNAVAILABLE`, `BOT_MEMBERSHIP_REVOKED`,
`BOT_CONVERSATION_UNAVAILABLE`, and `BOT_RUNTIME_UNAVAILABLE` so recovery does
not look like a generic missing bot.

When a bot conversation is failed or unavailable, **Reopen conversation** is
available from the Bots roster. Reopen creates a fresh conversation in the
current workspace and links it to the old task for history without copying the
old transcript. Standalone conversations reopen without creating a team. Team
or membership repair is explicit; a foreign team is never
silently reassigned. A workspace-boundary recovery follows the same rule for
canonical WorkSessions and emits a durable `workspace_boundary_recovery`
event.

The conversation header uses a read-side lifecycle projection to present bot
collaboration as teammate activity rather than an implementation trace. It
shows states such as `Working with the team`, `Waiting on a teammate`, `Needs
your input`, and `Finished`. The header can reveal recent handoffs and the
latest outcome on demand, while the primary transcript keeps tool calls,
intermediate steps, and protocol JSON hidden. Errors, blocked states, and
delivery failures remain visible as explicit attention items instead of being
silently collapsed. When a collaborator is a known persistent bot, its name in
the header is an accessible link to that teammate's conversation, so users can
inspect the receiver-side transcript without returning to the roster manually.

The Bots roster presents persistent conversation readiness separately from the
last run result: a completed run can still be `Ready for another message`, an
active run is `Working on latest message`, and paused/failed runs surface an
explicit attention or retry state. Sender and receiver timeline rows share the
same compact delivery receipt and stable message ID for diagnosis. The compact
receipt hides raw protocol JSON and exposes human labels for Accepted, Queued,
Started, Delivered, Failed, and Quarantined.

This is different from ephemeral child-agent delegation. Child-agent messages
remain queue-oriented and are addressed by task ID; bot-team conversations are
persistent named peers. See [Agent messaging](agent-messaging.md) for delivery
receipts, retry identity, and worker-task semantics.

## Conversation lifecycle

The normal flow is:

```text
Bot row selected
  -> query active, non-side-chat conversations by workspace + role
  -> reuse the newest real unarchived conversation, or create a dormant task
  -> first user message enters the normal daemon/executor
  -> assistant/tool/approval events are persisted in the task timeline
  -> completed bot turns return the persistent task row to pending/idle
  -> later messages reuse the same task until the user starts another conversation
```

Bot conversations are not a second task database. They use the existing task
and event lifecycle, but are excluded from the Sessions feed and loaded through
the explicit bot-conversation query. Side chats are filtered out so a temporary
question does not become the bot's canonical transcript.

Branching keeps the assigned bot role on the new task, while a Side Chat is a
short-lived linked task and is intentionally not selected as the bot's canonical
conversation. Manual, scheduled, and Electron/Node routine runs can retain the
assigned role, but they are ordinary work tasks unless they carry the explicit
`botConversation: true` marker.

The renderer considers a pending bot task idle when the latest visible
assistant message follows the latest user message and no newer active-work
signal exists. Bookkeeping events such as `task_status`, usage, snapshots, and
logs do not by themselves keep a completed chat turn spinning.

## Profile and execution model

An `AgentRole` can carry more configuration than the compact profile editor
shows:

| Configuration | Purpose |
| --- | --- |
| `displayName`, `description`, `icon`, `color` | Persistent user-facing identity |
| `systemPrompt` | Additional role-specific instructions |
| `capabilities` | Domain hints such as `code`, `research`, `write`, or `manage` |
| `toolRestrictions` | Allowed/denied tool policy for the role |
| `modelKey`, `providerType`, `personalityId` | Optional model/personality overrides |
| `autonomyLevel` | `intern`, `specialist`, or `lead` behavior hint |
| `heartbeatPolicy` / automation fields | Optional proactive pulse/dispatch behavior |
| `isActive` / `isSystem` | Roster visibility and deletion protection |

Role configuration is applied by the daemon when a task starts or resumes. Role
configuration does not bypass workspace access profiles, approvals, network
rules, filesystem boundaries, or tool hard guardrails. A lead role can have
delegation guidance, but it still cannot message a bot outside its verified
team.

### Host computer and computer use

Bots do not receive a separate hosted computer or VM. When computer-use tools
are selected, they operate on the computer running CoWork OS. The Bot details
rail reports whether the local helper is installed, Accessibility is trusted,
Screen Recording is granted, and the computer is already in use by another
task. The one-active-computer-use-session rule applies across bot and normal
tasks.

### Markdown and message rendering

The full bot transcript uses the shared message/timeline renderer, so assistant
and user messages can retain normal Markdown rendering, links, code, artifacts,
and expanded activity details. The compact Bots roster is intentionally
different: it derives a short preview and strips Markdown syntax, icons, and
line-break noise before rendering. This keeps a message containing `**text**`
from changing the weight of the sidebar UI.

## Storage and IPC reference

The main persistence and transport boundaries are:

| Layer | Contract |
| --- | --- |
| Role storage | `agent_roles` stores the profile and role configuration. `AgentRoleRepository` maps rows, applies defaults, and deactivates custom roles safely. |
| Conversation storage | `tasks` stores the persistent conversation task, `task_events` stores the transcript/activity lifecycle, and `task_session_metadata` stores archive state. |
| Bot query | `TaskRepository.findBotConversations()` filters valid JSON `agent_config`, `botConversation = true`, excludes `side_chat`, scopes by workspace/role, and optionally includes archived rows. |
| Team storage | `agent_teams` stores the workspace-scoped team; `agent_team_members` stores role membership. |
| Automation storage | `automation_profiles` may mirror a role's heartbeat policy and is disabled when a role is deleted. |
| Renderer preload | Role APIs are exposed through `getAgentRoles`, `getAgentRole`, `createAgentRole`, `updateAgentRole`, and `deleteAgentRole`; bot history uses `listBotConversations`. |
| IPC channel names | Role CRUD uses `agentRole:list`, `agentRole:get`, `agentRole:create`, `agentRole:update`, and `agentRole:delete`; history uses `bot:conversationsList`; recovery uses `bot:conversationReopen`. |

The canonical bot-conversation marker is:

```ts
agentConfig: {
  botConversation: true,
  conversationMode: "hybrid",
  executionMode: "execute",
  executionModeSource: "strategy",
}
```

The task also carries `assignedAgentRoleId`. The workspace and role together
are the identity boundary used when resuming a bot conversation. A role ID by
itself does not make a task appear in the Bots surface.

### Renderer creation pattern

Use the shared helper instead of constructing bot task metadata ad hoc:

```ts
const options = createBotConversationOptions(agentRoleId);
// Merge `options` into the existing task:create request for the workspace.
```

That helper assigns the role, marks the task as a bot conversation, and sets
the default hybrid/execute behavior. The task-create IPC path recognizes the
bot marker and returns a dormant task; `sendMessage` starts the first turn.

### Role API expectations

- Creation requires a unique internal `name` matching
  `^[a-z0-9-]+$`, a display name, and a capabilities array.
- The simple profile editor updates display name, description, instructions,
  icon, and color; it intentionally does not rename the internal role name.
- `getAgentRoles()` returns active roles by default. Pass `true` to include
  deactivated roles for diagnostics/history tooling.
- `deleteAgentRole()` is a safe deactivation operation for custom roles. It
  returns `false` for a missing role or a protected system role.
- `reopenBotConversation()` accepts an optional existing `botTeamId` and an
  explicit `repairMembership` action. A cross-workspace fresh conversation requires
  `branchToWorkspace: true`; it inherits neither the source's transcript nor its
  team. Without an explicitly selected target team, the new conversation is standalone.
- `listBotConversations()` supports workspace and role filters, archive
  inclusion, pagination, and a temporary-workspace all-workspaces mode used by
  the renderer when recovering a transcript after restart.

## Troubleshooting

### The Bots row says “No messages yet”

That means the bot has no visible user/assistant transcript yet. Selecting the
row opens a dormant conversation; send a message to start it. A synthetic seed
such as `Start chatting with …` is not shown as a user message preview.

### The conversation is not in Sessions

That is intentional. Tasks marked `botConversation: true` are excluded from the
normal Sessions sidebar and loaded through the Bots roster/history query.

### A bot opens the wrong conversation

Check workspace and role identity first. The resume query must match both the
current workspace and `assignedAgentRoleId`, must exclude side chats, and will
not use archived sessions. Restart/reload only after checking the active
conversation query; the renderer also rejects mismatched results from an older
backend.

### A profile change is not visible in an active turn

Profile updates are next-run configuration. Finish or stop the current turn,
then send a new message or open a new conversation to guarantee the new
instructions are loaded.

### A teammate cannot be reached

Confirm the sender is a bot conversation attached to an explicitly configured
persistent team, use the stable bot ID for ambiguous names, and check that
the recipient is a member of the same workspace team. `send_agent_message`
cannot cross teams or workspaces. If the Bots roster shows **Unavailable —
reopen to retry**, use the refresh action on that row. If the role membership
was revoked, restore it through the team configuration before reopening, or use
an explicit `repairMembership: true` API request for that existing team. An ordinary
reopen never restores membership. The old task and transcript remain intact.

### A conversation was restored after a workspace conflict

The current workspace is authoritative. CoWork creates a replacement
WorkSession, keeps the previous session detached for audit, and emits
`workspace_boundary_recovery`. The recovery record contains identifiers and a
diagnostic code, not the old transcript content. If a message still appears
queued, compare the sender receipt, the receiver's `user_message` receipt, and
the receiver's assistant turn; a queued or started receipt is not proof of
completion until the receiver-side delivered state is durable.

### How to validate a live bot handoff

For a real running-app check, use two existing bot conversation task IDs and
run `npm run qa:bots:live -- --sender-task <id> --recipient-task <id>`. The
check sends a unique marker through the sender bot and only passes when the
sender receipt, receiver transcript, receiver acknowledgement, and durable
correlated sender reply are all observed. It does not replace a desktop UI
review: after it passes, inspect
both conversations in the app for a single incoming message, compact delivery
copy, no raw JSON or execution-step leakage, and transcript continuity after
reopen. A queued/started result or a timeout is evidence to investigate, not a
pass.

### Computer-use actions are unavailable

Open the Bot details rail's computer section and complete the local helper,
Accessibility, and Screen Recording setup. Another active computer-use task
can also hold the single-session lock.

### Deleting a bot reports a foreign-key error

Do not remove rows manually. The supported delete path deactivates the role and
turns off its automation profile while keeping history. If an older build
still attempts a hard delete, update to the current role-repository behavior
and run the focused Agent Role Repository regression tests.

## Source map for maintainers

The bot implementation is intentionally split by responsibility:

- `src/renderer/components/Sidebar.tsx` switches the panel between sessions and
  the bot roster (driven by the rail destination) and loads active bot roles.
- `src/renderer/components/BotsPane.tsx` owns the roster, search, previews,
  create flow, and row-level edit entry point.
- `src/renderer/components/BotProfileDialog.tsx` owns profile loading,
  validation, save/delete confirmation and profile events; it and the create
  dialog share `BotFormDialog.tsx` (character, fields, focus handling, footer).
- `src/renderer/components/BotConversationHistory.tsx` renders current and
  archived conversations for one bot.
- `src/renderer/components/BotDetailsRail.tsx` renders identity, status,
  notifications, history, link copying, and host-computer state.
- `src/renderer/utils/bot-conversations.ts` defines classification, resume
  selection, and task-creation defaults; `task-working-state.ts` prevents stale
  bot-turn spinners.
- `src/renderer/App.tsx` loads bot conversations, opens/resumes a bot, creates
  new conversations, and routes deep links.
- `src/electron/ipc/handlers.ts` validates role CRUD and bot-history requests;
  `src/electron/preload.ts` exposes the typed renderer boundary.
- `src/electron/agents/AgentRoleRepository.ts` owns role persistence and safe
  deactivation; `src/electron/agents/bot-team.ts` builds generic guidance from
  verified team membership.
- `src/electron/database/repositories.ts` owns bot-conversation SQL queries;
  `src/electron/agent/daemon.ts` verifies configured teams, resolves peers, and wakes
  recipients; `src/electron/agent/tools/registry.ts` implements
  `send_agent_message`.
- `src/shared/types.ts` contains `AgentRole`, `AgentConfig`,
  `BotConversationListQuery`, `AgentTeam`, and related contracts.

## Focused verification

When changing the bot surface, run the smallest relevant checks first:

```bash
npx vitest run \
  src/renderer/components/__tests__/BotsPane.test.ts \
  src/renderer/components/__tests__/Sidebar.test.ts \
  src/renderer/components/__tests__/BotProfileDialog.test.ts \
  src/renderer/utils/__tests__/bot-conversations.test.ts \
  src/electron/database/__tests__/bot-conversation-query.test.ts \
  src/electron/agents/__tests__/AgentRoleRepository.test.ts

npm run type-check
npm run build:react
git diff --check
```

For changes to peer messaging, also run the focused
`src/electron/agent/tools/__tests__/child-task-control.test.ts` suite. For
changes to task creation or runtime state, include the relevant daemon,
executor, and task-working-state tests rather than relying on roster tests
alone.


### Approval decision cards

In **Settings → Slack** or **Settings → Teams**, save your own channel account ID
under **Your Account on This Channel**, then enable **Send approval decision cards**.
The switch is off by default. Enabling it changes only card delivery configuration;
CoWork still checks the channel, requester, task, current permissions, request revision
and supported file revisions before accepting a decision.

Cards offer approval once or denial for the displayed request and expire after five
minutes. Changed requests or files require a fresh review. Requests unsupported by
the card transport direct you to CoWork. An interrupted card delivery can remain
unknown; review its pending approval in CoWork instead of assuming delivery succeeded.
Slack requires a connected Socket Mode adapter; Teams requires its configured tenant
and an authenticated conversation. Decision conversation references survive restart only for the same channel, app,
tenant and unchanged configuration. References expire after 90 days and are capped
at 1,000 per channel; expired records are pruned when new references are saved.
A configuration change requires a fresh authenticated conversation. Live channel
delivery still requires acceptance validation.
