# Interaction modes

The desktop composer and device task composer offer **Smart** and **Chat**.

- **Smart** is the default for new interactive sessions. It derives an execution strategy for each request. Explicit proposal-only requests remain non-mutating. Access profiles and approval rules continue to apply.
- **Chat** answers and drafts using conversation content, images, and attachment previews already supplied to the model. It does not invoke external tools. Partial attachment previews are not represented as a full document read; switch to Smart when deeper inspection is necessary.
- **Advanced…** exposes Execute, Plan, Analyze, Debug, and Verified. An override appears in the selector, for example **Smart · Plan**. Selecting plain Smart clears it.

Changing the selector affects the next submitted message. It keeps the conversation and history. While a turn is running, actual mode or advanced-override changes wait for the next turn boundary; same-mode messages retain steering behavior. Later messages cannot skip a queued switch. Permission updates still take effect through the existing permission path.

Chat rejects action and skill shortcuts such as `/goal`; switch to Smart to use them. Local `/clear` remains available. Follow-up images are included in Chat model messages. Temporary automation overrides apply only to their turn and are not saved as session defaults, including when the turn fails.

## Persistence and compatibility

`AgentConfig.interactionMode` stores the applied preference independently of `executionMode`, which describes the resolved runtime behavior. `TaskFollowUpInput.interactionMode` captures the choice for a specific message; it is validated by the same discriminated schema for local and remote callers. Queued selections are included in the existing V2 runtime snapshots, including queues created before the first conversation message.

The preference is applied and persisted when its turn begins. Each Smart turn clears previous inferred routing before deriving a new strategy. Chat and advanced overrides remain explicit. There is no database schema migration or historical-event rewrite.

Legacy clients may omit the field. Explicit legacy user modes are displayed as Chat or the corresponding advanced override. Ambiguous legacy configuration is not rewritten merely by opening or submitting an existing session. CLI and automation execution-mode values remain supported.

Chat is rejected for external ACP runtimes that cannot enforce its no-tool contract. Use a native session for Chat.

## Verification

Focused regression coverage includes local/remote validation, clearing stale planning, explicit proposal-only restrictions, advanced overrides, queued selection ordering and snapshot recovery, Chat PDF behavior, daemon permission-versus-mode timing, and the shared picker.

Manual desktop checks should exercise Chat → Smart → Chat in one session, a queued switch during execution, task navigation, and reopening the app. Smart tool requests must still encounter any applicable approvals; Chat must not execute the same request.
