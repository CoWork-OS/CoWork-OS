# Release Notes 0.5.27

This page summarizes the product and engineering changes included in `0.5.27`, following `v0.5.23`.

## Summary

Release `0.5.27` is the biggest runtime and product consolidation since the last tagged release. It adds a new core automation and continual-learning layer, expands memory and recall workflows, introduces two bundled skills, and hardens the desktop/runtime release path. The broad theme is the same across the codebase: more of CoWork's always-on intelligence is now explicit, persisted, and visible in the UI instead of being scattered across legacy heartbeat, persona, and ad hoc task paths.

## New Features

- **Core automation profiles**: a new automation profile model now owns the always-on runtime surface, replacing older heartbeat/pseudo-persona ownership paths.
- **Trace, failure, and learning pipelines**: the core runtime now has first-class trace, failure-record, failure-cluster, eval-case, harness-experiment, learnings, memory-candidate, and regression-gate services and repositories.
- **Memory distillation**: the core memory distiller now operates as a dedicated runtime layer with scoped memory resolution, distill-run persistence, and supporting query paths.
- **Research vaults (`LLM Wiki`)**: first-class workspace-local research vaults inspired by Andrej Karpathy's LLM Wiki concept, with deterministic raw-source capture, Obsidian-friendly notes, vault search, graph reporting, and filed-back outputs. [Learn more](docs/llm-wiki.md)
- **Programmatic technical video skill (`manim-video`)**: a bundled skill for planning and scaffolding Manim CE explainers, equation walkthroughs, algorithm visualizations, and animated architecture/data stories. [Learn more](docs/skills/manim-video.md)
- **Curated memory and recall services**: new curated-memory, quote-recall, and session-recall services expand how the app stores and surfaces durable context.
- **Workspace path healing**: desktop workspace paths can now be repaired when a workspace is moved or renamed.
- **File provenance registry**: imported or exported files can carry trust and provenance metadata through a dedicated registry.
- **PDF text extraction**: a unified PDF text path now handles normal PDFs and review-heavy extraction flows more reliably.
- **Shared onboarding model**: onboarding data now lives in shared structures so setup flows can reason about assistant profile, workspace, and response-style state consistently.

## Enhancements

- **Mission Control and onboarding**: the UI now surfaces automation profiles, distillation controls, core failures, learnings, and companion inbox state more clearly.
- **Renderer and completion surfaces**: task completion UX, disclosure handling, memory hub settings, Slack settings, permission settings, and onboarding screens were updated to fit the new runtime model.
- **Gateway and messaging routing**: WhatsApp command handling, channel routing, and email/report delivery were updated to match the richer runtime and task-state model.
- **Tooling and skill execution**: explicit skill invocation matching, runtime tool metadata, tool exposure, and tool-policy inference were refined across the executor and loader layers.
- **LLM provider behavior**: OpenRouter and provider-factory behavior were tightened with better catalog loading, logging, and model-selection handling.
- **Security and approval flows**: approval controls, workspace rule handling, control-plane sanitization, and export-permission context handling were all strengthened.
- **Documentation**: release notes, changelog surfaces, architecture docs, feature docs, security docs, and onboarding guidance were refreshed to reflect the new architecture and release scope.
- **Testing**: coverage expanded across core automation, memory, onboarding, gateway, runtime tools, security, renderer helpers, and release-adjacent workflows.

## Fixes

- **Legacy task migration**: fixed legacy task-event migration paths so older task data upgrades cleanly into the newer runtime model.
- **Heartbeat compatibility**: preserved compatibility while routing dispatch state through automation profiles and handling deferred heartbeat state more carefully.
- **Completion evidence**: fixed report-task contract inference and completion evidence handling so task finalization is more reliable.
- **OpenRouter noise**: reduced noisy provider catalog loading and made structured logging more predictable.
- **Tool-call sanitization**: tightened tool-call and task-message sanitization so malicious or malformed payloads are less likely to leak into runtime state.
- **Workspace boundaries**: edits to workspace ignore files now respect workspace boundaries more strictly.
- **Approval and runtime edge cases**: updated approval handling, tool exposure, and runtime policy decisions so long-running tasks and guarded actions fail more predictably.
- **Release artifacts**: release artifact naming and packaging logic were aligned with updater metadata so published assets stay consistent.

## Upgrade Notes

- `LLM Wiki` is the new canonical name for the workspace-local research vault feature; it is inspired by Karpathy's LLM Wiki concept rather than being a general note-taking editor.
- Users upgrading from earlier builds should expect the new automation-profile-driven runtime model to appear in Mission Control and related settings surfaces.
- Existing memory and task data remains compatible, but the release includes a substantial migration and reconciliation layer for older task, heartbeat, and subconscious records.

## References

- [Changelog](docs/changelog.md) - full version history
- [Core Automation](docs/core-automation.md) - current automation runtime model
- [LLM Wiki](docs/llm-wiki.md) - research vault workflow and graph reporting
- [Manim Video](docs/skills/manim-video.md) - technical explainer video skill
- [Memory Flow](docs/workspace-memory-flow.md) - current workspace memory architecture

This page is the canonical high-level summary for the changes included in `0.5.27`.
