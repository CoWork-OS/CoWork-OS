# Keyboard shortcuts

Press **Cmd+/** (macOS) or **Ctrl+/** (Windows, Linux, and the app in a browser) to see every shortcut in a searchable list. The list opens in the [command menu](command-menu.md) on its **Shortcuts** tab; type to filter by name, by where it works ("browser", "inbox") or by key. Rows that run something, such as **Next session that needs you**, run it on Enter; the others are for reference.

## Moving between sessions

| Shortcut | macOS | Windows / Linux |
|---|---|---|
| Open session 1–9 in the sidebar list | Ctrl+1 … Ctrl+9 | Alt+1 … Alt+9 |
| Next session that needs you | Cmd+Shift+U | Ctrl+Shift+U |
| Open sidebar destination 1–9 (Home, Inbox …) | Cmd+1 … Cmd+9 | Ctrl+1 … Ctrl+9 |
| Command menu | Cmd+K | Ctrl+K |

- **Session 1–9** counts the sessions in the sidebar's session list from the top, as they are shown: pinned sessions first, then projects and days. Sessions inside a collapsed group, sub-agents and the **Automated sessions** drawer are not counted. Cmd/Ctrl+number stays with the rail; Option+number types characters on macOS, so sessions use Ctrl there.
- **Next session that needs you** opens the next session, in sidebar order, that waits on an approval or a question, or that finished while you were elsewhere and is still marked unread. It wraps to the top, and also reaches waiting sessions the sidebar is not showing. If nothing waits, a short notice says so.
- **Mark all sessions as read** (command menu action, no shortcut) clears the unread dot on every finished session. Sessions waiting on an approval or a question stay marked until you answer.

## Where the full list lives

The list in the app covers shortcuts for the app window, the composer, question cards, the built-in browser, the Inbox, the video player, the image viewer, presentations and the Live Canvas preview. Details for some of them:

- Built-in browser: [Browser workbench](browser-workbench.md)
- Live Canvas preview: [Live Canvas](live-canvas.md)
- Command menu keys: [Command menu](command-menu.md)

**Cmd+N** (new session) and **Cmd+,** (Settings) come from the macOS app menu and are listed on macOS only.

## Limits

- Shortcuts cannot be changed yet.
- None of these reach the app while the keyboard focus is inside a page in the built-in browser; that page's own browser shortcuts apply there.
- In the app served in a browser, the browser may keep some chords for itself (for example Alt+1–8 switches tabs in Chrome on Linux).
- While a dialog is open, only Cmd/Ctrl+K and Cmd/Ctrl+/ work, and only to switch the command menu.

## For developers

- `src/renderer/components/CommandMenu/keyboard-shortcuts.ts` holds the list and the chord checks. The list describes shortcuts handled elsewhere (App.tsx, SidebarRail.tsx, the composer, the browser, the app menu), so change it together with a handler.
- `src/renderer/utils/session-navigation.ts` picks the next waiting session and the session at a position. The sidebar reports its session order through `onSessionOrderChange`, so long lists that draw only the visible rows still count correctly.

```bash
npx vitest run src/renderer/components/CommandMenu src/renderer/utils/__tests__/session-navigation.test.ts
```
