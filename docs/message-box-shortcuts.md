# Message Box Shortcuts

Message box shortcuts are slash-searchable commands in the main composer. They share one picker with skill-backed workflow shortcuts so users can discover app actions and reusable workflows from the same `/` menu.

This page documents the current concept, runtime behavior, authoring model, and implementation contract.

## Concept

There are two shortcut families:

| Family | Source | What it does |
|--------|--------|--------------|
| **App commands** | Shared deterministic catalog in the app | Runs a fixed UI/app behavior or starts a safe built-in workflow |
| **Workflow shortcuts** | Skills and plugin-pack `slashCommands` | Invokes a skill through the existing skills runtime |

The picker merges these sources in this order:

1. App commands
2. Built-in onboarding commands
3. Plugin-pack slash command aliases
4. Enabled task skills with valid slash-safe IDs

Visible command names are always valid slash tokens such as `/batch-rename`, not skill display names with spaces.

## App Commands

The built-in app command catalog is:

| Command | Behavior |
|---------|----------|
| `/schedule ...` | Creates, lists, enables, disables, or deletes scheduled tasks through the deterministic schedule handler. It starts as a fresh task even when another task is selected so schedule handling keeps precedence. |
| `/clear` | Clears the current task/chat view without deleting history and without switching the current workspace. |
| `/plan <task>` | Creates a new task in Plan execution mode using `<task>` as the prompt. |
| `/cost <task>` | Creates an Analyze-mode estimate request for token usage, model cost, runtime, and risk without executing the requested task. |
| `/goal <objective>` | Starts a fresh persistent-goal task. The task stores the objective in its agent configuration, enables deep-work continuations, and keeps working until the goal is complete, blocked, paused, or cleared. |
| `/goal` | Reports the selected task's persistent-goal status. |
| `/goal pause` | Pauses the selected task's persistent goal. |
| `/goal resume` | Resumes the selected task's persistent goal and continues work from the current task state. |
| `/goal clear` | Clears the selected task's persistent goal metadata. |
| `/compact [context]` | Starts a safe continuation-brief workflow that summarizes context, decisions, open questions, constraints, and next actions. |
| `/doctor [context]` | Starts a diagnostic workflow for workspace/app state, integrations, permissions, skills, commands, and setup issues. It should not make changes unless explicitly asked. |
| `/undo [context]` | Starts a safe undo-planning workflow. It does not roll back, delete, or modify anything unless the user explicitly approves a follow-up action. |

`/clear` is intentionally view-only. It deselects the current task and clears visible events, but it does not delete task history or move the user into a new temporary workspace.

## Workflow Shortcuts

Workflow shortcuts are regular skills exposed through slash tokens.

They can come from:

- a skill ID such as `/llm-wiki`
- a plugin-pack alias from `slashCommands`, such as `/gmail-summary-drive`
- the bundled **CoWork Shortcuts** pack

When a plugin alias exists, the backend resolves the visible command token to the target `skillId`. Alias precedence matches the picker: if a plugin alias and a direct skill ID collide on the same visible token, the plugin alias wins when its target skill is enabled and available. If the alias target is missing or disabled, resolution falls back to the direct skill when one exists.

Unknown slash commands and invalid slash tokens are ignored by the generic skill resolver.

## Parameter Behavior

Selecting a skill-backed shortcut follows the same skill parameter rules everywhere:

- Skills with **required parameters** open the existing skill parameter modal.
- Skills with **optional parameters only** insert `/<alias> ` into the message box so the user can add context before sending.
- Skills with **no parameters** start a task immediately with `/<alias>`.
- Manually typing `/<alias> ...` works the same as selecting it from autocomplete and then sending.

This keeps skill authoring and enable/disable behavior inside the existing skills and plugin-pack system.

## CoWork Shortcuts Pack

CoWork OS ships a bundled **CoWork Shortcuts** plugin pack at:

```text
resources/plugin-packs/cowork-shortcuts/cowork.plugin.json
```

The manifest ID is `cowork-shortcuts-pack`.

The pack seeds general productivity workflow shortcuts as skills. They are not hard-coded app actions.

Core workflow shortcuts:

- `/strategy`
- `/review`
- `/memory`

File and workspace workflows:

- `/batch-rename`
- `/smart-deduplication`
- `/folder-structure`
- `/archive-stale-files`
- `/template-generator`
- `/recursive-search-extract`
- `/format-converter`
- `/size-audit`

Communication and calendar workflows:

- `/gmail-summary-drive`
- `/calendar-prep-brief`
- `/slack-action-items`
- `/email-chain-resolver`
- `/meeting-notes-distributor`
- `/daily-inbox-zero`
- `/monday-planning-brief`
- `/end-of-day-log`

Cross-source and document workflows:

- `/drive-analysis-slides`
- `/multi-source-report`
- `/cross-platform-search`
- `/voice-note-draft`
- `/meeting-recording-notes`
- `/research-executive-brief`
- `/proposal-customizer`
- `/contract-plain-english`
- `/spreadsheet-narrative`
- `/content-repurposing`
- `/weekly-newsletter`
- `/weekly-file-cleanup`
- `/monthly-financial-organizer`
- `/competitive-scan`

These shortcuts use optional `input` parameters so picker selection inserts the slash token and lets the user add context before launch.

## Enable, Disable, and Refresh

Shortcut availability follows existing skill and pack state:

- Disabling a plugin pack removes its aliases from the picker and backend resolution.
- Disabling an individual pack skill removes aliases targeting that skill.
- Disabled skills do not appear as direct skill commands.
- The picker refreshes after pack/skill toggles and on window focus.

Customize remains the authoring and enable/disable surface. There is no separate shortcut editor.

## Implementation Landmarks

| Area | Files |
|------|-------|
| App command catalog and parser | `src/shared/message-shortcuts.ts` |
| Renderer picker option builder | `src/renderer/utils/message-slash-options.ts` |
| Main composer integration | `src/renderer/components/MainContent.tsx` |
| Safe `/clear` view handling | `src/renderer/App.tsx` |
| Plugin alias backend resolution | `src/electron/agent/skill-slash-aliases.ts` |
| Generic skill slash execution | `src/electron/agent/executor.ts` |
| Bundled shortcut pack | `resources/plugin-packs/cowork-shortcuts/cowork.plugin.json` |

## Focused Checks

Run the focused shortcut checks with:

```bash
npx vitest run \
  src/shared/__tests__/message-shortcuts.test.ts \
  src/shared/__tests__/skill-slash-commands.test.ts \
  src/electron/agent/__tests__/skill-slash-aliases.test.ts \
  src/electron/agent/__tests__/executor-schedule-slash.test.ts \
  src/renderer/utils/__tests__/message-slash-options.test.ts \
  src/renderer/components/__tests__/main-content-working-state.test.ts
```

For broader validation after shortcut changes, also run:

```bash
npm run type-check
npm run build:react
```
