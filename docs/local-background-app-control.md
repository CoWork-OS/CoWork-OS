# Generic local background app control

CoWork's `native_app` tool controls an installed macOS app through its own native helper. No SSH connection, external runtime, shell access or clipboard is required. Application acceptance runs with `npm run dev`.

## Control and harness contract

1. Launch an installed bundle with `NSWorkspace.OpenConfiguration.activates=false`, optionally opening an authorized document path. App-specific consent is scoped to the current task and reevaluated if its access authority changes.
2. List windows by pid, or by the bundle id of a running app (never launches), then observe an exact process/window pair. Windows outside the current Space are found through the app's main/focused window when `AXWindows` omits them, and a window id is assigned only on a near-exact WindowServer match. A snapshot contains a bounded accessibility tree and a window-specific screenshot. Control references belong to that process instance, window, host session and snapshot; they expire after 60 seconds and one action consumes them.
3. Prefer semantic accessibility press/increment/decrement/confirm and explicit value replacement. Replacement requires the previously observed value. The helper rechecks ownership, window geometry, element ancestry/fingerprint, and user conflicts before acting.
4. Process-targeted key/text input uses a private event source and the app's existing focused window. Coordinate input is scoped to the observed window in points. Neither path posts global HID input, moves the physical pointer, focuses/raises a window, changes the pasteboard or silently falls back to foreground control.
5. Every mutation commits its intent to the task journal before dispatch. Transport failure does not trigger an automatic resend. An unresolved attempt blocks further mutations in that task, including after executor recreation; read-only inspection remains possible. This is task-level recovery, not remote or distributed fencing.
6. Successful actions return fresh native state and a screenshot. An acknowledgement remains `effect: unverified`: the agent must establish the requested application outcome from observation or domain-specific verification. The latest bounded observation replaces earlier state for that exact window across plan steps, so final verification sees the current result.

The helper records before/after frontmost-app and pointer evidence. Target self-activation or unexplained pointer movement produces `outcome_unknown`; it never restores a stale user focus or pointer position. If the user is using the target app, mutations pause. Background sessions do not register a global Escape handler; Stop in CoWork cancels the task. Cancellation is not undo.

Private Browser Workbench input also blocks `native_app`, including observations. A privacy
generation check discards results that overlap a private flow, even if the dialog closes before
the native action returns. If a mutation may already have been dispatched, its journal remains
`outcome_unknown`; do not replay it or switch tools to retry. Wait until private capture protection
ends, then inspect and reconcile the application state. Filled browser documents stay protected
until full navigation or tab destruction. See [private browser safeguards](security-guide.md#private-browser-credentials-and-checkout).

## Availability and limits

Native computer use defaults to **Background only**. Legacy `background_first` settings migrate to this strict mode. Existing foreground/ask-visible modes remain explicit choices; they do not change `native_app` into a foreground tool. Legacy mutation tools refuse in strict mode and direct the agent to the exact-window route.

This is a generic app/window/control interface, not a promise that every application implements background input. Minimized windows, ambiguous targets, secure text fields, stale controls, unsupported semantic actions and menu control are refused. Apps may ignore process-targeted input or activate themselves; those operations need separate qualification. Raw delivery alone is never proof of success. Hidden/occluded rendering and custom canvases also need qualification per app.

An unlocked local macOS session, Accessibility and Screen Recording permission are required. Locked-host control needs a separate authorization design and is not implemented by this route.

Structured APIs, MCP and application scripting remain preferable when they provide a qualified operation. The existing durable Photoshop document adapters continue to handle supported create/edit/export requests; `native_app` covers UI operations through the same normal tool authority and task execution harness.

## Implementation

- `resources/computer-use/bridge.swift`: strict target controller, snapshots, semantic and process/window-targeted input, nonactivating launch and preservation evidence.
- `src/electron/agent/tools/native-app-tools.ts`: strict argument validation, scoped consent, path admission, journal barriers, uncertain-outcome gate and automatic readback.
- `src/electron/computer-use/helper-runtime.ts`: nonreplayed mutation transport and source-consistent helper updates.
- `src/electron/agent/native-app-observation.ts`: bounded, volatile native observations retained for cross-step verification. Dispatch acknowledgements are excluded.
- Existing registry/coordinator, permission, tool setting, companion-image and completion paths expose the route through ordinary prompts.

## Qualified applications

Qualification is per app and per control. The route reports these behaviors honestly instead of claiming success.

**Calculator** is qualified. A complete calculation runs through launch, window discovery, observation and semantic button presses, including while its window is on another Space. Every action leaves the user's foreground app, pointer, keyboard and clipboard untouched. If Calculator doesn't confirm a press, the result is `outcome_unknown`: the agent observes the display instead of replaying the press.

**Photoshop** is not qualified for generic background UI editing. Opening a document through a nonactivating launch makes Photoshop activate itself, which the helper reports as `outcome_unknown`. On an already-open document, setting the Character panel's font-size field and confirming it (`AXConfirm` or Return) echoes the new value but does not apply it, and Cmd+S then saves nothing. Use the local Photoshop document route ([local Photoshop editing](photoshop-local-editing.md)) for these edits; saved-file readback is the proof.

## Task-stated restrictions

When a task says not to use scripting (for example "do not use scripting to make the edit"), the scripting-based mutation tools (`application_operation`, `local_photoshop_create`, `local_photoshop_edit`, `native_application_create` and `run_applescript`) become task tool restrictions. They are hidden from the catalog and tool search, and any call that names one is denied by the policy pipeline's `task_restrictions` stage. Read-only readbacks such as `local_photoshop_read` stay available for verification.

## Verification evidence

Verification and summary steps receive a native action ledger built from the task's durable attempt journal, not from model text. For each attempt it lists the action, target, final status, and the helper's foreground, pointer, keyboard and clipboard evidence. A foreground change to another app, or pointer movement accompanied by physical mouse events, is attributed to the user; the helper already treats target self-activation and pointer movement without physical events as `outcome_unknown`. The ledger proves dispatch and preservation, never the app outcome.

Saved-file readbacks (`local_photoshop_read`, `local_photoshop_inspect`, `native_application_inspect`) also stay in later steps' context. Each lists the path, SHA-256, size, dimensions and layer text, font and size, and the newest readback of a path replaces older ones, so the final answer reports what is on disk after the attempted change.
