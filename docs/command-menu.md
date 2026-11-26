# Command menu

Press **Cmd+K** (macOS) or **Ctrl+K** (Windows, Linux, and the app in a browser) to open the command menu: one search box for getting around the app.

## What it searches

| Scope | What you get | Opens |
|---|---|---|
| Actions | New session, Open Settings, and "Go to" for every sidebar destination available to you | The action runs |
| Sessions | Sessions already loaded in the app, matched by title, prompt, result summary or ID | The session |
| Settings | Every Settings section, matched by its name and the same search terms the Settings search box uses | Settings on that section |
| Messages | Message text in the current workspace | The session the message is in |
| Shortcuts | Every keyboard shortcut, matched by name, where it works or its keys | Runs it, when the row is an action; otherwise reference only |

With nothing typed, the menu lists the actions and your most recently updated sessions. Type to search everything at once; the combined view shows a few rows per kind. The tabs at the bottom (**All**, **Actions**, **Sessions**, **Settings**, **Messages**, **Shortcuts**) narrow the search to one kind and show up to 50 rows (the whole list for Shortcuts). **Cmd/Ctrl+/** opens the menu straight on **Shortcuts**; see [Keyboard shortcuts](keyboard-shortcuts.md).

Actions include **Next session that needs you**, **Mark all sessions as read** and **Keyboard shortcuts**.

## Keys

- **Up / Down**: move the selection (it wraps).
- **Enter**: open the selected row.
- **Escape**, **Cmd/Ctrl+K** again, or a click outside: close.

## Limits

- Sessions are searched among those the app has loaded. Scroll the sidebar to load older ones, or use the Messages scope, which searches stored message text.
- Message search needs an open workspace and at least 3 characters, and covers that workspace only.
- Files are not searched.
- The shortcut does not reach the menu while the keyboard focus is inside a page in the built-in browser, or while another dialog is open.
- Cmd/Ctrl+K used to focus the sidebar session search. That field is still in the sidebar.

## For developers

- `src/renderer/components/CommandMenu/command-menu-model.ts` holds the matching, ranking and section rules, with tests in `__tests__/command-menu-model.test.ts`.
- `CommandMenu.tsx` renders the overlay on `ModalDialog` (focus trap, Escape, focus restore). The Settings section list is imported from the Settings chunk when the menu opens.
- `App.tsx` owns the shortcut, the action list and what each row does. Message search uses the existing `queryUnifiedRecall` IPC with `sourceTypes: ["message", "conversation"]`.

```bash
npx vitest run src/renderer/components/CommandMenu
```
