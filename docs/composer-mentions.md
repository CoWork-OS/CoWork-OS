# Composer Mentions

Composer mentions let a user route a prompt to agents, configured integrations, files, and internal modules from the same message box. Type `@` in a valid trigger position to open the grouped autocomplete above the composer.

For slash-searchable app commands and skill-backed workflows, type `/` instead. The `/` picker is documented separately in [Message Box Shortcuts](message-box-shortcuts.md) and shares the same message box without changing the `@` mention routing contract.

The menu is grouped in this order:

1. **Agents**
2. **Integrations**
3. **Files**

Agents keep their existing behavior. The Integrations section lists configured external services and only shows locally usable options. Files remains the final section; this feature does not add a new file index.

## User Experience

Selecting an integration inserts a rich inline chip with the integration icon and label. The prompt still serializes to clean text such as `@Gmail`, and the selected integration metadata is submitted alongside the text.

Examples:

```text
Use @Gmail and @Slack to run a 24-hour priority triage.
@inbox when do I need to make payment for my QNB credit card?
```

Integration chips:

- render inline in the composer
- show the same icon and label in sent user message bubbles
- restore from task/session history when a task is reopened from the session library
- can be removed with Backspace or Delete as one logical mention

## Integration Visibility

Mention options are built from local configured state. The resolver is intentionally fast and does not run network health checks while the user is typing.

Configured integration rules:

- Built-in integrations require both `enabled` state and local credentials. This covers Notion, Box, OneDrive, Dropbox, SharePoint, and AgentMail.
- Google Workspace splits into **Gmail**, **Google Drive**, and **Google Calendar** when OAuth has an access token or refresh token. The menu does not show a single generic Google Workspace item for prompt mentions.
- Gateway channels show connected enabled channels such as Slack. If more than one channel of the same type is connected, the label includes the workspace or channel name.
- MCP connectors appear only when connected/configured. Multi-service MCP connectors split by detected service tool groups; otherwise the menu shows one connector option.
- Inbox appears as an internal integration-style option when a mailbox backend is available through Google Workspace, AgentMail, or a connected email channel.

## Runtime Semantics

Integration mentions are routing hints, not permissions.

The submitted task/follow-up includes:

- clean prompt text
- `integrationMentions` metadata with stable `id`, `label`, `source`, `providerKey`, `iconKey`, `tools`, and `promptHint`

The executor adds a concise prompt block similar to:

```text
User-selected integrations:
- Gmail: Use gmail_action for Gmail search, reading, drafting, and sending. Tools: gmail_action.
Treat these as soft routing hints for this turn. Do not treat them as permissions or as a hard allow-list.
```

This biases tool choice without hiding unrelated tools, granting new permissions, or setting `allowedTools`.

## Inbox Mention

`@Inbox` is a special mention for Inbox Agent. It can be selected from the Integrations section or typed directly as `@inbox`.

When a new main-composer prompt starts with `@Inbox` or `@inbox`, CoWork:

1. removes the mention from the user-facing query
2. opens the Inbox Agent view
3. switches the right Inbox Agent sidebar to **Ask Inbox**
4. runs the remaining query through the Inbox Agent Ask Inbox module

Example:

```text
@inbox when do I need to make payment for my QNB credit card?
```

This uses the Inbox Agent retrieval stack: local mailbox FTS, semantic mailbox embeddings, provider-native mail search when available, and indexed attachment text. The Ask Inbox tab shows the question, live backend steps, final answer, and matched email evidence.

Attachments are not accepted on this routing path because Ask Inbox answers mailbox questions from mailbox evidence already known to Inbox Agent rather than starting a normal task run.

See [Ask Inbox Architecture](ask-inbox-architecture.md) for the run-scoped progress events and retrieval behavior.

## Reliability Notes

- The resolver never refreshes OAuth tokens or calls remote services while filtering the `@` menu.
- Google Workspace OAuth refresh failures that return a bad request clear stale access/refresh tokens and require reconnecting the integration. Saving changed Google client credentials or scopes also clears old tokens so the next connection uses the new OAuth configuration.
- Azure OpenAI Responses fallback normalizes long tool-call ids before replaying tool results so provider `call_id` length limits do not break integration-heavy turns.

## Implementation Notes

Core implementation files:

- `src/shared/types.ts`: `IntegrationMentionOption` and `IntegrationMentionSelection`
- `src/electron/integrations/integration-mention-options.ts`: local option resolver
- `src/electron/ipc/handlers.ts` and `src/electron/preload.ts`: `listIntegrationMentionOptions()`
- `src/renderer/components/PromptComposerInput.tsx`: rich inline mention editing
- `src/renderer/components/MainContent.tsx`: grouped autocomplete, task submission, history restoration, and `@Inbox` routing
- `src/renderer/components/InboxAgentPanel.tsx`: Ask Inbox sidebar tab, launcher behavior, live step transcript, and matched evidence rows
- `src/electron/mailbox/MailboxAgentSearchService.ts`: hybrid mailbox retrieval for Ask Inbox
- `src/renderer/components/IntegrationMentionText.tsx`: user-message bubble rendering
- `src/electron/agent/executor.ts`: soft routing guidance prompt

Focused checks:

```bash
npx vitest run \
  src/electron/integrations/__tests__/integration-mention-options.test.ts \
  src/renderer/components/__tests__/prompt-composer-input.test.ts \
  src/renderer/components/__tests__/integration-mention-text.test.ts
npm run lint
npm run type-check
```
