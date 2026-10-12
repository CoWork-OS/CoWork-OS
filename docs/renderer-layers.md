# Renderer overlay layers

Global layer tokens live in `src/renderer/styles/index.css`. Use them for fixed overlays and body portals. Small integers remain appropriate for ordering children inside a component's stacking context.

| Token | Value | Use |
| --- | ---: | --- |
| `--layer-shell` | 100 | Title bar |
| `--layer-popover` | 1000 | Menus, notification panel, floating workspace picker |
| `--layer-modal` | 2000 | Settings, connector, skill, Inbox and standard dialogs |
| `--layer-modal-raised` | 2100 | File viewer, remote picker, device drawer, session approval |
| `--layer-modal-warning` | 2200 | Approval warnings and full-access confirmation |
| `--layer-lightbox` | 2300 | Image viewer above file dialogs |
| `--layer-onboarding` | 2400 | First-run screens |
| `--layer-toast` | 2500 | Transient feedback |
| `--layer-system-notice` | 2600 | Browser-host update notice |

A token only orders siblings in the same stacking context. An overlay inside a transformed or isolated ancestor cannot escape that ancestor by increasing its z-index. Portal overlays to the body when they must cover the app. Popovers inside a modal can use the popover token within the modal's own context; a body-portaled popover owned by a modal needs an explicit modal-relative layer.

Use `ModalDialog` for modal containers: it supplies dialog semantics, focus containment, Escape dismissal and focus restoration. Give each instance an accessible label or a labelled heading. Only the top registered dialog handles keyboard dismissal; closing it restores focus to its parent dialog or its connected opener.

Use `usePositionUpdates` for active anchor/panel measurements. It coalesces resize, scroll and ResizeObserver callbacks into one animation frame and removes its listeners when closed. `getFloatingPosition` clamps body-portaled artifact menus and the sidebar notification panel to the viewport, including narrow and short windows.

## Regression checks

Run `node scripts/qa/renderer_ui_audit.mjs` from the repository root to exercise the production components in an isolated Electron window. Vite binds explicitly to `127.0.0.1` on an ephemeral port. The harness uses fixture API responses, never connects a real mailbox, and removes its disposable Electron profile and test server on exit. Screenshots and JSON evidence go to ignored `logs/renderer-ui-audit*` files.

For the full-app Calm homepage check, build Electron first with `npm run build:electron`, then run `node scripts/qa/renderer_ui_audit.mjs --app-smoke`. This additionally starts the actual desktop entrypoint with the same disposable profile and real preload; it does not replace a test against a configured account or a packaged release.

The harness covers delayed thread and filter responses, unmount during initialization, local composer send/forward fields, nested dialog/lightbox focus, menu navigation, import/registry/scheduled-job keyboard activation, and artifact placement at normal and short window sizes.

Unit checks: `npx vitest run src/renderer`. An opt-in comparator timing sample can be recorded with `COWORK_UI_PROFILE=after npx vitest run src/renderer/components/__tests__/sidebar-comparator.test.ts`. It writes `logs/sidebar-comparator-after.json`; timing is diagnostic, with correctness enforced separately rather than a machine-dependent timing threshold.
