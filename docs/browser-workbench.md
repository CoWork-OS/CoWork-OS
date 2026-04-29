# Browser Workbench

CoWork OS uses the Browser Workbench for live website testing and browser-use tasks.

When a task asks the agent to go to a website, test an app as a normal user, click through a flow, fill a form, inspect a JavaScript-heavy page, or take browser screenshots, CoWork opens a visible browser session inside the app instead of silently launching an external browser. The user and the agent share the same page in a resizable right-sidebar workbench.

This is part of the broader [Everything Workbench](everything-workbench.md): generated files, live sites, and follow-up requests stay attached to the task instead of being scattered across separate apps.

## Default Behavior

Interactive browser-use prompts prefer the visible in-app browser:

```text
go to llmwizard.com and test the application as a normal user
```

For prompts like this, `browser_navigate` opens the Browser Workbench in the right sidebar for the selected task. Subsequent browser tools target that same visible webview by default.

The Browser Workbench supports:

- resizable right-sidebar placement with the same persisted width behavior used by documents, spreadsheets, presentations, and web page artifacts
- fullscreen mode with the same follow-up composer and latest-turn/working context frame as artifact workbenches
- a persistent per-workspace browser profile that keeps cookies and local storage separate from system Chrome
- URL bar, back, forward, reload, fullscreen, close, screenshot, and annotation controls
- visible cursor movement during agent actions such as click, fill, type, select, wait, read, scroll, and navigation
- screenshots saved to the workspace
- screenshot annotation in-app, with the annotated image attachable back to the task

Use `web_fetch` for static page reading or summarizing a known URL. Use the Browser Workbench when the page needs interaction, JavaScript rendering, form input, visual inspection, or normal-user testing.

## Visible Automation

Browser tools first route to the active Browser Workbench session for the selected task:

- `browser_navigate`
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

During visible automation, CoWork renders a cursor overlay on top of the webview so users can see where the agent is acting. Clicks and navigation controls pulse briefly; form and read actions show short labels such as `Click`, `Fill`, `Type`, `Found`, or `Read`.

This cursor is a Browser Workbench overlay. It appears for actions routed through the visible in-app browser, not for external Chrome windows or fully headless/background browser runs.

## Browser Controls

The Browser Workbench header and toolbar are functional, not cosmetic:

- **Back / Forward / Reload** control the embedded webview history and page reload.
- **URL bar** navigates the current workbench session.
- **Screenshot** captures the current visible browser page into the workspace.
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

- `browser_attach` with a Chrome DevTools URL for an already-running signed-in Chrome session
- explicit `profile`, `browser_channel`, or `debugger_url` options when a task needs the native Playwright/Chrome path

Those paths are intentionally labeled as outside the embedded Browser Workbench default.

## Relationship To Web Page Artifacts

Generated web pages and live websites use different surfaces:

- **Web page artifacts** are local files created by a task, such as `index.html` or `dist/index.html`. They open from artifact cards in a sandboxed iframe preview. See [Web Page Artifacts](web-page-artifacts.md).
- **Browser Workbench sessions** are live websites or local app URLs being navigated, clicked, filled, tested, or screenshotted by the agent.

`Open in browser` on a generated web page artifact still means the external system browser. Loading a generated page into the Browser Workbench is useful when the user explicitly asks to test it as a live site.

## Fallbacks

The visible Browser Workbench is the default for interactive website testing, but CoWork keeps fallback paths for situations where an embedded renderer is not available or the user explicitly asks for a different mode.

Browser tools fall back to the existing Playwright service when:

- no renderer/webview is available
- the task is running in a remote/headless environment
- the user explicitly requests `force_headless`
- the task specifies `profile`, `browser_channel`, or `debugger_url`
- the task uses explicit Chrome DevTools attach for an existing signed-in Chrome session

The legacy `headless` flag is compatibility-only and should not bypass the visible Browser Workbench for normal user-facing website testing.

## Implementation Notes

Key files:

- `src/renderer/components/BrowserWorkbenchView.tsx`: renderer-owned webview, toolbar, fullscreen mode, screenshot annotation, follow-up composer, and visible cursor overlay
- `src/electron/browser/browser-workbench-service.ts`: main-process service that maps `{ taskId, sessionId }` to the renderer webview `webContentsId`, routes browser actions, captures screenshots, and emits cursor events
- `src/electron/agent/tools/browser-tools.ts`: browser tool routing, visible-workbench preference, and Playwright fallback behavior
- `src/electron/preload.ts`: Browser Workbench registration, status, screenshot, open-request, and cursor IPC bridge
- `src/shared/types.ts`: Browser Workbench IPC channel names
- `src/renderer/App.tsx`: sidebar/fullscreen workbench state and task integration

## Verification

Manual smoke checks:

1. Run a task such as `go to example.com and test the application as a normal user`.
2. Confirm the Browser Workbench opens in the right sidebar.
3. Confirm the page uses the full sidebar width and height.
4. Confirm back, forward, reload, screenshot, annotate, fullscreen, and close controls work.
5. Confirm the visible cursor moves during agent clicks, fills, reads, waits, scrolls, and navigation.
6. Toggle fullscreen and confirm the same session is preserved.
7. Send a follow-up from fullscreen and confirm the prompt clears, the context frame switches to working, and the browser remains visible.

Build checks:

```bash
npm run build:react
npm run build:electron
npm run type-check
```
