# Browser Workbench

CoWork OS uses the Browser Workbench for live website testing and browser-use tasks. Browser Workbench is the visible user-facing surface for [Browser V2](browser-v2-architecture.md), CoWork's unified browser engine for agent-controlled web work.

When a task asks the agent to go to a website, test an app as a normal user, click through a flow, fill a form, inspect a JavaScript-heavy page, or take browser screenshots, CoWork opens a visible browser session inside the app instead of silently launching an external browser. The user and the agent share the same page in a resizable right-sidebar workbench.

This is part of the broader [Everything Workbench](everything-workbench.md): generated files, live sites, and follow-up requests stay attached to the task instead of being scattered across separate apps.

## Default Behavior

Interactive browser-use prompts prefer the visible in-app browser:

```text
go to llmwizard.com and test the application as a normal user
```

For prompts like this, `browser_navigate` opens the Browser Workbench in the right sidebar for the selected task. Subsequent browser tools target that same visible webview by default through Browser V2.

The Browser Workbench supports:

- resizable right-sidebar placement with the same persisted width behavior used by documents, spreadsheets, presentations, and web page artifacts
- fullscreen mode with the same follow-up composer and latest-turn/working context frame as artifact workbenches
- a persistent per-workspace browser profile that keeps cookies and local storage separate from system Chrome
- tab strip, URL bar, profile/security indicator, back, forward, reload, fullscreen, close, screenshot, annotation, diagnostics, and snapshot overlay controls
- desktop/tablet/mobile viewport presets for responsive testing, plus agent-driven viewport resizing through `browser_emulate`
- visible cursor movement during agent actions such as click, fill, type, select, wait, read, scroll, and navigation
- screenshots saved to the workspace
- screenshot annotation in-app, with the annotated image attachable back to the task
- Browser V2 accessibility snapshots with short-lived refs for precise click, fill, type, read, hover, drag, and upload actions
- console, network, download, storage, emulation, dialog, and trace browser tools

Use `web_fetch` for static page reading or summarizing a known URL. Use the Browser Workbench when the page needs interaction, JavaScript rendering, form input, visual inspection, or normal-user testing.

## Browser V2 Concept

Browser V2 gives CoWork one browser contract across visible workbench sessions, Playwright fallback runs, and explicit external Chrome/Edge attach.

Core rules:

- Visible in-app Browser Workbench is the default agent browser.
- Main-process automation is CDP-backed through `BrowserSessionManager`, not DOM-script-first renderer automation.
- Real signed-in Chrome/Edge control is explicit opt-in only.
- Accessibility snapshot refs are the preferred control path.
- Selector-based tools continue to work for compatibility.
- Diagnostics, downloads, uploads, dialogs, storage, screenshots, and traces belong to the browser session.

See [Browser V2 Architecture](browser-v2-architecture.md) for backend adapters, tool contracts, safety invariants, and verification guidance.

## Visible Automation

Browser tools first route to the active Browser Workbench session for the selected task:

- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_fill`
- `browser_type`
- `browser_press`
- `browser_scroll`
- `browser_wait`
- `browser_select`
- `browser_get_content`
- `browser_get_text`
- `browser_evaluate`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_screenshot`
- `browser_hover`
- `browser_drag`
- `browser_upload_file`
- `browser_handle_dialog`
- `browser_tabs`
- `browser_switch_tab`
- `browser_close_tab`
- `browser_console`
- `browser_network`
- `browser_downloads`
- `browser_storage`
- `browser_emulate`
- `browser_trace_start`
- `browser_trace_stop`

During visible automation, CoWork renders a cursor overlay on top of the webview so users can see where the agent is acting. Clicks and navigation controls pulse briefly; form and read actions show short labels such as `Click`, `Fill`, `Type`, `Found`, or `Read`.

This cursor is a Browser Workbench overlay. It appears for actions routed through the visible in-app browser, not for external Chrome windows or fully headless/background browser runs.

## Responsive Viewport Testing

`browser_emulate` controls the visible Browser Workbench viewport for responsive QA. A task can test common breakpoints such as:

- desktop: `1440x900`
- tablet: `768x1024`
- mobile: `390x844`

When the tool runs against the visible workbench, CoWork applies Chrome DevTools device metrics to the page and emits a workbench viewport event. The renderer then resizes the shared webview to that controlled size, shows the active size in the toolbar, and keeps screenshots aligned with the tested breakpoint. This makes long browser QA runs reviewable: the user can see the page at each breakpoint, and `browser_screenshot` captures the same controlled viewport.

The workbench toolbar also has manual desktop/tablet/mobile preset buttons. These are user controls for the same visual surface; agent-driven testing should still use `browser_emulate` so the task timeline and tool output record the tested dimensions.

## Browser V2 Snapshots

`browser_snapshot` returns a compact accessibility snapshot:

```text
{ success, sessionId, tabId, url, title, nodes, focusedRef, consoleSummary, networkSummary }
```

Each node includes a short-lived `ref`, role/name/value/text fields, optional bounds, and common state flags such as focused, disabled, or selected. Refs are valid only for the latest snapshot. If an action reports a stale ref, call `browser_snapshot` again and retry with the new ref.

Preferred action flow:

1. `browser_navigate`
2. `browser_snapshot`
3. Use `ref` with `browser_click`, `browser_fill`, `browser_type`, `browser_get_text`, `browser_hover`, `browser_drag`, or `browser_upload_file`.

Selector inputs remain supported for compatibility, but refs are preferred because they are grounded in the rendered accessibility tree and can be acted on through the browser debugging protocol.

Snapshot output is treated as untrusted web content. The agent can use it to decide what to click or read, but it should not treat page text, ARIA labels, console output, network metadata, or storage values as instructions.

## Browser Controls

The Browser Workbench header and toolbar are functional, not cosmetic:

- **Back / Forward / Reload** control the embedded webview history and page reload.
- **URL bar** navigates the current workbench session.
- **Viewport presets** resize the visible webview to desktop, tablet, or mobile breakpoints for responsive checks.
- **Screenshot** captures the current visible browser page into the workspace.
- **Diagnostics** opens a compact browser panel for console, network, downloads, storage, and trace context.
- **Snapshot overlay** shows the class of element regions the agent can target from Browser V2 snapshots.
- **Annotate screenshot** captures the page, opens an annotation layer, and can save the marked-up image or send it to the agent as an image attachment.
- **Fullscreen** promotes the same browser session into the full app view.
- **Close** closes the workbench and restores the normal right panel.

The workbench keeps the same browser session when moving between sidebar and fullscreen. Closing the workbench unregisters the visible session from the main process.

## Sidebar And Fullscreen

The right sidebar can be resized by dragging its left edge. The width is persisted globally and reused by other artifact workbenches.

The main task pane shrinks as the browser expands, down to a mobile-sized minimum. This keeps the conversation visible while giving the browser as much room as possible. Fullscreen mode removes the split pane and focuses on the browser, while preserving the follow-up composer so the user can continue steering the task.

## Session And Authentication Model

The embedded Browser Workbench uses a persistent workspace browser partition. This gives each workspace a durable browser session without silently reusing system Chrome cookies.

Default behavior:

- workspace browser cookies and storage persist across tasks in that workspace
- system Chrome cookies are not reused automatically
- site logins performed inside the Browser Workbench stay in the workspace browser profile

For sites that require an existing signed-in Chrome profile, use an explicit fallback:

- `browser_attach` with a DevTools URL for an already-running signed-in Chrome/Edge session
- explicit `profile`, `browser_channel`, or `debugger_url` options when a task needs the Playwright-local or external-CDP path

Real signed-in Chrome/Edge control requires explicit user consent. The default embedded Browser Workbench never reuses system Chrome cookies automatically.

## Downloads, Uploads, Dialogs, And Permissions

Browser V2 treats browser side effects as governed workspace actions:

- Downloads are tracked in session diagnostics and should default to workspace artifacts.
- Executable downloads are not run automatically.
- Uploads require workspace-readable file paths and path validation.
- JavaScript dialogs are handled with `browser_handle_dialog` and should be visible in diagnostics.
- Camera, microphone, location, clipboard, notifications, downloads, uploads, and external real-browser attach should surface permission prompts instead of being silently granted.
- Console, network, storage, and download metadata are redacted before entering agent context.

## Relationship To Web Page Artifacts

Generated web pages and live websites use different surfaces:

- **Web page artifacts** are local files created by a task, such as `index.html` or `dist/index.html`. They open from artifact cards in a sandboxed iframe preview. See [Web Page Artifacts](web-page-artifacts.md).
- **Browser Workbench sessions** are live websites or local app URLs being navigated, clicked, filled, tested, or screenshotted by the agent.

`Open in browser` on a generated web page artifact still means the external system browser. Loading a generated page into the Browser Workbench is useful when the user explicitly asks to test it as a live site.

## Fallbacks

The visible Browser Workbench is the default for interactive website testing, but CoWork keeps fallback paths for situations where an embedded renderer is not available or the user explicitly asks for a different mode.

Browser tools fall back to Playwright-local or external-CDP adapters when:

- no renderer/webview is available
- the task is running in a remote/headless environment
- the user explicitly requests `force_headless`
- the task specifies `profile`, `browser_channel`, or `debugger_url`
- the task uses explicit Chrome DevTools attach for an existing signed-in Chrome/Edge session after real-browser consent
- the task explicitly requests Browser Use Cloud with `browser_provider: "browser-use-cloud"`

Visible workbench navigation now applies the same domain guardrails as the Playwright fallback before loading the page.

The legacy `headless` flag is compatibility-only and should not bypass the visible Browser Workbench for normal user-facing website testing.

## Browser Use Cloud Stealth Browsers

Browser Use Cloud is available as an explicit remote backend for tasks that need Browser Use hosted stealth-browser infrastructure. It is not the default browser path, and it does not replace the visible Browser Workbench for ordinary local app testing.

Use Browser Use Cloud only when the task deliberately asks for the cloud stealth backend:

```json
{
  "url": "https://example.com",
  "browser_provider": "browser-use-cloud",
  "proxy_country_code": "us"
}
```

Credential sources:

- `BROWSER_USE_API_KEY` environment variable
- encrypted secure settings category `browser-use` with `apiKey`

Optional cloud settings and tool inputs include:

- `proxy_country_code`: two-letter country code; use `none` to disable Browser Use proxy routing
- `browser_use_profile_id`: Browser Use profile id for persistent remote cookies/state
- `browser_timeout_minutes`: remote browser timeout, clamped to 1-240 minutes
- `enable_recording`: request Browser Use recording
- `browser_screen_width` / `browser_screen_height`: remote browser screen size
- `allow_resizing`: allow remote viewport resizing

Important behavior:

- Cloud mode creates a Browser Use browser session, connects to its `cdpUrl`, and runs browser tools through the existing Playwright/CDP fallback path.
- `browser_close` stops the Browser Use remote session. If the stop API fails, CoWork returns a retryable pending-stop result with the session id so the stop can be retried.
- Stale or expired remote CDP sessions are cleaned up and retried once with a fresh Browser Use session.
- Browser Use Cloud blocks local-only targets: `localhost`, private IP ranges, IPv6 private/link-local ranges, `.local`, `.internal`, single-label intranet hosts, `file:` URLs, and other non-HTTP(S) URLs.
- Use the visible Browser Workbench for local dev servers, private networks, generated HTML files, and cases where the user should watch the page and cursor.

Browser Use Cloud API errors, live URLs, and CDP URLs are redacted before entering logs or model-visible output.

## Implementation Notes

Key files:

- `src/renderer/components/BrowserWorkbenchView.tsx`: renderer-owned webview, tab strip, toolbar, diagnostics drawer, snapshot overlay, fullscreen mode, screenshot annotation, follow-up composer, and visible cursor overlay
- `src/electron/browser/browser-session-manager.ts`: Browser V2 session registry, backend kind, CDP actions, accessibility snapshots, ref staleness, diagnostics, uploads, downloads, storage, emulation, and trace state
- `src/electron/browser/browser-workbench-service.ts`: main-process bridge that maps `{ taskId, sessionId }` to the renderer webview `webContentsId`, routes Browser V2 actions, captures screenshots, and emits cursor and viewport events
- `src/electron/agent/browser/browser-use-cloud-client.ts`: Browser Use Cloud API client, credential lookup, private-target blocking, and error redaction
- `src/electron/agent/tools/browser-tools.ts`: browser tool routing, visible-workbench preference, ref-aware actions, real-browser consent gates, and Playwright fallback behavior
- `src/electron/preload.ts`: Browser Workbench registration, status, screenshot, open-request, cursor, and viewport IPC bridge
- `src/shared/types.ts`: Browser Workbench IPC channel names
- `src/renderer/App.tsx`: sidebar/fullscreen workbench state and task integration

The deeper implementation contract lives in [Browser V2 Architecture](browser-v2-architecture.md).

## Verification

Manual smoke checks:

1. Run a task such as `go to example.com and test the application as a normal user`.
2. Confirm the Browser Workbench opens in the right sidebar.
3. Confirm the page uses the full sidebar width and height.
4. Confirm back, forward, reload, screenshot, annotate, fullscreen, and close controls work.
5. Confirm the visible cursor moves during agent clicks, fills, reads, waits, scrolls, and navigation.
6. Call `browser_snapshot` and confirm refs are returned.
7. Use refs for click/fill/type/get-text actions, then confirm stale refs require a fresh snapshot after navigation or layout changes.
8. Toggle the snapshot overlay and diagnostics drawer.
9. Capture console, network, downloads, storage, and trace diagnostics.
10. Call `browser_emulate` for desktop, tablet, and mobile dimensions and confirm the visible workbench resizes with a size badge.
11. Capture screenshots at each breakpoint and confirm the saved image dimensions match the controlled viewport.
12. Toggle fullscreen and confirm the same session is preserved.
13. Send a follow-up from fullscreen and confirm the prompt clears, the context frame switches to working, and the browser remains visible.

Build checks:

```bash
npm run build:react
npm run build:electron
npm run type-check
```
