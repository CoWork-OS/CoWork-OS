# Skills Runtime Model

CoWork OS now uses an additive skill model. Skills can still be selected proactively from the task text, but they no longer replace the task itself.

This redesign exists to enforce one core invariant:

- the original user task remains canonical for the full lifetime of the task
- skill content is attached as additive context and scoped runtime modifiers
- no skill is allowed to take over task definition or overwrite user intent

## Why This Changed

The old prompt-expansion model allowed a routed skill to behave like a synthetic task definition. That made it possible for the runtime to drift from the original request when a skill match was too broad or was triggered by pasted text, quoted examples, filenames, or documentation.

The new model separates three concerns that were previously overloaded into one field:

- **task definition**: the canonical user request
- **skill context**: extra instructions that help execute part of the task
- **runtime directives**: scoped execution modifiers such as tool allowlists, restrictions, model hints, and artifact directories

## Canonical Task Invariant

The canonical prompt is resolved in one order everywhere:

1. `rawPrompt`
2. `userPrompt`
3. `prompt`

For newly created tasks, the repository normalizes these fields so `rawPrompt` is always present. If a caller only provides `prompt`, CoWork persists that value into `rawPrompt` and safely defaults `userPrompt` as well.

This matters because the executor, planner, safety checks, and UI now all read the same canonical task text instead of mixing decorated prompt variants.

### What Each Field Means

- `rawPrompt`: the canonical task text used for intent and routing
- `userPrompt`: a user-facing prompt variant when one exists
- `prompt`: a compatibility field for legacy callers or non-skill prompt decoration

For legacy rows that predate the normalization change, the runtime uses the same fallback order without trying to rewrite stored history.

## Additive Skill Application

At runtime, the executor now tracks applied skills explicitly in memory:

- `appliedSkills: SkillApplication[]`

Each `SkillApplication` records:

- `skillId`
- `skillName`
- `trigger`
- `parameters`
- `content`
- `reason`
- `appliedAt`
- optional `contextDirectives`

Supported triggers are:

- `slash`
- `planner`
- `model`
- `explicit_hint`

The executor builds the working task context from:

1. the canonical task prompt
2. runtime task notes
3. additive applied-skill context

It does **not** build execution context by mutating `task.prompt` into a skill-expanded prompt.

### Context Directives

Skills can attach scoped runtime directives, but only additive ones:

- `allowedTools`
- `toolRestrictions`
- `modelHint`
- `artifactDirectories`
- `metadata`

These directives can narrow or guide execution. They cannot redefine the task. There is no runtime field for "replace the task prompt" semantics.

Example:

- `manim-video` can add artifact expectations and project-scaffolding context for a local Manim workspace, but it still does not replace the user's original animation request.

### Reuse Guard

If the same skill is already applied with the same parameters, the executor does not reapply it. Instead it emits a reuse event so repeated planner/model invocations do not keep stacking identical skill context.

## `use_skill` Tool Contract

`use_skill` now returns structured additive output instead of a rewritten task definition.

Primary fields:

- `success`
- `skill_id`
- `skill_name`
- `skill_description`
- `content`
- `context_messages`
- `context_directives`
- `application_summary`
- `skill_application`

Compatibility field:

- `expanded_prompt`

`expanded_prompt` is still returned for one migration pass, but the executor no longer consumes it as task text. The important field is `skill_application`, which the executor turns into an entry in `appliedSkills`.

### Execution Semantics

When `use_skill` succeeds:

- the executor records a structured `SkillApplication`
- additive skill context is appended to the execution prompt stack
- tool restrictions or allowlists from `context_directives` are merged into runtime state
- the original task text remains unchanged

When `use_skill` fails:

- the runtime returns a structured reason such as missing prerequisites, blocked policy, missing tools, missing parameters, or manual-only/auto-only constraints

## Routing Model

Natural-language skill routing is still proactive, but it is now shortlist-based instead of executor-side prompt replacement.

### What Still Happens Automatically

- CoWork ranks relevant skills for the canonical task intent
- the planner sees concise relevant-skill hints
- the model can decide to call `use_skill`
- explicit mentions like "use the frontend skill" can boost or pin a skill in that shortlist

### What No Longer Happens

- the executor does not auto-expand a matched skill into the task prompt
- natural-language matching does not deterministically call `use_skill` and overwrite task text
- skill content is not treated as a new task definition

### Manual vs Auto-Routable Skills

- slash-invoked skills are deterministic and immediate
- natural-language routing only considers model-invocable skills
- skills without routing metadata are manual-only for auto-routing purposes

This keeps proactive discovery without letting vague matches hijack the task.

## Routing Input Hygiene

Routing and gating now evaluate canonical user intent, not arbitrary text that happened to appear in the prompt or context.

The routing query is sanitized to avoid false positives from:

- quoted text
- pasted docs
- code fences
- URLs
- filenames and path fragments
- previously loaded skill content
- broad examples that mention a skill name incidentally

The same principle applies after a skill is loaded: skill-expanded content should not recursively trigger more skill discovery as if it were fresh user intent.

## Slash Commands

Slash commands remain deterministic. `/simplify`, `/batch`, and `/llm-wiki` still map directly to `use_skill`, but the result is now applied additively.

That means:

- the slash command immediately applies the mapped skill
- the skill can add context and runtime directives
- the task stays anchored to the same canonical user request

Slash behavior is special only in how the skill is selected, not in how the task is redefined.

## Planner and Execution Alignment

The planner, preflight framing, and step execution now consume the same canonical task prompt and the same applied-skill list. This prevents drift between:

- what the user asked
- what the planner thinks the task is
- what the executor actually runs
- what the UI displays back to the user

Planning guidance now frames skills as optional or strong helpers. A plan may include a step such as:

- "Apply the X skill to handle Y part of the task."

It should not phrase the skill as a replacement task.

## UI Behavior

The UI now shows the original task request from canonical prompt fields, not a skill-expanded synthetic prompt.

Task detail surfaces include:

- the original request in the header and user bubble
- a separate **Applied skills** surface
- skill chips that show the applied skill name
- tooltips with trigger and reason when available

This makes it obvious that the task remained the same and that a skill was layered on top of it.

## Observability

The runtime now emits structured skill events instead of silently changing prompt text.

Important events:

- `skill_candidates_ranked`
- `skill_applied`
- `skill_application_reused`
- `skill_application_blocked`

These events exist to answer two operator questions:

- why did CoWork think a skill was relevant?
- what skill context was actually applied to the task?

They intentionally avoid inventing a second synthetic "task definition" in logs.

## External and Installed Skills

Bundled skills, managed installs, ClawHub imports, Git-based installs, and read-only external skill directories all follow the same runtime model after loading:

- they may be shortlisted
- they may be invoked with `use_skill`
- they may add additive context and scoped directives
- they may not replace the canonical task

The additive contract is runtime-wide, not limited to bundled skills.

## Migration Notes

- `expanded_prompt` remains as a deprecated compatibility output for now
- new executor/runtime code should consume structured additive fields instead
- legacy tasks without `rawPrompt` still work through fallback resolution
- no destructive backfill migration is required for older rows

## Implementation Landmarks

Key files for this model:

- `src/shared/types.ts`
- `src/electron/agent/executor.ts`
- `src/electron/agent/tools/registry.ts`
- `src/electron/agent/custom-skill-loader.ts`
- `src/electron/database/repositories.ts`
- `src/electron/control-plane/handlers.ts`
- `src/renderer/components/MainContent.tsx`
- `src/renderer/App.tsx`

If the skill system changes again, update this document in the same PR.
