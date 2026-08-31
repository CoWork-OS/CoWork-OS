# Channel-Specific User Guides

These guides explain how to use each CoWork channel after it is connected. They are written for end users: what the channel is best for, which features matter, how to work day to day, and what to avoid.

For setup instructions, see [Channel Integrations](../channels.md). For shared remote commands and task lifecycle behavior, see [Using CoWork from WhatsApp and Other Channels](../gateway-user-guide.md) and [Gateway Message Lifecycle](../gateway-message-lifecycle.md).

Admins can also use [Channel Specialization](../channels.md#channel-specialization) to make a whole channel, specific chat/group, or topic/thread default to a workspace, agent role, prompt guidance, tool restrictions, and shared-memory policy. Channel-created tasks inherit the target workspace's [access profile](../access-profiles.md); channel rules and specialization can narrow that profile, but cannot widen its command-tool, filesystem, network, domain, or approval boundary.

## Guides

| Channel | Guide |
|---------|-------|
| WhatsApp | [WhatsApp User Guide](whatsapp.md) |
| Telegram | [Telegram User Guide](telegram.md) |
| Discord | [Discord User Guide](discord.md) |
| Slack | [Slack User Guide](slack.md) |
| Microsoft Teams | [Microsoft Teams User Guide](microsoft-teams.md) |
| Google Chat | [Google Chat User Guide](google-chat.md) |
| Feishu / Lark | [Feishu / Lark User Guide](feishu-lark.md) |
| WeCom | [WeCom User Guide](wecom.md) |
| iMessage | [iMessage User Guide](imessage.md) |
| Signal | [Signal User Guide](signal.md) |
| Mattermost | [Mattermost User Guide](mattermost.md) |
| Matrix | [Matrix User Guide](matrix.md) |
| Twitch | [Twitch User Guide](twitch.md) |
| LINE | [LINE User Guide](line.md) |
| BlueBubbles | [BlueBubbles User Guide](bluebubbles.md) |
| Email | [Email User Guide](email.md) |
| X Mention Triggers | [X Mention Triggers User Guide](x-mention-triggers.md) |

## Shared Commands

Most channels support the same remote lifecycle commands once messages reach CoWork:

- `/commands` shows the command catalog.
- `/new` starts the next message fresh without cancelling the old task.
- `/new temp` starts a scratch temporary session.
- `/stop` cancels the active task.
- `/queue <message>` sends explicit follow-up text to the current task.
- `/steer <guidance>` gives high-priority direction to the active task.
- `/background <prompt>` starts unlinked side work.
- `/skills` lists enabled skills.

Platform details vary. Slack slash commands must be registered in Slack first, Discord and Telegram expose native command menus, and some channels are text-only or rate-limited.
