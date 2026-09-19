# Research Channels (Telegram + WhatsApp)

Research channels let you designate specific Telegram groups or WhatsApp groups as "link dump" channels. When you post links to these chats, the agent automatically processes them into a structured findings report with classification, optimized for downstream agents.

This workflow is inspired by the OpenClaw Research agent pattern.

## How It Works

1. **Configure**: Add chat IDs to the Research Channels section in Settings for your Telegram or WhatsApp channel.
2. **Post links**: Send messages containing URLs to those chats (one or more links per message).
3. **Agent processes**: The agent fetches each URL, extracts content, and produces a findings report with:
   - Per-URL summary and key points
   - Classification tags (news, tutorial, product, research, etc.)
   - Output written to `{artifactDir}/findings-report.md`

## Setup

### 1. Create a Group

- **Telegram**: Create a group or channel, add your CoWork bot.
- **WhatsApp**: Create a group, add your CoWork bot (or your linked number in self-chat mode).

### 2. Get the Chat ID

Use the `channel_list_chats` tool from any task to discover chat IDs:

- Ask the agent: "Use channel_list_chats for channel telegram (or whatsapp) with limit 20. Show me the list."
- Or run a task: "List my recent Telegram/WhatsApp chats with their chat IDs."

Chat ID formats:

- **Telegram groups**: Negative numbers, e.g. `-1001234567890`
- **WhatsApp groups**: JID format, e.g. `120363012345678@g.us`

### 3. Add to Research Channels

1. Open **Settings** > **Channels** > **Telegram** (or **WhatsApp**)
2. Expand **Research Channels**
3. Paste chat IDs (one per line or comma-separated)
4. Optionally select a **Research Agent** role (or leave as default)
5. Click **Save Research Settings**

## Optional: Research Agent Role

You can assign a dedicated agent role for research tasks:

1. Go to **Settings** > **Agent Teams**
2. Create a new agent role (e.g. "Research") with capabilities like `research`, `web_fetch`
3. In the Research Channels section, select that role from the **Research Agent** dropdown

If not set, the channel default agent (or first allowed role) is used.

## Output Format

The agent produces a markdown report:

```markdown
## Findings Report

### Summary

- Total links processed: N
- Classification overview: [tags]

### Per-URL Findings

#### 1. [Page Title]

- **URL:** [url]
- **Summary:** 2-3 sentence summary
- **Key points:** ...
- **Classification:** [tag1], [tag2]
  ...
```

The report is saved to `{artifactDir}/findings-report.md` and can be used by follow-up agents.

## Supported Channels

- **Telegram**: Groups and channels
- **WhatsApp**: Groups (when the bot is a member)

## See Also

- [Channel Integrations](channels.md)
- [Link Research skill](../resources/skills/link-research.json)
