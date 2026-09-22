# Agent messaging

CoWork tasks can coordinate descendant agents while a parent task is running. The parent agent uses `send_agent_message` for focused instructions; the tool is queue-only, returns after durable acceptance, and reports whether the message is queued or already delivered. Callers can pass the same `message_id` when retrying so a persisted target receipt prevents duplicate delivery.

Every agent message carries a stable message ID, sender provenance, recipient task and delivery status. The persisted receipt records acceptance, queue, started, and terminal timestamps, an attempt number, and (when relevant) a failure code. The lifecycle is `accepted -> queued -> started -> delivered`, with `failed` for retryable errors and `quarantined` for authorization or safety failures. A retry with the same ID and content can re-queue a retryable failure, while a quarantined receipt requires team repair and a deliberate retry. Reusing an ID for different content is rejected so an old receipt cannot be confused with a new instruction. The parent task timeline renders the message as an expandable `Messaged <agent>` activity row. The row includes the message preview, recipient, delivery result and an `Open agent` action when the child is available. Failed and quarantined delivery remains visible with the error so the parent can retry or choose another recovery path.

Users can select a spawned worker from the live agent strip or spawned-agent sidebar and send a follow-up directly. The compact strip keeps the first workers visible and exposes `Show all agents` when the set is larger. The sidebar identifies the recipient, preserves the existing worker transcript and draft while switching workers, reports whether the message was delivered or queued, and exposes the supported pause, resume and stop controls. Worker messages do not change the worker's permissions, provider, workspace or interaction mode.

The distinction between a queued message and a new follow-up turn is intentional. A queued message is consumed at the worker's next input boundary and does not start an idle or completed worker. A normal follow-up explicitly starts or continues work through the existing composer. Completion of the worker's task is a separate lifecycle event.

For bot-to-bot replies, `replyStatus=received` is set only after the requesting
bot consumes the reply's durable `user_message` receipt (`deliveryStatus=delivered`).
Queue admission or a wake-up request is not treated as a received reply, so the
sender remains in a waiting state until the receiver has actually incorporated
the message. Completion and recovery use the same boundary: queued or started
inbound receipts do not trigger an automatic reply before the receiver has
incorporated the request.

Agent creation also has two lifecycle states: `agent_spawn_requested` means dispatch has started, while `agent_spawned` is emitted only after a child handle exists. A failed dispatch is represented by `agent_failed` and is never shown as a successful creation.

Queued follow-ups emit `agent_follow_up_scheduled` when accepted and `agent_follow_up_started` when the worker incorporates the message at a turn boundary. User cancellation emits `agent_interrupt_requested` followed by `agent_interrupt_confirmed` after the runtime has stopped the task. These events are persisted, projected into the semantic timeline, and kept separate from task completion so replay can distinguish acceptance, execution and interruption.

## Persistent bot-team messaging

Persistent bot conversations use the same `send_agent_message` tool with the
`bot` field instead of a descendant `task_id`. The daemon resolves that handle
only inside the sender's active persistent CoWork Bot Team, verifies the role
and workspace boundary, and reuses or creates the recipient's durable bot
conversation. The message is admitted through the durable queue-only transport,
then the recipient is woken asynchronously after acceptance. The sender does
not wait for a recipient turn or receive a synchronous teammate reply.

Persistent bot conversations have one narrow policy exception:
`send_agent_message` remains available even when the conversation is in
plan/analyze mode, but only after the daemon has verified the sender's
workspace-scoped persistent bot team. The exception is not granted by task
JSON alone: the sender must be an active member of a persistent team, and the
recipient must resolve to another active member of that same team and
workspace. Explicit stale, foreign, inactive, or non-persistent team IDs fail
closed rather than being silently reassigned. File, shell, browser,
integration, and other mutating tools continue to obey their normal mode,
access-profile, allow-list, and approval gates.

If the process exits after the target receipt is persisted but before the
recipient turn starts, startup recovery reconstructs the exact queued or
started, agent-authored message by its stable `messageId` only after
revalidating both tasks against the same active persistent team.
Renderer-created user follow-ups are never replayed as bot handoffs. Receipts
whose team authorization has been revoked are terminally quarantined with a
durable reason and failure code; they are never delivered automatically. A
retryable failure can be re-queued with an incremented attempt, and the
sender-side receipt is repaired when the target is already marked delivered.

The recipient queue is FIFO and has one drain per bot conversation. A busy
recipient keeps later messages behind the current turn; it does not run
concurrent teammate turns. The durable `started` boundary makes a crash after
consumption recoverable without losing the message or acknowledging it as
delivered too early.

If a task's canonical WorkSession binding points at a session from another
workspace, CoWork preserves the old session for audit, creates a fresh session
in the current workspace, updates the binding, and records a
`workspace_boundary_recovery` event. No transcript content crosses the
workspace boundary.

The bot conversation surface projects these durable events into a compact
collaboration header. The default view shows current teammate activity,
human-readable delivery state, and any user attention required. Recent
handoffs and the latest outcome are behind an explicit details disclosure; raw
tool results, protocol JSON, and intermediate execution steps are not rendered
as conversation messages. The projection is read-only and derived from the
same persisted event stream, so sender and receiver views can be compared
without introducing a second source of truth.

The bot teammate is a named, durable conversation that can be reopened from the
Bots roster. Reopen creates a new workspace-local conversation and preserves
the old task; it never silently moves a foreign or stale team. If a role was
removed from its team, the recovery action explicitly repairs membership before
creating the replacement conversation. A child task remains a descendant work
item with the same queue-oriented delivery contract. See [Bots, conversations, and tasks](bots-and-conversations.md)
for the bot profile, conversation lifecycle, roster, and troubleshooting guide.

## Live bot-collaboration smoke

The repeatable live check is intentionally separate from Vitest. It drives the
running local control plane, asks an existing sender bot to call
`send_agent_message`, and requires three independent proofs before reporting a
pass:

1. the sender-side `agent_message` receipt reaches `deliveryStatus=delivered`;
2. the receiver-side `user_message` transcript contains the exact marker and
   reaches `deliveryStatus=delivered`; and
3. a receiver assistant event contains the generated acknowledgement token.

Use two existing bot-conversation task IDs from the Bots surface:

```bash
npm run qa:bots:live -- \
  --sender-task <sender-task-id> \
  --recipient-task <recipient-task-id>
```

The script discovers the loopback descriptor written by CoWork OS when
available. It also accepts `COWORK_CONTROL_PLANE_URL` and
`COWORK_CONTROL_PLANE_TOKEN` (or `--url` and `--token`). A timeout, queued
receipt, or failed/quarantined receipt is a failed live run; it is never
reported as a successful delivery. Use `--dry-run` to inspect the exact prompt
without mutating a task. The optional `--allow-non-bot` flag is diagnostic only
and should not be used for release evidence.

After the protocol check passes, repeat the same marker in the desktop UI and
verify the visual contract: the sender row shows a compact human-readable
delivery state, the receiver transcript shows the incoming message exactly
once, no raw receipt JSON or hidden execution steps appear in the conversation,
and reopening the receiver preserves its transcript. The protocol script does
not claim that UI rendering is proven.
