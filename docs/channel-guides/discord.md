# Discord User Guide

Discord is best for team, community, and engineering workflows where native slash commands, threads, and richer interactions are useful.

## Best For

- Engineering communities and product teams.
- Server channels with focused task threads.
- Fetching recent Discord messages or attachments into task context.
- Native slash-command task starts.

## Key Features

- Native Discord slash commands for core CoWork controls.
- DMs and server channel messages.
- Guild allowlists.
- Thread-aware routing where available.
- Channel and thread specialization for workspace, agent role, guidance, and tool policy.
- Buttons, select menus, embeds, and approval controls.
- Live Discord message fetch and attachment download tools.
- `/task <prompt>` compatibility shortcut for starting a task directly.

## Daily Workflow

Use native slash commands for explicit work:

```text
/new mode:temp
/queue message:Add mobile screenshots too.
/steer guidance:Do not change public APIs.
/background prompt:Check whether docs mention the old command list.
```

Use `/task prompt:...` when you want Discord's native slash command UI to start a task directly. Use `/status` and `/commands` for state and help.

## Best Practices

- Use threads for focused task discussions.
- Use thread specialization for incident, launch, or project threads that should route to a dedicated workspace or role.
- Restrict guild IDs when the bot is installed in multiple servers.
- Use DMs for private approvals.
- Use `/new` before changing topics in a shared channel.
- Use `/background` for side work that should not take over the active chat task.

## Watch-Outs

- Discord slash commands can take time to propagate, especially globally.
- Message Content Intent must be enabled for normal text routing.
- In large servers, broad bot access can create noise or accidental task starts.
- `/task <prompt>` starts work; it is not the same as a task status snapshot.

## Related Docs

- [Channel Integrations](../channels.md#discord)
- [Channel Specialization](../channels.md#channel-specialization)
- [Gateway User Guide](../gateway-user-guide.md)
