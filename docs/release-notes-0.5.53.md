# Release Notes 0.5.53

Release `0.5.53` is a governance, local-inference, collaboration, and reliability release. It adds profile-first approval boundaries, optional Jev decision support, Apple Silicon MLX-LM and Atomic Chat execution paths, durable WorkSession lifecycle handling, bot conversations, local previews, Box Brain, opt-in CoWork Pulse, and a broad security and release-engineering hardening pass.

## Highlights

- **Profile-first approvals** add named **Ask for approval**, **Approve for me**, **Full access**, and **Custom** profiles across desktop, CLI, remote, managed, automation, channel, and child-task surfaces. In-scope work can run silently; unresolved decisions become durable inline **Deny** / **Allow once** cards; unavailable authority and `approval: "never"` fail closed.
- **Jev Decision Support** adds typed provider, model, strategy, team, browser-action, compaction, loop, output-guardrail, and skill/tool decisions with separate usage telemetry, bounded eligibility gates, and a headless validation harness. Jev observes or routes within explicit policy boundaries; it cannot grant permissions or replace hard security controls.
- **Local inference** adds the Apple Silicon MLX-LM provider, readiness checks, quantized-model choices, local `mlx_lm.server` lifecycle support, OpenAI-compatible routing, image capability metadata, and the versioned `local-balanced-v1` execution profile. Atomic Chat adds an opt-in `/v1` adapter with exact model discovery and typed connection failures while keeping task and permission ownership in CoWork.
- **Durable WorkSessions** add a canonical protocol, contracts, activity leases, projections, operational metrics, replay evaluation, rollout controls, turn guards, and control-plane/daemon/IPC integration. Session progress, task titles, tool outcomes, task selection, and completion state now remain coherent across restart and follow-up flows.
- **Bots and collaboration** add a Bots sidebar, persistent bot profiles and conversations, task options, agent rosters, team messaging, improved collaborative execution status, and clearer session/member/dashboard surfaces.
- **Local previews and artifacts** add governed local preview process handling, session-aware preview cards, composer draft/attachment fencing, richer task-surface scheduling, and continued document, spreadsheet, presentation, web-page, PDF, and video artifact improvements.
- **Box Brain and Pulse** add Box-backed memory/search integration with streamable HTTP transport and registry metadata, plus an explicitly opt-in, content-free CoWork Pulse service with consent, deletion, update-check separation, D1 schema, and client/collector tests.
- **Skills and connectors** expand bundled and registry-managed guidance, including Box and TypeSafe AI entries, refreshed plugin-pack metadata, architecture-design workflows, and stronger skill/import validation.

## Security and reliability

- Protected policy and Git boundaries can no longer be modified by an agent, checked-in permission manifests are treated as untrusted input, and principal-capability, identity, address-class, safe-external-URL, credential, recurring-approval, shell-network, and task-entrypoint enforcement is centralized and regression-tested.
- Remote MCP provenance and installation confirmation are enforced, inbound webhooks authenticate before side effects, internal/private fetch targets remain blocked across DNS and redirects, SSH tunnel arguments are validated, and app settings encryption migration fails closed instead of accepting predictable fallback material.
- Renderer HTML previews, tray quick input, LaTeX compilation, ImageMagick fallback arguments, Salesforce cursors, control-plane secrets, and Pulse administration paths receive additional containment and redaction hardening.
- Timeline/event projection now preserves terminal outcomes, reduces duplicate artifact/output events, handles disclosure and blocked states consistently, and keeps task selection and activity surfaces stable during restart and large-session replay.
- Memory writes, mailbox sync, provider onboarding, OpenRouter and MuAPI routing, automation retries, graceful shutdown, and legacy database migrations receive recovery and failure-isolation fixes.

## Developer and release tooling

- Vite 8, the React Vite plugin, Vitest, and related build tooling are upgraded with migration coverage and documentation-version validation wired into the build.
- Release packaging now includes registry publication recovery, bundle/smoke helpers, detached updater-signature verification, platform metadata checks, and expanded macOS/Windows/Linux artifact coverage.
- QA adds approval-boundary smoke checks, harness dependency checks, isolated replay evaluation, security/evaluation regression cases, WorkSession replay assertions, performance fixtures, and focused coverage across the new runtime and renderer surfaces.
- Documentation was refreshed across security, providers, local execution, WorkSessions, bots, Pulse, Box Brain, skills, channels, artifacts, self-hosting, and release operations.

## Upgrade notes

- The package version is `0.5.53`; the desktop runtime remains Electron 44 and macOS 13 Ventura remains the minimum supported macOS version. macOS 12 Monterey users should remain on `0.5.51`.
- CoWork Pulse is disabled by default and requires explicit consent. It is content-free and separate from anonymous update checks; its collection and deletion limitations are documented in [CoWork Pulse](cowork-pulse.md).
- Approval behavior is profile-driven. Legacy popup prompts remain available only as the explicit `COWORK_APPROVAL_PROMPTS=on` diagnostic override.

## Release validation

The release candidate should pass the repository gates before tagging or publishing:

```bash
npm run fmt:check
npm run type-check
npm run lint
npm run qa:docs-versions
npm run qa:approval-boundaries
npm run qa:harness
npm run build
npm run release:smoke
```

Platform packaging remains a host-specific gate. Run the matching unsigned macOS smoke check when validating locally, and run the Windows installer and Linux server package checks on their supported build hosts. Do not publish until the local branch has been reconciled with any commits that landed on the remote release base.
