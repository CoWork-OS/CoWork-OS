---
name: autobrowse
description: "Learn a reliable browser workflow by iterating on a real web task, recording strategy, and proposing a reusable skill."
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Autobrowse

## Purpose

Autobrowse turns expensive browser exploration into durable operational memory. It runs a real browser task, studies the trace and diagnostics, iterates on the strategy, then graduates the reliable path into a reviewable skill artifact.

## Routing

- Use when: the user wants a repeatable web workflow learned from live exploration, optimized for future agents, or packaged as a skill.
- Do not use when: the work is a one-off lookup, one-page scrape, generic research task, or frontend QA task.
- Outputs: `strategy.md`, `iterations.md`, `draft-skill.md`, and usually an approval-gated `skill_proposal`.
- Success criteria: the learned workflow is repeatable, evidence-backed, and ready for human review or future agent reuse.

## Operating Loop

The user should not need to provide structured fields. Treat a plain request plus an optional link as enough input. Infer the objective from the request, infer the target site from any URL/domain in the request, default to 3 iterations, and default to creating a proposal.

1. **Objective.** Restate the user-visible task and target site. Define what counts as success and what actions would be irreversible.
2. **Attempt.** Use the browser normally. Prefer visible Browser V2 tooling when interacting with pages.
3. **Diagnostics.** Use `browser_console`, `browser_network`, `browser_storage`, `browser_snapshot`, and `browser_evaluate` when available. Use `browser_trace_start` and `browser_trace_stop` as supplemental diagnostics when the runtime exposes a readable trace summary. Capture only redacted, relevant evidence.
4. **Study.** Identify stalled steps, brittle selectors, hidden APIs, unnecessary clicks, rate limits, waits, auth boundaries, and deterministic shortcuts.
5. **Strategy.** Update `strategy.md` before the next iteration. The next attempt must read it first.
6. **Iterate.** Repeat up to the requested cap. Default to 3 iterations and never exceed 5 unless the user explicitly asks.
7. **Converge.** Stop early when the task succeeds and another pass produces no material improvement.
8. **Graduate.** Write `draft-skill.md`. If safe and useful, create a `skill_proposal` so the user can approve the new skill.

## Safety Rules

- Do not bypass captchas, paywalls, login restrictions, authorization boundaries, or consent gates.
- Pause before purchases, submissions, account changes, messages, destructive actions, or anything with external side effects.
- Redact credentials, tokens, cookies, private profile fields, and personal data not required for the workflow.
- Prefer public, documented, or naturally exposed endpoints. If an endpoint is undocumented, describe how it was observed and the risk that it may change.

## Evidence To Capture

- Start URL, final URL, and success state.
- Browser actions taken, especially unnecessary or removed steps.
- Stable selectors, ARIA labels, form field names, or URL patterns.
- Network endpoints, request parameters, response shape, and headers needed for safe replay.
- Console errors, auth/permission problems, rate limits, anti-bot signals, and timing waits.
- Tool/action counts per iteration when practical.

## Graduation Requirements

A graduated skill must include:

- Purpose and clear routing boundaries.
- Inputs and required parameters.
- Primary workflow, with deterministic paths first and browser fallbacks second.
- Validation checks that prove the workflow succeeded.
- Site-specific gotchas and freshness date.
- Safety boundaries and side-effect rules.
- Helper script names or direct fetch examples when they reduce browser work.

Use `skill_proposal` with action `create` by default. Use `draft-only` when the workflow is too fragile, too sensitive, or still missing validation evidence.

An Autobrowse run is not complete until `strategy.md`, `iterations.md`, and `draft-skill.md` exist in the run directory. If proposal creation fails, record the exact failure in `iterations.md` and keep the draft skill reviewable.
