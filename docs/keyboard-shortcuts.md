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

## Attaching the window you are looking at (macOS)

From any app, press **Cmd+Shift+2**. CoWork takes a picture of the window in front, comes forward, and attaches two files to the message box of the open session (or a new one):

- the picture of the window, and
- a short note with the app, the window title, the page address for Safari, Chrome, Edge, Brave and Arc, and the text read from the picture when Tesseract OCR is installed.

Nothing is sent to a model until you type your question and send. Remove either attachment first if you don't want it sent.

- The first capture asks for **Screen Recording** permission (System Settings > Privacy & Security > Screen & System Audio Recording). Without it, CoWork says so and attaches nothing.
- Pressing it while CoWork itself is in front attaches nothing; switch to the window first.
- Turn the shortcut off in **Settings > System & Security > Menu Bar > Capture the window in front with ⌘⇧2**. If another app already uses Cmd+Shift+2, CoWork can't register it.
- Windows and Linux don't have it yet.

## Sending while the agent works

While the agent is working, a message you send can go three ways:

- **Steer now**: the agent reads it at its next step, inside the run it is doing. This is what Enter does by default and what CoWork always did.
- **Send after this run**: it waits until the agent finishes, then starts a new turn with it. It shows under **Queued messages** marked **After this run**, and you can edit it there until it starts.
- **Run in the background**: a new session starts from this conversation (everything said so far) and works on the message while this session keeps going. You stay where you are; a notice names the new session and **Open** takes you there. It is listed in the sidebar like any session, titled after this one with **(background)**.

| | macOS | Windows / Linux |
|---|---|---|
| Send the default way | Enter | Enter |
| Send the other way | Cmd+Enter | Ctrl+Enter |
| Run in the background | Cmd+Shift+Enter | Ctrl+Shift+Enter |

Pick which one Enter does in **Settings > Appearance > Composer**. A hint under the message box says what each key does while the agent works. When the agent is idle both keys simply send.

Messages keep the order you sent them: anything you send after a message that waits for the run also waits behind it.

A background session works in the same workspace folder with the same access as this one, so the two can change the same files at once; give them separate work. It takes text only: send attachments in this session, or remove them first. Slash commands always run here.

In the app served in a browser, a message sent while the agent works always steers, and there is no background send.

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
