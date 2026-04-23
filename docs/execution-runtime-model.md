# Execution Runtime Model

This document describes the current execution concept for planning, step execution, follow-up turns, delegation, and verification guidance in CoWork OS.

The model is built around four rules:

- tool guidance should live with the tool definition instead of being duplicated across prompts
- prompt assembly should be sectioned, budgeted, and cache-aware
- delegated work should receive a structured brief instead of a raw prompt passthrough
- verification guidance should appear before finalization, not only after a post-hoc gate fires

## Tool Prompt Layer

Internal tool definitions now carry prompt-render metadata before provider serialization.

- `LLMTool` includes optional internal `prompting` metadata
- one shared render path produces both:
  - the final `description` sent to the active LLM provider
  - the compact tool text used in planning
- provider adapters still receive only:
  - `name`
  - rendered `description`
  - `input_schema`

### Render timing

Tool prompts are rendered only after:

- policy filtering
- mode filtering
- task allowlist and restriction filtering
- adaptive tool-availability filtering

This keeps hidden tools from consuming prompt budget.

### Render cache

`SessionRuntime.getAvailableTools()` caches the rendered visible tool set. The cache key includes:

- tool catalog version
- disabled, restricted, and allowlisted tool state
- execution mode
- task domain
- web-search mode
- shell availability
- agent type
- worker role
- user-input allowance
- visible tool names

That makes the rendered tool array stable for repeated turns while still invalidating when visibility or execution context changes.

### Prompt-aware rollout tools

The tool-prompt layer currently enriches the highest-impact tool families first:

- `spawn_agent`
- `orchestrate_agents`
- `run_command`
- `web_search`
- `web_fetch`
- browser navigation/content/text/screenshot tools
- `screen_context_resolve`
- `request_user_input`
- `task_list_create`
- `task_list_update`
- `create_diagram`
- `compile_latex`
- `qa_run`

Descriptions are intentionally capped so provider tool arrays do not grow without bound.

`screen_context_resolve` is the recent-screen context path for vague on-screen references. Its prompt guidance tells the model to try Chronicle's local recent-screen buffer before escalating to explicit screenshot requests or re-planning around missing context. Returned OCR or on-screen text is provenance-tagged as untrusted screen text, and tool visibility can still be suppressed by the dedicated built-in `chronicle` category or per-task `chronicleMode` controls.

`compile_latex` is the source-first PDF path for explicit LaTeX, TeX, TikZ, `.tex`, and "write a paper and compile PDF" requests. The executor guidance tells the model to write the `.tex` source with file tools first, then compile that source with `compile_latex`, instead of using the markdown/HTML-backed `generate_document` path.

## Provenance-Aware Tool Results

Execution is now provenance-aware as well as tool-aware.

- file and document reads can attach source provenance to the result
- imported files, drag-and-drop data, and channel attachments are treated as untrusted external content
- when those sources are read, the returned content is prefixed with an explicit banner telling the model to treat it as data, not instructions
- `SessionRuntime` keeps a rolling list of recent sensitive sources read during the task

That provenance is then reused by the approval layer:

- `http_request` can resolve to either `network_access` or `data_export` depending on request shape
- `analyze_image` and `read_pdf_visual` are modeled as `data_export`
- export-sensitive approval prompts can include the destination plus the direct source and recent-read security context

This preserves the existing rich read/search workflow while making outbound transfer decisions aware
of where the candidate content came from.

## Prompt Stack

Execution prompts are assembled from named sections instead of a single monolithic string.

The shared pieces are:

- `executor-prompt-sections.ts`
- `ContentBuilder`
- `QueryOrchestrator`

Planning, step execution, and follow-up turns all use the same section-composition primitives even when the section mix differs.

### Section scopes

Each section declares a cache scope:

- `session`: stable content that can be memoized across turns
- `turn`: dynamic content that is recomputed when inputs change

Examples of stable session-scoped sections:

- base identity
- shared safety core
- autonomy or input gate
- workspace/worktree context
- mode/domain contract
- web-search contract
- role context
- personality
- skill guidelines
- infra context
- visual QA context

Examples of turn-scoped sections:

- current time
- layered memory sections (`<cowork_hot_memory>`, `<cowork_structured_memory>`)
- turn guidance
- other step-specific or follow-up-specific context

Recent transcript/session recall, verbatim quote recall, and topical memory packs are not injected by default. They stay tool-driven through `search_sessions`, `search_quotes`, `search_memories`, and `memory_topics_load`, so follow-up turns only pay that prompt cost when the agent explicitly asks for it.

### Retry-aware recovery guidance

Planning, execution, and follow-up turns can also receive an adaptive recovery block when the runtime is retrying or resuming meaningful unfinished work.

That block is injected only when one of these is true:

- transient retry count is non-zero
- the task is on attempt `> 1`
- a retry reason or recovery classification is available
- verification checklist items are still pending

The guidance tells the agent to continue from the last known good state, avoid repeating failed approaches blindly, and preserve unfinished verification work. It can include:

- transient retry count and current attempt
- last retry reason
- last recovery classification
- pending verification checklist titles
- recent session/checkpoint snippets returned by `SessionRecallService.search(...)`

Planning retries may also append a compact playbook context. Execution and follow-up turns skip that playbook add-on to avoid duplicating memory already supplied by the layered memory runtime.

### Provider-aware prompt caching

The section scopes now also drive provider-side prompt caching.

- session-scoped cacheable sections become the stable prefix
- turn-scoped sections stay outside the cacheable prefix
- stable-prefix hashes include provider family, execution mode, task domain, stable system blocks, and rendered tool schema

Current provider strategy:

- **Anthropic / Azure Anthropic / Anthropic-compatible**: prefer Anthropic automatic caching with structured `systemBlocks`
- **OpenRouter Claude**: use explicit `system + last 3 non-system messages`, capped at 4 breakpoints
- **OpenAI / Azure OpenAI**: derive deterministic prompt-cache keys from the stable prefix so GPT routes can reuse cached prefixes across follow-ups and profile-based routing
- **OpenRouter GPT-style routes**: keep the same stable-prefix partitioning and cache epoch tracking without Anthropic markers

This is why dynamic sections such as current time, layered memory sections, and turn guidance are intentionally kept out of the stable prefix. Explicit `L2/L3` recall stays outside the prefix until a tool call pulls it in for the current turn.

### Section budgeting

Budgets are enforced per section rather than after building one giant prompt.

- each section can be truncated independently
- optional sections can be dropped by priority
- execution logs report which sections were truncated or dropped

This keeps failures interpretable when token pressure rises.

## Turn Budget Model

CoWork now follows a Claude-style turn-budget model for main tasks.

- ordinary interactive desktop tasks do not receive an implicit strategy-derived `maxTurns`
- `maxTurns` and `windowTurnCap` are explicit-only controls
- `turnBudgetPolicy` only matters when an explicit window cap exists
- helper contexts can still use deliberate caps, such as sub-agents, verification helpers, and managed-session templates

This means the runtime now separates two safety layers:

- **window caps**: optional, explicit, and intended for bounded helper or unattended runs
- **runaway protection**: always-on lifetime caps, emergency fuses, loop detection, mutation checkpoints, and recovery policies

When no explicit window cap exists:

- the runtime does not throw `Global turn limit exceeded: X/X`
- it does not emit window-exhaustion events for an implicit cap
- it continues until the task completes, hits a real blocker, or trips a lifetime/emergency safety policy

When an explicit cap exists:

- `hard_window` still stops at the configured turn count
- `adaptive_unbounded` still soft-lands and can recover bounded follow-up turns before escalating to a safety stop
- task telemetry records whether the cap came from explicit config, a managed template, or an internal helper flow

## Output Budget Policy

When `COWORK_LLM_OUTPUT_POLICY=adaptive` is enabled, execution turns use a centralized output-budget resolver instead of depending on scattered per-provider defaults.

### Shared policy path

The active execution path resolves output limits from:

- provider family
- model id
- request kind
- explicit task-level `maxTokens`, when present
- global env overrides
- known adapter hard caps where available
- context headroom

This logic is shared across step execution and follow-up loops so they do not drift.

Selection precedence is:

1. task-level `agentConfig.maxTokens`
2. `COWORK_LLM_MAX_OUTPUT_TOKENS`
3. adaptive family defaults
4. final clamping by known hard caps and context headroom

### Request kinds

The policy distinguishes:

- `agentic_main`
- `tool_followup`
- `continuation`

That lets the runtime start conservatively on the first turn, then reserve more output room after tool results are present.

### Default behavior

Current internal defaults:

- main execution turn: `8000`
- tool follow-up turn: `16000`
- escalated retry: `48000`
- escalated retry for Anthropic-family routes: `64000`
- generic fallback escalation: `16000`

The runtime still clamps these values against context headroom and known provider limits before the request is sent.

### Provider-aware transport mapping

The output-budget resolver also decides which provider field should carry the limit:

- `max_tokens`
- `max_completion_tokens`
- `max_output_tokens`

This keeps transport differences centralized instead of duplicating field-selection logic across execution code paths.

### Truncation recovery

When a turn stops because it hit the output limit:

1. the runtime retries the same request once with the escalated budget
2. if the retried response still truncates but contains visible partial output, the existing continuation path is used
3. if the retried response is reasoning-only or otherwise empty, continuation retries are skipped and the runtime surfaces targeted guidance instead

This means continuation prompts are now the fallback path, not the first response to every truncation.

### Explicit chat exception

The explicit chat path keeps its own output behavior for now. The adaptive policy described here applies to the agentic execution and follow-up loops first, while `legacy` mode preserves the pre-existing executor behavior.

## Delegation Contract

Delegation now resolves through a structured briefing contract instead of passing child prompts through unchanged.

### Worker roles

Delegation supports:

- `auto`
- `researcher`
- `implementer`
- `verifier`
- `synthesizer`

If `worker_role` is omitted or set to `auto`, the runtime infers a role from the delegated request:

- read/search/investigate/audit-without-edits -> `researcher`
- review/check/test/validate/second-opinion -> `verifier`
- merge/combine/summarize predecessor outputs -> `synthesizer`
- everything else -> `implementer`

### Structured delegation brief

Every delegated target receives a brief with the same fields:

- objective
- resolved worker role
- parent task and current-step context
- scope in
- scope out
- known findings or evidence
- expected deliverable
- evidence requirements
- completion contract

The structured brief is used for:

- native child tasks
- orchestration-graph delegation
- ACP-targeted delegation
- external runtime delegation

### Role enforcement

The resolved role is applied through the worker-role registry so the child inherits:

- execution expectations
- completion contract
- tool restrictions
- verifier-specific or researcher-specific behavior where applicable

Extraction-mode guardrails, fanout limits, and depth limits still apply on top of the role contract.

## Verification Guidance

Verification is now nudged earlier in the turn loop.

### Checklist reminders

`task_list_create` and `task_list_update` can append an immediate reminder directly to the tool result when:

- all implementation items are complete
- no verification item exists
- the current plan does not already provide verification coverage
- the task is not already on a verified path that covers verification explicitly

That reminder is returned in the same tool result envelope that the model sees.

### Session reminder

The runtime still keeps the session-level verification nudge state and emits:

- `task_list_created`
- `task_list_updated`
- `task_list_verification_nudged`

This remains the replayable source for renderer and restore paths.

### Pre-finalization reminder

Before a task is allowed to wrap up, the executor can inject a pre-finalization reminder when required evidence is still missing, including:

- required test runs
- required execution-tool evidence
- required Playwright QA evidence
- pending verification checklist items
- later machine-checkable verification requirements implied by upcoming steps

The post-hoc verification runtime still remains the final enforcement path. These reminders exist to steer the model earlier, not to replace the final gate.

## Runtime Boundaries

The current split is:

- `SessionRuntime` owns session-state buckets, checklist state, recovery state, tool visibility/render caching, and snapshot restore
- `TaskExecutor` owns bootstrap, planning, finalization, completion policy, and the execution prompt section cache
- `TurnKernel` owns a single active turn

That keeps state ownership explicit while still letting planning, execution, follow-up, delegation, and verification share the same runtime concepts.

## Related Docs

- [Session Runtime](session-runtime.md)
- [Architecture](architecture.md)
- [Features](features.md)
- [Project Status](project-status.md)
- [Reliability Flywheel](reliability-flywheel.md)
