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

Browser V2 gives CoWork one browser contract across visible workbench sessions and Playwright fallback runs. Attaching to an already-running external Chrome or Edge over the DevTools Protocol is refused, because pre-existing sockets and workers in that browser cannot be brought under the task's network policy.

Core rules:

- Visible in-app Browser Workbench is the default agent browser.
- Main-process automation is CDP-backed through `BrowserSessionManager`, not DOM-script-first renderer automation.
- Launching Chrome with your system profile is explicit opt-in only; attaching to an already-running browser is refused.
- Accessibility snapshot refs are the preferred control path.
- Selector-based tools continue to work for compatibility.
- Diagnostics, downloads, uploads, dialogs, storage, screenshots, and traces belong to the browser session.

See [Browser V2 Architecture](browser-v2-architecture.md) for backend adapters, tool contracts, safety invariants, and verification guidance.

### Access profile and browser boundary

Every browser tool is resolved through the task's effective [access
profile](access-profiles.md) before the selected backend runs. The profile and
administrator policy can constrain network destinations, domain rules, file
uploads, downloads/exports, real-browser profile control, and available browser
tools. Switching from the visible workbench to Playwright or
Browser Use Cloud is a transport choice, not a permission escalation; the
backend cannot widen the task profile. OS Screen Recording, browser login
state, and external-browser consent remain separate prerequisites.

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
- `browser_new_tab`
- `browser_history_search` (asks the user once per task)
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

- **Back / Forward / Reload** control the active tab's history and reload; reload becomes Stop while a page loads.
- **Address bar** navigates the active tab, or searches when the input is not an address (see Address Bar, Tabs And Shortcuts below).
- **Viewport presets** resize the visible webview to desktop, tablet, or mobile breakpoints for responsive checks.
- **Screenshot** captures the current visible browser page into the workspace.
- **Diagnostics** opens a compact browser panel for console, network, downloads, storage, and trace context.
- **Snapshot overlay** draws the boxes and refs of CoWork's latest snapshot of the tab.
- **Annotate screenshot** captures the page, opens an annotation layer, and can save the marked-up image or send it to the agent as an image attachment.
- **Fullscreen** promotes the same browser session into the full app view.
- **Close** closes the workbench and restores the normal right panel.

The workbench keeps its pages loaded when moving between sidebar and fullscreen. Closing the workbench unregisters its tabs from the main process; reopening it restores the tabs' URLs.

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

- `profile: "user"` launches a separate Chrome with your system profile after you approve real-browser control; it fails if Chrome is already running with that profile
- explicit `profile` or `browser_channel` options when a task needs the Playwright-local path

`browser_attach` and `debugger_url` (attaching to an already-running Chrome or Edge over the DevTools Protocol) are refused under the enforced network policy. Sign in inside the Browser Workbench or use a dedicated browser profile instead. Real signed-in Chrome control requires explicit user consent, and the default embedded Browser Workbench never reuses system Chrome cookies automatically.

## Tabs, Popups And Local Pages

- Each workbench tab keeps its own mounted webview, so switching tabs keeps scroll position, form input and history. Inactive tabs are hidden, not unloaded; beyond 12 live tabs the least recently used ones are unloaded and reload their URL when selected.
- Every tab registers with the main process (`{ taskId, sessionId, tabId, webContentsId }`) before it loads anything; an unregistered page is denied every request. Tools act on the active tab: `browser_tabs` lists all tabs, `browser_switch_tab` and `browser_close_tab` work on workbench tabs, and `browser_new_tab` opens one. Snapshot refs belong to one tab; a ref used on another tab fails with the owning tab id.
- Links with `target=_blank` and plain `window.open(url)` open as workbench tabs next to the page that opened them. `window.open` with window features (OAuth and payment popups) opens a real popup window on the same partition, so `window.opener` works; it is registered as a `popup` tab and becomes the tab tools act on until it closes. Popup targets are checked against the task's access profile first.
- Switching between the sidebar and full view keeps the pages loaded: the workbench is mounted once and positioned over the sidebar slot instead of being remounted. Closing the workbench and opening it again for the same task restores the tabs' URLs for the app session (pages reload).
- A local dev server typed into the address bar (for example `localhost:5173`) opens for the rest of the session; allowances the agent or a preview creates expire after five minutes without use. Loopback allowances cover the whole origin, so the server's routes and assets load. Local HTML files still need an explicit preview.
- Blocked, failed and crashed pages show a notice in the tab with the reason (access profile, admin policy, local page not opened, unsupported link type) instead of doing nothing. A policy block cannot be overridden from the notice.
- The workbench presents a Chrome-compatible user agent (the bundled Chrome version, without Electron or app tokens) so sites that refuse embedded browsers render normally. Use the real Chrome profile option for sites that still refuse.

## Address Bar, Tabs And Shortcuts

- Address bar: typing words searches with the default search engine (Settings > Browser, or the picker at the bottom of the suggestions); URL-looking input (`example.com`, `localhost:5173`, an IP) navigates. Suggestions come from history, open tabs and recently closed tabs. The chip on the left shows the connection (secure, not secure, local, blocked) and copies the address; a zoom badge appears when the page is zoomed.
- Tab strip: favicons, loading and audio indicators, middle-click to close, drag to reorder, pinned tabs, and a tab menu (new tab to the right, reload, duplicate, pin, mute, close, close others, close to the right, reopen closed tab).
- Shortcuts while the page or the workbench has focus (they replace the app's Cmd+R / Cmd+W / zoom there): Cmd+T, Cmd+W, Cmd+Shift+T, Ctrl+Tab, Cmd+Shift+] / [, Cmd+1–9, Cmd+L, Cmd+R, Cmd+Shift+R, Cmd+[ / ], Cmd+F, Cmd+G, Cmd+Shift+G, Cmd+= / - / 0, Cmd+Shift+B (sidebar ↔ full view). Ctrl replaces Cmd on Windows and Linux. Other keys reach the page.
- Find in page (match count, match case), per-site zoom (remembered), trackpad pinch, trackpad swipe and mouse back/forward buttons.
- Right-click menu in pages: navigation, link and image actions, copy/paste and spelling, search the web, Ask CoWork About This, Annotate This Element, Take Screenshot, and Inspect Element in developer mode.
- Diagnostics drawer: the visible tab's console (level filter, search, clear, send errors to CoWork), network (failed only), downloads, storage and trace.
- Snapshot overlay: boxes and refs from CoWork's latest `browser_snapshot` of the tab. It never takes a snapshot itself.

## Working Alongside CoWork

- `@Browser` in the composer opens the in-app browser for the task, and CoWork then browses in the visible workbench even when browsing defaults to the background.
- When an action makes the page open a popup or tab, the result reports `switchedToTab` and later actions target it; when that popup closes, the result reports `activeTabClosed` and actions return to its opener.
- Annotate: click an element, or drag to annotate an area (the elements inside it are recorded). For one element, Adjust edits text, font, size, weight, line height, colors, margin, padding, radius and alignment with a live preview in the page; the annotation carries the requested changes and before/after screenshots, and the page is put back when the annotation is saved or cancelled.

- While CoWork acts in the workbench, a banner says what it is doing and a click on the page asks whether to take over. Taking over pauses CoWork: its next browser tool calls return `paused_by_user` until you press Resume.
- When an agent navigation lands on a sign-in page (a known identity provider, or a login page with a password field), the tool result says `needs_user_sign_in` and the workbench asks you to sign in; Done tells CoWork to continue.
- The profile menu (person icon) clears browsing data, signs out of all sites, opens the page in the system browser, and opens Settings > Browser.

## Downloads, Uploads, Dialogs, And Permissions

Browser V2 treats browser side effects as governed workspace actions:

- Downloads you start go to the system Downloads folder, the workspace's `downloads/` folder, or a save dialog (Settings > Browser). Downloads CoWork causes always go to the workspace's `downloads/` folder, and Settings > Browser decides whether they are allowed, asked for, or blocked. A download's URL must pass the tab's access policy; downloads from pages that are not workbench tabs are cancelled. The download shelf shows progress, pause, resume, cancel, open and show in folder, and `browser_downloads` reports the saved file.
- Executables, installers, scripts and archives are flagged: they are never opened automatically and opening one asks first.
- Uploads require workspace-readable file paths and path validation.
- JavaScript dialogs are handled with `browser_handle_dialog` and should be visible in diagnostics.
- Site permissions are never granted silently. Fullscreen, sanitized clipboard writes and encrypted media playback are allowed; camera, microphone, location, notifications, clipboard reads, MIDI, HID, serial, USB, pointer/keyboard lock, file system access and opening external apps show a prompt in the tab (Allow this time, Always allow, Never allow); everything else, including screen capture, is denied. "Always" and "Never" are remembered per workspace browser profile and site. Pages that are not registered workbench tabs are denied.
- Downloads, uploads, and real-browser profile control should surface permission prompts instead of being silently granted.
- Console, network, storage, and download metadata are redacted before entering agent context.
- The active access profile is checked before these browser actions; a profile or domain deny cannot be widened by a backend switch or a one-shot approval.

## History And Settings

- Pages visited in workbench tabs are recorded per workspace browser profile (URL, title, visit count and time). Credentials, fragments and secret-looking query parameters (tokens, OAuth codes) are removed before anything is stored; non-web URLs and popup windows are not recorded. Up to 10,000 pages are kept per profile.
- Developer mode gates `browser_evaluate`, `browser_storage` and `browser_trace_start`/`browser_trace_stop`: without it they are not offered to CoWork, and with it the first use on each site in a task asks for approval. Uploads by CoWork follow the upload setting (ask each time by default).
- Settings > Browser: search engine, download location, restore tabs, open conversation links in the in-app browser, Chrome-compatible user agent (applies after restart), recording history, CoWork downloads and uploads (ask / allow / block), developer mode, and per-workspace history, remembered site permissions and browsing data. Access profiles and admin policies still decide which sites can be reached; these settings cannot widen them.

## Relationship To Web Page Artifacts

Generated web pages and live websites use different surfaces:

- **Web page artifacts** are local files created by a task, such as `index.html` or `dist/index.html`. They open from artifact cards in a sandboxed iframe preview. See [Web Page Artifacts](web-page-artifacts.md).
- **Browser Workbench sessions** are live websites or local app URLs being navigated, clicked, filled, tested, or screenshotted by the agent.

`Open in browser` on a generated web page artifact still means the external system browser. Loading a generated page into the Browser Workbench is useful when the user explicitly asks to test it as a live site.

## Fallbacks

The visible Browser Workbench is the default for interactive website testing, but CoWork keeps fallback paths for situations where an embedded renderer is not available or the user explicitly asks for a different mode.

Browser tools fall back to the Playwright-local adapter when:

- no renderer/webview is available
- the task is running in a remote/headless environment
- the user explicitly requests `force_headless`
- the task specifies `profile` or `browser_channel`
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

- `src/renderer/components/BrowserWorkbenchView.tsx`: tab strip, toolbar, diagnostics drawer, snapshot overlay, fullscreen mode, screenshot annotation, follow-up composer, and visible cursor overlay
- `src/renderer/components/BrowserWorkbench/`: tab state and session restore (`browser-tabs-model.ts`, `useBrowserTabs.ts`), one webview per tab (`BrowserTabView.tsx`), blocked/failed/crashed notices, the permission prompt, and the dock that keeps the workbench mounted across sidebar and full view
- `src/electron/browser/browser-guest-attach.ts`: window-open handling (tabs and registered popup windows)
- `src/electron/browser/browser-permissions.ts`: site permission handlers and remembered decisions
- `src/electron/browser/browser-user-agent.ts`: Chrome-compatible user agent for the browser partitions
- `src/electron/browser/browser-session-manager.ts`: Browser V2 session registry, backend kind, CDP actions, accessibility snapshots, ref staleness, diagnostics, uploads, downloads, storage, emulation, and trace state
- `src/electron/browser/browser-workbench-service.ts`: main-process bridge that maps `{ taskId, sessionId }` to the renderer webview `webContentsId`, routes Browser V2 actions, captures screenshots, and emits cursor and viewport events
- `src/electron/agent/browser/browser-use-cloud-client.ts`: Browser Use Cloud API client, credential lookup, private-target blocking, and error redaction
- `src/electron/agent/tools/browser-tools.ts`: browser tool routing, visible-workbench preference, ref-aware actions, real-browser consent gates, and Playwright fallback behavior
- `src/electron/preload.ts`: Browser Workbench registration, status, screenshot, open-request, cursor, and viewport IPC bridge
- `src/shared/types.ts`: Browser Workbench IPC channel names
- `src/renderer/App.tsx`: sidebar/fullscreen workbench state and task integration

The deeper implementation contract lives in [Browser V2 Architecture](browser-v2-architecture.md).

## Verification

Automated end-to-end check in the real app (disposable profile, local fixture site, no model needed):

```bash
npm run build:electron
npm run build:react
node scripts/qa/browser-workbench-smoke.mjs
```

It opens the workbench from the title bar and checks: a typed local dev server address loads; three tabs keep form input, scroll and page state when switching; `target=_blank` opens a tab; a `window.open` sign-in popup posts to its opener and closes; five sidebar/full-view switches keep the page loaded; Cmd+F counts matches; Cmd+= zooms; a geolocation request prompts in the tab and "Never allow" is remembered; a download lands in the workspace and on the shelf; closing and reopening restores the tabs; a link to an unopened local port shows the blocked notice. Results and screenshots go to a temporary folder printed at the end.

Manual checks (things the harness cannot drive):

1. Right-click a page, a link, an image, selected text and a text field; confirm the native menus and their actions (open in new tab, copy, search, Ask CoWork, spelling suggestions).
2. Use the keyboard shortcuts with focus in the page and in the address bar; confirm Cmd+R and Cmd+W act on the tab, not the app.
3. Trackpad swipe and mouse back/forward buttons over the browser.
4. Sign in to Google in the workbench (Chrome-compatible user agent).
5. Run a task with `@Browser`: the browser opens, the "CoWork is using this tab" banner appears, clicking the page offers Take over, and Resume continues the task.
6. Let an agent navigate to a sign-in page; confirm the sign-in banner and that Done continues.
7. Annotate an area by dragging, and Adjust an element's text and font size; confirm the live preview, the sent changes and that the page is restored.
8. Settings > Browser: change the search engine, clear history, reset a site permission, toggle developer mode and confirm `browser_evaluate` asks for approval once per site.
9. Settings > Browser > "Use the classic browser" switches to the previous single-tab workbench (rollback for one release).
10. Call `browser_emulate` for desktop, tablet and mobile; confirm the size badge and screenshot dimensions.

Build checks:

```bash
npm run build:react
npm run build:electron
npm run type-check
npm run lint
npm run test
```
