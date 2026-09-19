# Agent messaging

CoWork tasks can coordinate descendant agents while a parent task is running. The parent agent uses `send_agent_message` for focused instructions; the tool is queue-only, returns after durable acceptance, and reports whether the message is queued or already delivered. Callers can pass the same `message_id` when retrying so a persisted target receipt prevents duplicate delivery.

Every agent message carries a stable message ID, sender provenance, recipient task and delivery status. The persisted receipt records acceptance, queue and delivery timestamps, and a retry with the same ID is ignored instead of enqueueing a second message. The parent task timeline renders the message as an expandable `Messaged <agent>` activity row. The row includes the message preview, recipient, delivery result and an `Open agent` action when the child is available. Failed delivery remains visible with the error so the parent can retry or choose another recovery path.

Users can select a spawned worker from the live agent strip or spawned-agent sidebar and send a follow-up directly. The compact strip keeps the first workers visible and exposes `Show all agents` when the set is larger. The sidebar identifies the recipient, preserves the existing worker transcript and draft while switching workers, reports whether the message was delivered or queued, and exposes the supported pause, resume and stop controls. Worker messages do not change the worker's permissions, provider, workspace or interaction mode.

The distinction between a queued message and a new follow-up turn is intentional. A queued message is consumed at the worker's next input boundary and does not start an idle or completed worker. A normal follow-up explicitly starts or continues work through the existing composer. Completion of the worker's task is a separate lifecycle event.

Agent creation also has two lifecycle states: `agent_spawn_requested` means dispatch has started, while `agent_spawned` is emitted only after a child handle exists. A failed dispatch is represented by `agent_failed` and is never shown as a successful creation.

Queued follow-ups emit `agent_follow_up_scheduled` when accepted and `agent_follow_up_started` when the worker incorporates the message at a turn boundary. User cancellation emits `agent_interrupt_requested` followed by `agent_interrupt_confirmed` after the runtime has stopped the task. These events are persisted, projected into the semantic timeline, and kept separate from task completion so replay can distinguish acceptance, execution and interruption.

## Persistent bot-team messaging

Persistent bot conversations use the same `send_agent_message` tool with the
`bot` field instead of a descendant `task_id`. The daemon resolves that handle
only inside the sender's active persistent CoWork Bot Team, verifies the role
and workspace boundary, and reuses or creates the recipient's durable bot
conversation. The recipient is then woken through the normal task runtime.

This path is intentionally different from child-agent messaging: a bot
teammate is a named, durable conversation that can be reopened from the Bots
roster, while a child task remains a descendant work item with queue-oriented
delivery. See [Bots, conversations, and tasks](bots-and-conversations.md) for
the bot profile, conversation lifecycle, roster, and troubleshooting guide.
