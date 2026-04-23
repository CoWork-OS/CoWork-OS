# Chronicle (Desktop Research Preview)

Chronicle is CoWork OS's opt-in desktop screen-context feature for vague, on-screen references such as:

- `what is this?`
- `what's on the right side?`
- `why is this failing?`
- `sync the latest draft`
- `use the same doc as before`

It extends CoWork's existing runtime instead of creating a separate memory system. Chronicle keeps a short local recent-screen buffer in the desktop app, resolves ambiguous references through `screen_context_resolve`, and promotes only task-used observations into the existing recall, evidence, and memory surfaces.

## What shipped

- **Screen-aware disambiguation**: resolves vague references like `this`, `that`, `the failing one`, `right side`, `same doc`, or `on screen`
- **Missing-context recovery**: helps the runtime find the active app, window, visible text, and source reference for tasks such as `sync the latest draft`
- **Background memory generation**: promoted observations can generate linked `screen_context` memory entries in the background when Chronicle and workspace memory settings allow it
- **Workflow/tool hints**: Chronicle-backed tasks can reinforce destination hints such as `google_doc`, `slack_dm`, `repo_file`, or `drive_folder`
- **Per-task control**: new-task flows in the main composer and Devices panel can disable Chronicle for a specific task without turning the feature off globally
- **Observation management**: promoted observations are visible and deletable from Memory settings

## What Chronicle does not do

- **Not a second memory lane**: raw passive frames are not indexed as a permanent memory database
- **Not channel/headless support**: Chronicle is desktop-only and is unavailable in headless or channel runtimes
- **Not automatic provider export**: passive frames stay local; Chronicle does not send screenshots to external providers by itself
- **Not a replacement for direct sources**: if CoWork can read the actual file, URL, PR, or document, that remains the stronger source of truth

## How it works

Chronicle uses a hybrid capture model:

- passive capture is **opt-in**
- the default buffer captures every **10 seconds**
- the default retention window is **5 minutes**
- the default hard cap is **60 frames**
- the default capture scope is the **frontmost display**
- the runtime first searches the local recent-screen buffer
- if the passive match is weak, `screen_context_resolve` can fall back to a fresh local screenshot

Only observations that were actually used by a task are promoted into workspace state:

- promoted observations are stored under `.cowork/chronicle/observations/`
- copied image assets for those promoted observations are stored under `.cowork/chronicle/assets/`
- raw passive buffer frames stay in the app's user-data area and are aggressively pruned
- promoted observations remain `screen_context` evidence records; when background generation is on, they can also create linked `screen_context` memory rows

Every `screen_context_resolve` result is marked as screen-derived, untrusted context. OCR or visible on-screen text must not be treated as instructions to follow automatically.

## Setup

1. Open **Settings > Memory Hub > Chronicle**.
2. Turn on **Chronicle (Research Preview)** and accept the consent prompt.
3. Confirm **Screen Recording** is granted for CoWork OS.
4. Optionally grant **Accessibility** for stronger frontmost app/window/source metadata.
5. If you changed Screen Recording, quit and restart the app.
6. Optionally choose:
   - **Capture scope**: `Frontmost display` or `All displays`
   - **Generate Chronicle-backed memories in the background**
   - **Respect workspace memory privacy and auto-capture settings**
7. Leave the target window visible for at least one capture cycle so Chronicle has recent frames to search.

The same Chronicle card is also mirrored under **Settings > Tools** so the screen-context controls stay close to the broader tool and permission surfaces.

### Current defaults

| Setting | Default |
|---------|---------|
| Enabled | `false` |
| Mode | `hybrid` |
| Paused | `false` |
| Capture interval | `10` seconds |
| Retention window | `5` minutes |
| Frame cap | `60` |
| Capture scope | `frontmost_display` |
| Background memory generation | `true` |
| Respect workspace memory settings | `true` |

## What the UI shows

The Chronicle settings card exposes:

- enabled / paused state
- Screen Recording status
- Accessibility status
- OCR availability
- current frame count and buffer size
- last capture time
- last memory-generation time
- capture interval, retention window, frame cap, and capture scope

If the tray/menu-bar surface is enabled, Chronicle also exposes a quick **Pause Chronicle / Resume Chronicle** action there.

## How to test it in practice

Use a deterministic smoke test first.

1. Enable Chronicle.
2. Make sure **Settings > Tools > Built-in tools** still has the **Chronicle** category enabled.
3. In the task composer or Devices task launcher, leave the per-task **Chronicle ON** toggle enabled.
4. Open a desktop window with unique visible text, for example a note containing `CHRONICLE TEST 123`.
5. Keep that window visible for **15-30 seconds**.
6. Start a fresh task and ask one of these:
   - `Use screen_context_resolve now. Tell me what app and window are on screen.`
   - `Use screen_context_resolve and quote the visible text near the top right.`
   - `Use screen_context_resolve and identify the element on the right side.`

After that works, try vaguer prompts such as:

- `what is this on screen`
- `what's on the right side`
- `why is this failing`

If OCR-backed matching is important, install local `tesseract`. The Chronicle settings card shows whether OCR is currently available.

## How to tell whether Chronicle was used

- the task trace should show a tool call to `screen_context_resolve`
- Mission Control task detail should show the learning step **Chronicle screen context used**
- Mission Control recall/search should show `screen_context` evidence or recall results
- **Settings > Memory Hub > Memory** should show promoted entries under **Chronicle observations**

## Privacy and security model

- passive frames stay local to the desktop app
- raw frames are pruned by retention time and frame cap
- passive capture does not call external model providers by itself
- later image or vision analysis still follows the normal explicit screenshot / export approval path
- only task-used observations are copied into workspace state
- when **Respect workspace memory privacy and auto-capture settings** is on, durable Chronicle promotion follows workspace memory gates before writing observations
- local Chronicle files can still be accessed by other software running as you on the same machine

## Sensitive content guidance

Chronicle can observe whatever is visible on screen during its capture window. If you are about to view sensitive material that you do not want Chronicle to use as context:

- pause it from the Chronicle settings card or tray menu, or
- turn it off entirely from **Settings > Memory Hub > Chronicle**

## Prompt injection risk

Like OpenAI's Chronicle guidance, the main safety caveat is that screen content can contain instructions that should not be trusted.

Examples:

- a web page that tells the agent to ignore the user
- terminal output containing adversarial instructions
- a document or chat thread with malicious assistant-like directions embedded in the visible text

Chronicle should be treated as **context evidence**, not as an authority override. The runtime tags returned Chronicle text as untrusted screen text, and derived Chronicle memories repeat that warning inside their content.

## Relationship to other features

- **Computer use**: Chronicle shares desktop-screen prerequisites such as Screen Recording, but Chronicle is for local screen context lookup rather than mouse/keyboard control
- **Mission Control**: promoted Chronicle observations appear in learning/evidence and unified recall
- **Memory Hub**: Chronicle is configured alongside local memory, and Chronicle-backed memories can be linked into the existing memory system
- **AI Playbook**: Chronicle can reinforce destination and workflow hints, but it reuses the existing playbook and recall systems

## User-facing surfaces

- **Settings > Memory Hub > Chronicle**: primary Chronicle setup and status surface
- **Settings > Tools > Built-in tools**: enable or prioritize the dedicated `chronicle` tool family
- **Task composer / Devices**: per-task Chronicle ON/OFF toggle
- **Settings > Memory Hub > Memory**: Chronicle observations management (list, delete, clear)
- **Mission Control task detail**: `screen_context` evidence, learning step, and unified recall hits
- **Search everything**: promoted `screen_context` results alongside tasks, messages, files, notes, memory, and knowledge graph
- **Tray/menu bar**: quick pause/resume when the tray surface is enabled

## Contributor map

| Area | Location |
|------|----------|
| Chronicle subsystem | `src/electron/chronicle/` |
| Tool registration and promotion into evidence | `src/electron/agent/tools/registry.ts` |
| Tool exposure / routing | `src/electron/agent/tool-policy-engine.ts`, `src/electron/agent/executor.ts`, `src/electron/agent/strategy/IntentRouter.ts` |
| Prompt guidance | `src/electron/agent/tools/tool-prompting.ts` |
| Runtime visibility / unified recall | `src/electron/agent/RuntimeVisibilityService.ts` |
| IPC handlers | `src/electron/ipc/handlers.ts`, `src/electron/preload.ts` |
| Settings UI | `src/renderer/components/ChronicleSettings.tsx`, `src/renderer/components/MemoryHubSettings.tsx` |
| Observation management UI | `src/renderer/components/MemorySettings.tsx` |
| Tray controls | `src/electron/tray/TrayManager.ts` |
| Task-level toggles | `src/renderer/components/MainContent.tsx`, `src/renderer/components/DevicesPanel.tsx`, `src/renderer/App.tsx` |

## Related docs

- [Features](features.md)
- [Getting Started](getting-started.md)
- [Computer use (macOS)](computer-use.md)
- [Mission Control](mission-control.md)
- [Workspace Memory Flow](workspace-memory-flow.md)
- [Operator Runtime Visibility](operator-runtime-visibility.md)
- [Execution Runtime Model](execution-runtime-model.md)
- [Troubleshooting](troubleshooting.md)
