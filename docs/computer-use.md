# Computer use

Computer use lets the agent drive **native desktop applications** on macOS and Windows through real mouse, keyboard, and screen capture—when integrations, browser automation, and shell are not the right tool for the job.

This page is the **authoritative product guide** for the feature. For a short summary, see [Features → Computer use](features.md#computer-use).

## What it is for

Use computer use when the task clearly requires **a desktop GUI** that is not exposed through a stable API or through the in-app browser tools—for example:

- Operating a native app’s windows, menus, or dialogs
- Filling fields or clicking controls that only exist in a desktop UI
- Short, bounded flows where scripting the UI is impractical

**Prefer instead** when possible:

- **MCP connectors and APIs** for SaaS and internal systems
- **`browser_*` tools and the [Browser Workbench](browser-workbench.md)** for web surfaces, website testing, normal-user browser flows, Browser V2 snapshot refs, diagnostics, screenshots, annotation, and visible in-app browser automation
- **`run_command` / scripts** for file, git, and CLI workflows
- **`open_application`** to launch an app; pair with `screenshot`/`click`/`type_text` only when the agent must then interact with that app’s UI

The planner and tool policy treat the computer-use lane as a **controlled, last-resort path**: tools stay deferred unless the task signals **native desktop GUI intent** (for example Calculator, System Settings, or “click the OK button in the native dialog”). That keeps routine coding and web work from accidentally taking the desktop-control path.

> If the task is not asking CoWork to click or type, but instead to understand a vague on-screen reference like `what is this`, `what's on the right side`, or `why is this failing`, see [Chronicle](chronicle.md). Chronicle shares the same Screen Recording prerequisite but resolves local screen context rather than driving the mouse and keyboard.

## Platform requirements

- **macOS and Windows desktop builds** are supported. Linux/headless builds do not expose this tool family.
- **macOS** uses a bundled Swift helper with Accessibility and Screen Recording permissions.
- **Windows v1** uses a bundled PowerShell/Win32 helper for visible, non-minimized windows. Some protected or elevated apps may block capture or input unless CoWork is running with comparable privileges.

## Access-profile and operating-system boundaries

Computer-use tools must be exposed by the task's effective [access
profile](access-profiles.md) and remain subject to administrator policy,
tool restrictions, hard key-combination blocks, and action-specific approval.
Selecting **Full access** does not grant macOS Accessibility or Screen
Recording; those are independent operating-system permissions. Conversely,
granting those OS permissions does not widen the task's filesystem, network,
or command-tool profile. A remote or fallback computer-use route cannot use
its transport to bypass the local profile.

## macOS permissions

Two system permissions gate computer use:

| Permission | Why it matters |
|------------|----------------|
| **Accessibility** | AX-first focus, press, and value-setting require the helper to be trusted for accessibility control. |
| **Screen Recording** | Capturing the controlled window for `screenshot()` and follow-up action refreshes uses the helper’s ScreenCaptureKit path, which macOS treats as screen recording. |

**Where to enable in the product**

1. Open **Settings → Tools → Computer use**.
2. Use the shortcuts into **System Settings** to enable **Accessibility** and **Screen Recording** for the computer-use helper binary shown in settings.
3. After changing **Screen Recording**, **quit and restart CoWork OS** if capture still fails—macOS sometimes caches the old state until restart.

If a tool returns an error mentioning screen capture timeout or permission, re-check Screen Recording for this app and restart.

## Windows behavior

Windows computer use targets one visible, non-minimized top-level window at a time. The helper enumerates native windows, captures the selected window region, and sends mouse/keyboard input through Win32 APIs.

Known v1 limits:

- Minimized windows are not controlled; restore the target window first.
- Apps running as administrator may require CoWork to run as administrator.
- Some games, protected apps, or anti-cheat surfaces may block capture or input.
- If background capture/control is unavailable, actions may briefly use the foreground mouse and keyboard.

## Session model (one active session)

Computer use runs under a **single global session** on the machine:

- Only **one** computer-use session is active at a time; starting control for a new task coordinates with the session manager.
- **Esc** aborts the active computer-use session so you can interrupt quickly without hunting in the UI.
- **Sequential execution** and a **shortcut guard** reduce the chance of overlapping actions or global hotkeys firing at the wrong time during automation.

The session is torn down when the task finishes or the session ends cleanly after abort.

## Built-in tools

All of these are part of the **`computer_use` built-in tool family**. They are registered together and can be enabled or prioritized alongside other built-in categories in **Settings → Tools → Built-in tools**.

| Tool | Role |
|------|------|
| `screenshot` | Select or refresh the current controlled window and return a fresh screenshot plus `captureId`. |
| `click` / `double_click` | Click inside the current controlled window using screenshot-relative coordinates. |
| `move_mouse` | Move the pointer without clicking. |
| `drag` | Drag through a screenshot-relative path in the controlled window. |
| `scroll` | Scroll at a screenshot-relative point in the controlled window. |
| `type_text` | Type or set text into the currently focused control. |
| `keypress` | Emit key chords or special keys; dangerous combinations are blocklisted at the tool layer. |
| `wait` | Pause briefly, then refresh the controlled-window screenshot. |

Key contract details:

- Call `screenshot()` first.
- All action coordinates are relative to the latest screenshot, not the whole desktop.
- Successful actions return a new screenshot and `captureId`.
- Passing a stale `captureId` fails with a refresh instruction.

## Related tools: `open_application`

`open_application` can launch native apps by name or bundle id/path where supported. For **native GUI workflows**, policy may allow `open_application` in the same steps as `screenshot`/`click`/`type_text` so the agent can start the target app before driving it. On macOS, that is separate from **shell**-based AppleScript or one-off scripts: when the goal is **GUI interaction**, the product steers toward the dedicated computer-use tools (and `open_application` when needed) rather than `run_applescript` as a first choice.

## Routing and planner behavior (operator mental model)

Rough order the stack encourages:

1. **Structured integrations** (MCP, APIs, mail, channels).
2. **Browser tools** for web UIs.
3. **Shell and file tools** for repo and CLI work.
4. **`open_application`** when the missing piece is “the app is not running.”
5. **`screenshot` + follow-up computer-use actions** when the task still requires **native GUI** interaction.

**Native desktop GUI intent** is detected from the **user goal and step text** (not only from generic words like “browser” in strategy headers). Explicit mentions of native apps, windows, dialogs, or on-screen UI tend to unlock the computer-use lane; purely web or repo tasks should not.

## Settings checklist

1. **Built-in tools**: Confirm the `computer_use` category is enabled if you want the agent to use this lane at all.
2. **Permissions / platform status**: On macOS, Accessibility + Screen Recording granted for the helper binary; restart after Screen Recording changes if needed. On Windows, confirm the helper is installed and the target window is visible/non-minimized.
3. **Operational model**: Expect a foreground-first controlled-window loop centered on `screenshot()` and the latest `captureId`.
4. **Chronicle**: If your goal is contextual screen understanding rather than GUI control, enable **Settings > Memory Hub > Chronicle**, keep the dedicated **Chronicle** built-in tool category enabled, and test `screen_context_resolve` before forcing a computer-use flow.

## Security and abuse considerations

Computer use is **high trust**: a mistaken or malicious task could operate any UI your user can reach. Mitigations include:

- Esc abort and single-session sequential execution
- Helper-targeted permissions with inline bootstrap on macOS; visible-window constraints on Windows
- Policy that keeps the computer-use lane off the default path unless GUI intent is clear
- Blocklisted key combinations that could disrupt the session or OS

For how this fits the wider tool-risk model, see [Security guide → Computer use](security-guide.md#computer-use-security).

## Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| Screenshot or capture errors / timeouts | macOS: Screen Recording for the helper path shown in settings; restart app after granting. Windows: target window visible, non-minimized, and not protected/elevated above CoWork. |
| Clicks or keys do nothing | macOS: Accessibility trust for the helper path shown in settings. Windows: target app is not elevated/protected and no other app is stealing focus. |
| Agent uses shell or browser instead of desktop | Task may not read as native GUI; rephrase with explicit app/window/dialog language, or ensure built-in `computer_use` is enabled. |
| Agent asks for a screenshot when the task is really “what is this on screen?” | This may be a Chronicle case rather than a computer-use case; enable Chronicle and test `screen_context_resolve` with a clear on-screen prompt first. |
| Permission bootstrap repeats | macOS: re-check that both Accessibility and Screen Recording are granted to the helper binary, not just to CoWork OS or Terminal. |
| Session feels “stuck” | Use **Esc** to abort the computer-use session, then cancel or adjust the task. |

## Implementation map (for contributors)

| Area | Location |
|------|----------|
| Tool definitions and execution | `src/electron/agent/tools/computer-use-tools.ts` |
| Helper runtime + providers | `src/electron/computer-use/helper-runtime.ts`, `src/electron/computer-use/provider.ts`, `resources/computer-use/bridge.swift`, `resources/computer-use/bridge.ps1` |
| Session lifecycle | `src/electron/computer-use/session-manager.ts`, `shortcut-guard.ts` |
| Policy / routing | `src/electron/agent/tool-policy-engine.ts`, `src/electron/agent/executor.ts` |
| Settings / IPC | `src/renderer/components/ComputerUseSettings.tsx`, IPC handlers |

---

**See also:** [Chronicle](chronicle.md), [Architecture](architecture.md), [Features](features.md), [Security guide](security-guide.md), [Operator runtime visibility](operator-runtime-visibility.md).
