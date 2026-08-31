# WhatsApp User Guide

WhatsApp is the best channel for personal mobile control of CoWork. It works well for quick task starts, follow-ups, approvals, daily briefs, and lightweight link-research groups.

## Best For

- Personal "Message Yourself" workflows.
- Starting tasks away from the desktop.
- Quick approvals and corrections.
- Scratch sessions with `/new temp`.
- Small trusted groups that post links or ask for help.

## Key Features

- QR-based WhatsApp Web connection through Baileys.
- Self-chat mode for personal use.
- Natural shortcuts such as `help`, `status`, `new task`, `new temp`, `stop`, `queue ...`, and `background ...`.
- Typing indicators while CoWork is working.
- Editable progress messages when WhatsApp accepts edits.
- Optional response prefix so CoWork messages stand out.
- Link-research group support.
- Per-group specialization for workspace, agent role, guidance, and tool policy.

## Daily Workflow

1. Send a normal message to start a task.
2. Send another normal message to add context while the task runs.
3. Use `/new` before changing topics.
4. Use `/stop` if the active task should not continue.
5. Use `/new temp` for scratch work.
6. Use `/commands` when you forget the exact command.

Example:

```text
/new temp
Draft a short reply to this customer complaint.
```

## Best Practices

- Keep self-chat mode on when using your personal WhatsApp number.
- Use a short response prefix if your own messages and CoWork replies are hard to distinguish.
- Use `/queue <message>` for explicit follow-up text during a running task.
- Use `/steer <guidance>` for important corrections.
- In groups, prefer mention-or-command routing unless the group exists only for CoWork tasks.
- Use group specialization for trusted groups that should always route into the same workspace and role.
- Use direct self-chat for approvals involving files, command tools, or private data. New channel tasks inherit the target workspace's [access profile](../access-profiles.md), so group specialization can narrow policy but cannot widen it.

## Watch-Outs

- Busy groups can accidentally create work if routing is too permissive.
- WhatsApp is not ideal for reviewing very long technical output.
- Media attachments are useful, but file-heavy work is easier in the desktop app.
- If a task feels stale or wrong, use `/stop` instead of continuing to add context.

## Related Docs

- [Channel Integrations](../channels.md#whatsapp)
- [Channel Specialization](../channels.md#channel-specialization)
- [Gateway User Guide](../gateway-user-guide.md)
- [Research Channels](../research-channels.md)
