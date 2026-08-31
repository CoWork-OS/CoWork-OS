# Universal `/simplify` and `/batch`

CoWork OS now ships two bundled, global skills as first-class slash commands:

- `/simplify` for targeted quality improvements
- `/batch` for parallelizable, repeatable migrations/transformations

These are domain-agnostic and work across code, research, writing, operations, and general tasks.

Both skills run inside the task's [access profile](access-profiles.md). A
quality pass or batch transformation can propose or perform only the reads,
writes, command-tool calls, network requests, and exports already allowed by
that profile; parallelization does not widen access.

## Global Skill Scope

Both skills are bundled and enabled by default:

- `resources/skills/simplify.json`
- `resources/skills/batch.json`

They are also published in registry artifacts:

- `registry/skills/simplify.json`
- `registry/skills/batch.json`

Legacy skills remain active. In particular, `usecase-dev-task-queue` is not deprecated and cross-links to `/batch` for broad migration-style requests.

## Command Syntax

### `/simplify`

```text
/simplify [objective] [--domain <auto|code|research|operations|writing|general>] [--scope <current|workspace|path>]
```

Behavior:

- Objective is optional; when omitted, current task context is used.
- Explicit invocation only (no automatic post-task simplify).

### `/batch`

```text
/batch <objective> [--parallel <1-8>] [--domain <auto|code|research|operations|writing|general>] [--external <confirm|execute|none>]
```

Behavior:

- Objective is required.
- Parallelism is bounded to `1..8`.
- Default external policy is `confirm`.
- Code-domain default stop point remains branch/worktree + validated summary (no auto-PR unless explicitly requested).

## Desktop and Gateway Behavior

- Supported in desktop and gateway channels.
- Gateway routes `/simplify` and `/batch` through the shared remote command registry, then into task execution as normalized slash command text.
- Invalid command shapes return usage/help text in-channel.
- Help text across channel variants includes both commands.
- Recognized gateway slash commands are never queued or forwarded as ordinary task follow-up text.

## Inline Chaining

You can chain command execution in one message:

```text
Refactor this module then run /simplify
Migrate these docs then run /batch --domain writing --parallel 4
```

Execution order:

1. Run base objective first.
2. Run the mapped slash-skill workflow in the same task context.

Parser constraints:

- Ignores URL/path false positives (e.g. `https://.../batch`, `/batch/migrations`).
- Accepts punctuation terminators (e.g. `/simplify.`).
- Allows one inline chain per message; multiple `then run /...` chains are rejected with explicit guidance.

## Deterministic Skill Invocation

For recognized `/simplify` and `/batch` commands, executor behavior is deterministic:

- Calls `use_skill` directly with `skill_id` and parsed parameters.
- Applies the returned skill as additive context for the existing task.
- Merges any scoped runtime directives from the skill into executor state.
- Preserves the canonical task prompt for planning, execution, safety checks, and UI display.

This avoids best-effort routing ambiguity for these two commands without letting the slash skill redefine the task.

## `/batch` External Effects Policy

Policy modes:

- `confirm`: require explicit user approval before first external side-effect action in the run.
- `execute`: allow external side-effect actions under existing tool policies.
- `none`: block known external side-effect actions for the run.

Implementation details:

- `confirm` approval is requested with `allowAutoApprove: false`.
- `none` applies task-level tool restrictions for external side-effect tools.
- Read-only external actions are allowed under `none` (write-like external actions are blocked).

## Composer UX

Desktop composer slash autocomplete remains discoverable, but Enter/Tab no longer auto-selects dropdown entries when the user typed an exact `/simplify...` or `/batch...` command. This ensures command pass-through to executor.

## WhatsApp Natural Mapping

Common WhatsApp phrases map to slash commands:

- `simplify this`, `run simplify ...` -> `/simplify ...`
- `batch migrate ...`, `run batch ...` -> `/batch ...`

See [Gateway Message Lifecycle](gateway-message-lifecycle.md) for active-task handling, unknown slash command behavior, and direct `/<skill-slug> args` invocation from gateway channels.

## Validation and Tests

Recommended checks for this feature area:

```bash
npm run skills:validate-routing
npm run skills:validate-content
npm run skills:audit
npx vitest run src/shared/__tests__/skill-slash-commands.test.ts src/electron/agent/__tests__/executor-schedule-slash.test.ts src/electron/gateway/__tests__/whatsapp-command-utils.test.ts
```
