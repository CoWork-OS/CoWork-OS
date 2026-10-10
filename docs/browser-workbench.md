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
- a full view that gives the whole window to the browser (the task conversation stays in the normal view; tasks are sent from the new tab page, page menus and annotations)
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

The toolbar's More menu also has manual desktop/tablet/mobile page sizes. These are user controls for the same visual surface; agent-driven testing should still use `browser_emulate` so the task timeline and tool output record the tested dimensions.

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
- **Annotate** (the toolbar's one labelled action) comments on an element or a dragged area of the page.
- **More (⋯)** holds the rest:
  - **Annotate screenshot** captures the page, opens an annotation layer, and can save the marked-up image or send it to the agent as an image attachment.
  - **Save screenshot** captures the current visible browser page into the workspace.
  - **Open in system browser** opens the page outside CoWork.
  - **Page size** (Fit to panel, Desktop, Tablet, Mobile) resizes the visible webview for responsive checks. A forced size shows as a chip next to the address bar; click it to fit the panel again.
  - **Element outlines** draws the boxes and refs of CoWork's latest snapshot of the tab.
  - **Diagnostics** opens a compact browser panel for console, network, downloads, storage, and trace context.
- **Fullscreen** promotes the same browser session into the full app view.
- **Close** closes the workbench and restores the normal right panel.

The workbench keeps its pages loaded when moving between sidebar and fullscreen. Closing the workbench unregisters its tabs from the main process; reopening it restores the tabs' URLs.

## Browser Engine

Settings > Browser > Browser engine picks how tab pages are hosted. It applies the next time the browser opens.

- **Standard** (default): each tab is a `<webview>` inside the app window, owned by the renderer. Closing the browser or switching tasks unloads the tabs; reopening restores their URLs (pages reload).
- **Native tabs (experimental)**: each tab is a `WebContentsView` owned by the main process (`src/electron/browser/browser-tab-views.ts`) and drawn by the window over the tab's area. Pages stay loaded when the browser closes or the task switches, and reopening the tab shows the live page. Up to 24 views are kept; the least recently used hidden ones close and reload from their URL when shown again.

A native view always draws above the app's own interface. To keep overlays usable:

- the page is hidden under full-page overlays (new tab page, blocked/failed/crashed notices, page dialogs, the screen-share picker, the screenshot annotation editor);
- the page is swapped for a still image while a menu, popup, dialog or toast overlaps it, and during annotation and element outlines (`useSurfaceOcclusion`, `BrowserTabNativeView`);
- the permission prompt docks in the strip above the page instead of floating over it;
- while CoWork drives the tab, a click on the page is stopped in the main process and a "Take over" bar asks instead of the shield over the page. The agent's cursor overlay is not visible over a native page.

Each view is created on the browser partition (prepared first), gets the same guest handling as a webview tab (window-open routing, shortcuts, context menu, history, unload guard) and is registered with the session manager before it loads anything. The renderer reports the tab area's rectangle every frame while the tab is shown. Every native-tab IPC call must come from the app window, with validated ids, an allowlisted command, and only http(s), file or about:blank URLs.

Run the end-to-end check on either engine with `BROWSER_ENGINE=native node scripts/qa/browser-workbench-smoke.mjs`. On macOS it also saves real window captures (`window-*.png`), since the test driver's own screenshots can't show native views.

## Sidebar And Fullscreen

The right sidebar can be resized by dragging its left edge. The width is persisted globally and reused by other artifact workbenches.

The main task pane shrinks as the browser expands, down to a mobile-sized minimum. This keeps the conversation visible while giving the browser as much room as possible. Full view removes the split pane and gives the whole window to the browser; switch back to the sidebar (Cmd+Shift+B) to keep chatting with the task.

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
- Once CoWork's debugger is attached to a tab (after any agent action or diagnostics), Chromium stops showing the page's own `alert`/`confirm` and the page waits for an answer. The workbench shows them as a dialog over the tab (OK / Cancel, Enter / Esc) and brings that tab to the front; CoWork can still answer with `browser_handle_dialog`, whichever comes first. Popup windows use a native dialog. Without the debugger Electron shows its native dialog. `prompt()` isn't supported by Electron and throws in the page.
- A page that asks before unloading (unsaved changes) gets a native "Leave site?" dialog when you reload, navigate away, close its popup window or close its tab; "Stay" keeps the page and the tab. Closing a tab runs the page's check first. While CoWork is acting on the tab the page is left without asking, so the agent is never stuck behind the dialog. This works both before and after CoWork's debugger is attached to the page.
- Approvals CoWork asks for while using the browser (site access, page scripts in developer mode, uploads, downloads, history search) appear as a card over the tab while the browser is open, instead of the approval dialog. It answers through the same approval path with the same choices; with the browser closed, the dialog is used.
- Site permissions are never granted silently. Fullscreen, sanitized clipboard writes and encrypted media playback are allowed; camera, microphone, location, notifications, clipboard reads, MIDI, HID, serial, USB, pointer/keyboard lock, file system access and opening external apps show a prompt in the tab (Allow this time, Always allow, Never allow); everything else is denied. "Always" and "Never" are remembered per workspace browser profile and site. Pages that are not registered workbench tabs are denied.
- Screen sharing (`getDisplayMedia`) shows a picker in the tab with the screens and windows to share; nothing is shared until one is picked, and Cancel denies the request. On macOS the app needs Screen Recording permission for sources to appear.
- Electron reports a permission the site has not been granted as "denied" (it has no "ask" state), so sites that check before asking, notifications especially, may never ask. The profile menu has a per-site Notifications control (Ask, Allow, Block) for the current site; reload the page after changing it.
- Admin policies (`browser` section in [Admin Policies](admin-policies.md)) can lock developer mode and deny site permissions outright; a policy block beats any user decision.
- Downloads, uploads, and real-browser profile control should surface permission prompts instead of being silently granted.
- Console, network, storage, and download metadata are redacted before entering agent context.
- The active access profile is checked before these browser actions; a profile or domain deny cannot be widened by a backend switch or a one-shot approval.

## History And Settings

- Pages visited in workbench tabs are recorded per workspace browser profile (URL, title, visit count and time). Credentials, fragments and secret-looking query parameters (tokens, OAuth codes) are removed before anything is stored; non-web URLs and popup windows are not recorded. Up to 10,000 pages are kept per profile.
- Developer mode gates `browser_evaluate`, `browser_storage` and `browser_trace_start`/`browser_trace_stop`: without it they are not offered to CoWork, and with it the first use on each site in a task asks for approval. Uploads by CoWork follow the upload setting (ask each time by default).
- Right-click an image: Save Image to Workspace downloads it into the task workspace's `downloads/` folder as your own download.
- Clear browsing data with a time range clears history in that range, and cookies and site storage for the sites visited in it (from history). Cached files can only be cleared for all time.
- Cmd+Shift+B (Ctrl+Shift+B) in a task opens the browser, or switches it between the sidebar and full view.
- Settings > Browser: search engine, download location, restore tabs, open conversation links in the in-app browser, Chrome-compatible user agent (applies after restart), recording history, CoWork downloads and uploads (ask / allow / block), developer mode, and per-workspace history, remembered site permissions and browsing data. Access profiles and admin policies still decide which sites can be reached; these settings cannot widen them.

## Importing Cookies And Saved Logins

Settings > Browser > Import from another browser brings in cookies (to stay signed in) and saved logins for the selected workspace profile. Sources: Chrome, Edge, Brave, Chromium, Vivaldi and Arc (cookies and passwords), Firefox (cookies; export passwords to CSV from Firefox), and a password CSV file (Chrome, Edge, Bitwarden, 1Password, Firefox and similar column names). macOS only for browser import; CSV works everywhere.

How it is kept safe:

- **Nothing is imported without you.** Reading another browser's key makes macOS ask for permission; if you refuse, nothing is read. You then review counts and site names, and a native confirmation (outside the page UI) approves the import. The staged data lives only in the main process, expires after 5 minutes, works once and only for that workspace, and is wiped on commit or cancel.
- **Secrets never reach the app UI.** The window sees counts and site names only. Passwords are sealed one by one with the OS keychain (Electron `safeStorage`); if the OS would only obfuscate them (for example a Linux basic text backend), saving is refused rather than weakened. Saved logins can't be viewed, copied or exported from the app.
- **Filling is user-started and origin-locked.** The key button in the toolbar appears only when the current page's exact origin (https, or loopback http) has a saved login. Choosing one needs Touch ID (or a native confirmation where Touch ID is unavailable), then fills only the top page, only if the live address still matches, in an isolated script world. CoWork has no tool to fill logins, and any filled password is masked in everything CoWork reads back from that page.
- **Other browsers' files are never modified.** Their databases are copied to a private temporary folder, read read-only with the system `sqlite3`, and the copies are deleted. Profile ids are validated and never used as paths directly.
- **CSV files are untrusted input.** Size, row and field limits apply; binary or non-UTF-8 files, non-web and `http://` (non-loopback) logins and rows without a password are skipped and counted. After importing, you can delete the plain-text file (overwrite then remove; on SSDs this can't be guaranteed, so keep disk encryption on and empty the Trash).
- Cookies are validated (host, name, value and prefix rules, expiry) before being set on the workspace profile; partitioned, container and expired cookies are skipped.

Limits worth knowing: a page you fill a login into can read that field, as with any password manager; JavaScript strings holding a secret can't be wiped from memory on demand; Chrome-family Windows and Linux browsers aren't read directly (export a CSV).

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

- `src/renderer/components/BrowserWorkbenchView.tsx`: tab strip, toolbar, diagnostics drawer, snapshot overlay, full view, screenshot annotation, and visible cursor overlay
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

It opens the workbench from the title bar and checks: a typed local dev server address loads; three tabs keep form input, scroll and page state when switching; `target=_blank` opens a tab; a `window.open` sign-in popup posts to its opener and closes; five sidebar/full-view switches keep the page loaded; Cmd+F counts matches; Cmd+= zooms; a geolocation request prompts in the tab and "Never allow" is remembered; a download lands in the workspace and on the shelf; closing a tab with unsaved changes asks "Leave site?" and "Stay" keeps it; `confirm` and `alert` are shown and answered in the tab with CoWork's debugger attached; a browser approval shows as a card over the tab and not as a dialog; an admin policy locks developer mode and blocks the camera without a prompt; notifications can be allowed for a site from the profile menu; screen sharing shows the source picker and Cancel denies it; the focused address bar draws a single frame; the More menu sets a page size and the size chip clears it; the new tab page shows the ask box, ideas and recent sites; closing and reopening restores the tabs; a link to an unopened local port shows the blocked notice; Cmd+Shift+B reopens the browser from the task view. Results and screenshots go to a temporary folder printed at the end.

The smoke also checks the CSV import end to end (disposable profile, stubbed file dialog) and that a saved login fills only on its own site; set `QA_REAL_SCREEN_SHARE=1` and `QA_GOOGLE_SIGNIN=1` for the opt-in real screen share and Google sign-in page checks.

Manual checks (things the harness cannot drive):

1. Right-click a page, a link, an image, selected text and a text field; confirm the native menus and their actions (open in new tab, copy, Save Image to Workspace, search, Ask CoWork, spelling suggestions).
2. Share a real screen from a page that calls `getDisplayMedia` (needs Screen Recording permission).
3. Use the keyboard shortcuts with focus in the page and in the address bar; confirm Cmd+R and Cmd+W act on the tab, not the app.
4. Trackpad swipe and mouse back/forward buttons over the browser.
5. Sign in to Google in the workbench (Chrome-compatible user agent).
6. Run a task with `@Browser`: the browser opens, the "CoWork is using this tab" banner appears, clicking the page offers Take over, and Resume continues the task.
7. Let an agent navigate to a sign-in page; confirm the sign-in banner and that Done continues.
8. Annotate an area by dragging, and Adjust an element's text and font size; confirm the live preview, the sent changes and that the page is restored.
9. Settings > Browser: change the search engine, clear history, reset a site permission, toggle developer mode and confirm `browser_evaluate` asks for approval once per site.
10. Import cookies and saved logins from a real browser (approve the macOS key prompt), then fill one with Touch ID on its site; confirm it refuses on a look-alike address.
11. Call `browser_emulate` for desktop, tablet and mobile; confirm the size badge and screenshot dimensions.

Build checks:

```bash
npm run build:react
npm run build:electron
npm run type-check
npm run lint
npm run test
```
