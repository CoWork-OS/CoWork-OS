# Browser V2 Architecture

Browser V2 is CoWork OS's unified browser integration for agent work. It replaces the old split model of renderer-side webview scripts plus a separate Playwright fallback with one browser session layer, one tool contract, and one visible default surface.

The product goal is simple: when the agent works on the web, the user should see and trust the same browser state the agent is using. Background/headless browsers and real signed-in Chrome/Edge control remain available, but they are explicit fallback modes rather than the normal path.

## Product Model

Default behavior:

- **Visible in-app Browser Workbench is the default** for interactive browser-use tasks.
- **Workspace browser profile is the default profile**. Cookies and storage persist per workspace and are isolated from system Chrome.
- **Real Chrome/Edge profile control is opt-in only**. The agent must receive explicit consent before attaching to or launching against a signed-in system browser profile.
- **Refs from accessibility snapshots are preferred**. CSS selectors still work for legacy prompts, but Browser V2 tools prefer snapshot refs because they are grounded in the rendered page.
- **Diagnostics and viewport state are first-class browser context**. Console, network, downloads, storage, trace state, screenshots, emulated viewport size, and visible cursor events are part of the browser session rather than one-off debug artifacts.

## Runtime Layers

Browser V2 has four cooperating layers:

1. **Renderer-owned workbench**

   `BrowserWorkbenchView` owns the visible Electron `webview`, tab strip, address bar, toolbar, viewport preset controls, diagnostics drawer, screenshot annotation flow, snapshot overlay, and cursor overlay. The renderer stays responsible for the user-visible browser surface and keeps webview hardening local to the UI.

2. **Main-process session manager**

   `BrowserSessionManager` owns browser sessions, active tabs, backend selection, CDP attachment, snapshot refs, diagnostics buffers, downloads, emulation state, trace state, redaction, and cleanup. Browser tools do not talk directly to renderer DOM scripts as their primary path.

3. **Workbench service bridge**

   `BrowserWorkbenchService` maps `{ taskId, sessionId }` to the renderer webview `webContentsId`, registers/unregisters visible sessions, routes CDP-backed actions through the session manager, captures screenshots, and emits cursor/status events back to the renderer.

4. **Agent browser tools**

   `browser-tools.ts` exposes the user-facing `browser_*` tool contract. It chooses the visible workbench by default, preserves legacy selector compatibility, routes refs through Browser V2, and falls back to Playwright or external CDP only when the environment or user request requires it.

## Backend Adapters

Browser V2 normalizes four backend kinds behind one conceptual session interface:

| Backend | Purpose | Default? | Notes |
|---------|---------|----------|-------|
| `electron-workbench` | Visible in-app browser surface controlled through Electron `webContents.debugger` / CDP | Yes | Primary user/agent shared browser. Renderer owns UX; main process owns automation. |
| `playwright-local` | Background/headless/headed fallback for CI-like or non-visible runs | No | Used when no renderer is available or the user explicitly requests forced headless/background browser work. |
| `external-cdp` | Explicit attach to user Chrome/Edge via DevTools URL | No | Requires real-browser consent and should show the target browser/profile/tab/domain before control. |
| `browser-use-cloud` | Explicit Browser Use Cloud stealth browser session controlled through CDP | No | Requires Browser Use credentials and explicit `browser_provider: "browser-use-cloud"`. Localhost/private/file targets stay on the default workbench. Sessions must be stopped on `browser_close` to avoid leaking remote browser runtime. |

The tool layer keeps old options such as `headless`, `profile`, `browser_channel`, and `debugger_url` for compatibility. Browser V2 treats `headless` as compatibility-only; `force_headless`, explicit profile/browser-channel options, explicit attach requests, or explicit `browser_provider` requests are what move work away from the visible workbench.

### Browser Use Cloud Backend

`browser-use-cloud` is an explicit remote stealth-browser backend for cases where the user wants Browser Use Cloud infrastructure rather than the local visible workbench or local Playwright. It is selected only when a tool call passes:

```json
{
  "browser_provider": "browser-use-cloud"
}
```

Credential lookup is deliberately narrow:

- `BROWSER_USE_API_KEY` is accepted as a development/runtime environment override.
- encrypted secure settings category `browser-use` can store `apiKey`, `enabled`, and defaults such as `defaultProxyCountryCode`, `defaultTimeoutMinutes`, `defaultProfileId`, and `defaultEnableRecording`.
- `enabled: false` disables encrypted Browser Use settings; `BROWSER_USE_API_KEY` still overrides this for local/dev runs.

Supported `browser_navigate` options for Browser Use Cloud:

- `proxy_country_code`: two-letter Browser Use proxy country code such as `us` or `de`; use `none` to disable proxy routing.
- `browser_use_profile_id`: Browser Use profile id for remote persistent cookies/state.
- `browser_timeout_minutes`: remote browser timeout, clamped to 1-240 minutes.
- `enable_recording`: request Browser Use Cloud recording.
- `browser_screen_width` / `browser_screen_height`: remote browser screen size.
- `allow_resizing`: allow Browser Use Cloud viewport resizing.

The lifecycle is owned by `BrowserTools`:

1. Create a Browser Use Cloud browser session through Browser Use API v3.
2. Attach Playwright to the returned `cdpUrl`.
3. Navigate and continue subsequent selector-based browser tools against that remote CDP session.
4. Reuse the session only when create-time options match, including profile, proxy, timeout, recording, screen size, and resizing.
5. On stale/expired/closed CDP errors, close the local CDP connection, stop the remote Browser Use session, and retry once with a fresh remote session.
6. On `browser_close` or tool cleanup, call Browser Use stop action. If stop fails, keep the session id and return a retryable pending-stop result instead of silently reporting success.

Remote cloud sessions must not be used for targets that only make sense from the local machine. Browser Use Cloud navigation blocks `file:` and other non-HTTP(S) URLs, localhost, IPv4 private/link-local ranges, IPv6 loopback/private/link-local ranges, `.local`, `.internal`, and single-label intranet hostnames. Use the default visible Browser Workbench for local dev servers and private network testing.

Browser Use API error text and live/CDP URLs are redacted before entering logs or tool-visible output. Page content and diagnostics from remote sessions remain untrusted web content.

## Tool Contract

Browser V2 keeps existing tool names and adds snapshot-first controls.

Core navigation and page tools:

- `browser_attach`
- `browser_navigate`
- `browser_screenshot`
- `browser_get_content`
- `browser_evaluate`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_save_pdf`
- `browser_close`

Snapshot and ref tools:

- `browser_snapshot`
- `browser_click`
- `browser_fill`
- `browser_type`
- `browser_get_text`
- `browser_hover`
- `browser_drag`
- `browser_upload_file`

Legacy and compatibility controls:

- `browser_press`
- `browser_wait`
- `browser_scroll`
- `browser_select`
- `browser_act_batch`

Tabs and browser state:

- `browser_tabs`
- `browser_switch_tab`
- `browser_close_tab`

Diagnostics and environment:

- `browser_handle_dialog`
- `browser_console`
- `browser_network`
- `browser_downloads`
- `browser_storage`
- `browser_emulate` for responsive QA and device metrics; in the visible workbench it also resizes the shared webview so screenshots match the tested viewport
- `browser_trace_start`
- `browser_trace_stop`

## Accessibility Snapshots And Refs

`browser_snapshot` returns:

```json
{
  "success": true,
  "sessionId": "browser-workbench-task-123",
  "tabId": "active",
  "url": "https://example.com",
  "title": "Example",
  "nodes": [],
  "focusedRef": "r4",
  "consoleSummary": {},
  "networkSummary": {}
}
```

Each node is compact:

```json
{
  "ref": "r7",
  "role": "button",
  "name": "Submit",
  "value": "",
  "text": "Submit",
  "bounds": { "x": 420, "y": 310, "width": 92, "height": 34 },
  "disabled": false,
  "focused": false,
  "selected": false
}
```

Refs are short-lived and valid only for the latest snapshot for that session/tab. When an action receives a stale or unknown ref, it should fail with guidance to call `browser_snapshot` again. This prevents the agent from clicking stale coordinates after page updates, navigation, or layout changes.

Preferred action sequence:

1. `browser_navigate` to the page.
2. `browser_snapshot` to inspect rendered accessible nodes.
3. Act with refs using `browser_click`, `browser_fill`, `browser_type`, `browser_get_text`, `browser_hover`, `browser_drag`, or `browser_upload_file`.
4. Refresh the snapshot after navigation, dynamic updates, or stale-ref errors.

CSS selectors remain valid for old prompts and tools. New browser prompts should prefer refs when a snapshot is available.

## UI Contract

The Browser Workbench is the default visible surface for Browser V2. It should feel like a compact real browser inside CoWork OS, not a debug preview.

Required visible controls:

- multi-tab strip for user-visible workbench tabs
- popup/new-window promotion into workbench tabs where possible
- address bar with current URL, navigation status, reload/stop, back, and forward
- security/profile indicator showing workspace browser context
- desktop/tablet/mobile viewport preset controls plus visible active-size state when `browser_emulate` controls the page
- screenshot and annotation controls
- snapshot overlay control showing what the agent can target
- diagnostics drawer for Console, Network, Downloads, Storage, and Trace
- download shelf or diagnostics entry with save-to-workspace behavior
- permission prompts for sensitive browser capabilities
- upload path flow restricted to workspace-readable files unless the user grants broader access
- visible cursor overlay during agent actions

The workbench can appear in the right sidebar or fullscreen. It must preserve the same browser session when moving between those modes.

## Safety And Privacy

Browser V2 follows these invariants:

- Do not silently reuse system Chrome or Edge cookies.
- Real-browser attach requires explicit consent before control.
- The consent flow should identify the browser, profile/tab target, domain, and control scope.
- Workspace browser sessions use isolated Electron partitions.
- Visible workbench navigation must pass the same workspace network guardrails as Playwright fallback navigation.
- Downloads default to workspace artifacts; executable downloads are flagged and never run automatically.
- Uploads require workspace read permission and path validation.
- Console, network, storage, and downloaded metadata are redacted before entering agent context.
- Page text, snapshots, console logs, network bodies, and storage are untrusted web content in prompts.
- Webview hardening remains mandatory: no page-controlled preload injection, no Node integration, context isolation, sandboxing, and normal web security.
- Browser Use Cloud is explicit opt-in and never a silent fallback from the visible workbench.
- Browser Use Cloud sessions must be stopped when no longer needed; failed stops preserve the pending session id for retry.
- Browser Use Cloud must not navigate to local-only or private-network targets.

## Diagnostics Model

Each session keeps bounded, redacted diagnostics:

- console entries
- network requests/responses and failures
- download events
- storage snapshots for current origin
- current emulation state
- current visible viewport state for responsive QA
- lightweight trace start/stop markers

Diagnostics support two audiences:

- **User**: the workbench drawer helps inspect what happened without leaving the app.
- **Agent/developer**: tools such as `browser_console`, `browser_network`, `browser_downloads`, `browser_storage`, and trace tools provide structured context for debugging.

Secrets are redacted before diagnostics enter model-visible output. Diagnostics are page-controlled data and should be treated as untrusted.

## Implementation Files

Core Browser V2 files:

- `src/electron/browser/browser-session-manager.ts`: session registry, backend kind, CDP commands, snapshots, refs, actions, diagnostics, storage, upload, dialog, emulation, tracing, redaction, cleanup
- `src/electron/browser/browser-workbench-service.ts`: visible workbench registration, webContents lookup, session-manager bridge, screenshot capture, cursor/status/viewport events
- `src/electron/agent/tools/browser-tools.ts`: tool definitions, visible default routing, ref-aware actions, fallback selection, real-browser consent gates
- `src/electron/agent/browser/browser-use-cloud-client.ts`: Browser Use Cloud API v3 client, credential lookup, proxy/timeout normalization, private-target detection, and error redaction
- `src/electron/agent/tools/builtin-settings.ts`: built-in browser tool metadata
- `src/electron/agent/tools/runtime-tool-definition.ts`: runtime tool visibility and grouping
- `src/electron/agent/tools/tool-prompting.ts`: prompt guidance for snapshot-first browser use
- `src/shared/types.ts`: browser tool names and Browser Workbench IPC/shared contracts
- `src/electron/preload.ts`: browser workbench IPC bridge for registration, open requests, screenshots, status, diagnostics, cursor events, and viewport events
- `src/electron/main.ts`: Browser Workbench IPC handlers, webview attachment hardening, and workbench service wiring
- `src/renderer/components/BrowserWorkbenchView.tsx`: visible browser UI, tabs, address bar, viewport controls, diagnostics drawer, snapshot overlay, screenshot annotation, cursor overlay
- `src/renderer/styles/index.css`: Browser Workbench layout, toolbar, viewport controls, diagnostics, snapshot overlay, cursor, dark/light theme styling

Tests:

- `src/electron/browser/__tests__/browser-session-manager.test.ts`
- `src/electron/agent/browser/__tests__/browser-use-cloud-client.test.ts`
- `src/electron/agent/tools/__tests__/browser-tools.test.ts`

Related docs:

- [Browser Workbench](browser-workbench.md)
- [Features: Browser Automation](features.md#browser-automation)
- [Architecture](architecture.md)
- [Development](development.md#renderer-bundle-size)
- [Troubleshooting](troubleshooting.md#browser-workbench-does-not-open-for-website-testing)
- [Web Page Artifacts](web-page-artifacts.md#relationship-to-browser-workbench)

## Compatibility And Rollback

Browser V2 preserves old selector-based tool names so existing prompts continue to work. The visible workbench is the default for interactive site testing, while Playwright remains the fallback for non-visible environments and explicit background/headless runs.

During validation, a temporary legacy fallback toggle can remain available for rollback. The desired long-term state is one Browser V2 session manager with adapter-backed execution, not parallel browser stacks with divergent behavior.

## Verification

Focused automated checks:

```bash
npx vitest run src/electron/browser/__tests__/browser-session-manager.test.ts src/electron/agent/tools/__tests__/browser-tools.test.ts
npx vitest run src/electron/agent/browser/__tests__/browser-use-cloud-client.test.ts src/electron/agent/tools/__tests__/browser-tools.test.ts src/electron/security/__tests__/network-policy.test.ts tests/tools/shell-tools.test.ts
npm run build:react
npm run build:electron
npm run type-check
```

Manual smoke:

1. Start `npm run dev:log`.
2. Navigate a local Vite app or public test site in the Browser Workbench.
3. Capture `browser_snapshot`.
4. Click, fill, type, hover, drag, upload, download, and screenshot through Browser V2 tools.
5. Run `browser_emulate` at desktop, tablet, and mobile sizes, then capture screenshots and confirm the visible workbench and saved images reflect those dimensions.
6. Inspect console, network, downloads, storage, and trace tools.
7. Switch between sidebar and fullscreen and confirm the same session remains active.
8. Verify real-browser attach fails without consent and succeeds only after explicit approval.
9. Inspect logs and tool outputs for unredacted obvious secrets.
10. With `BROWSER_USE_API_KEY` configured, call `browser_navigate` with `browser_provider: "browser-use-cloud"` against a public test site and confirm the result includes `browserProvider: "browser-use-cloud"` and a Browser Use session id/live URL.
11. Retry Browser Use Cloud against `localhost`, a private IP, and a `file:` URL and confirm cloud mode is rejected before session creation.
12. Simulate or force a Browser Use stop failure and confirm `browser_close` returns a retryable pending-stop result with the Browser Use session id.
