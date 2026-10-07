# Ask and Do

Choose **Ask** to discuss or draft using the conversation and content you supplied. Ask does not take external actions. Choose **Do** when you want CoWork to work on a task; it selects an execution strategy and follows the active access profile and approval rules.

These are two ways to start work, not permission levels. **Ask for approval**, **Approve for me**, **Full access**, and **Custom** are access profiles that independently govern what a task may do.

## Advanced runtime overrides

Open **Advanced…** when you need to pin a runtime behavior for the next message: **Execute**, **Plan**, **Analyze**, **Debug**, or **Verified**. A selected override appears as **Do · Plan**, for example. Selecting plain **Do** clears the override and lets CoWork choose an approach for the request.

Autonomy, collaboration, model comparison, and parallel lanes are separate task controls. They do not replace Ask/Do. Use `/multitask [N] <task>` when you want bounded parallel lanes.

## Release labels

Since CoWork OS 0.5.60 the UI calls the stored `chat` choice **Ask** and the stored `smart` choice **Do**. Releases up to 0.5.54 label those choices **Chat** and **Smart**, respectively. The release-specific [surface reference](release-surface-reference.md) lists labels and Mission Control navigation for each stable release and the current development UI. These are UI-label changes only: stored and IPC `InteractionModeSelection` values remain `chat` and `smart`.

## Behavior and compatibility

Changing Ask/Do affects the next submitted message and keeps the conversation and history. While a turn is running, a change waits for the next turn boundary; queued changes remain ordered and survive runtime snapshots. Do clears previous inferred routing before deriving a new strategy. Advanced overrides remain explicit, while access profiles and approval rules continue to apply.

Ask supports conversation text, images, and attachment previews already supplied to the model. A partial preview is not represented as a full document read. Ask rejects action and skill shortcuts such as `/goal`; switch to Do to use them. Local `/clear` remains available. Ask is unavailable for external ACP runtimes that cannot enforce the no-external-action contract.

Legacy clients and saved sessions retain the existing runtime values (`chat`, `execute`, `plan`, `analyze`, `debug`, and `verified`). Do not rename those values as part of a UI vocabulary change. Explicit legacy values continue to display as Ask or the corresponding advanced override; ambiguous legacy configuration is not rewritten merely by opening or submitting an existing session. CLI and automation execution-mode values remain supported.

Focused regression coverage exercises local and remote validation, strategy clearing, proposal-only behavior, advanced overrides, queued selection ordering and recovery, attachment handling, daemon permission timing, and the shared picker. Manual checks should cover Ask → Do → Ask in one session, a queued switch during execution, task navigation, and app restart. Applicable approvals must still appear for Do; Ask must not take external actions.
