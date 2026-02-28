# Skills Quality Spec

This document defines mandatory quality standards for bundled CoWork OS skills.

## Scope

- Applies to bundled skills in `resources/skills/*.json`.
- Applies to hybrid skill packages under `resources/skills/<skill-id>/`.
- Applies to model invocation across Anthropic, OpenAI, Gemini, and other providers.

## Core Principles

1. Keep prompts concise and operational.
2. Define explicit trigger boundaries.
3. Define explicit outputs and success criteria.
4. Use progressive disclosure for long or variant-heavy guidance.
5. Prefer deterministic scripts for fragile or repetitive operations.

## Required Metadata

Each skill must include:

- `metadata.routing.useWhen`
- `metadata.routing.dontUseWhen`
- `metadata.routing.outputs`
- `metadata.routing.successCriteria`
- `metadata.routing.examples.positive` (minimum 3 examples)
- `metadata.routing.examples.negative` (minimum 3 examples)
- `metadata.authoring.complexity` (`low`, `medium`, or `high`)

## Prompt Budgets

Prompt size budgets are based on `metadata.authoring.complexity`:

- `low`: `<= 2000` characters
- `medium`: `<= 5000` characters
- `high`: `<= 8000` characters

If a skill exceeds budget, move deep detail into `references/` files and keep the runtime prompt focused on workflow and outputs.

## Hybrid Skill Layout

Each bundled skill should follow:

- `resources/skills/<id>.json` runtime manifest
- `resources/skills/<id>/SKILL.md` authoring guide
- `resources/skills/<id>/references/*.md` optional deep references
- `resources/skills/<id>/scripts/*` optional deterministic scripts

## Placeholder and Parameter Rules

- Allowed runtime placeholders in prompts are:
  - `{baseDir}`
  - `{artifactDir}`
  - `{{paramName}}` (declared skill parameter only)
- Any `{baseDir}/...` reference must resolve to an existing path in `resources/skills/<id>/`.
  - If a prompt references `{baseDir}/scripts` or `{baseDir}/scripts/<file>`, the directory/file must exist.
- Avoid single-brace pseudo-placeholders like `{page_id}` or `{cardId}` in prompt examples.
  - Use literal angle-bracket examples instead (for example, `<page_id>`, `<cardId>`), or use a declared `{{paramName}}`.
- `{artifactDir}` paths must be deterministic when artifacts are expected.
- `{{param}}` placeholders must match declared parameters.
- For `select` parameters, `options` must be strings.

## Validation and Audit Commands

- `npm run skills:validate-routing`
- `npm run skills:validate-content`
- `npm run skills:audit`
- `npm run skills:eval-routing`
- `npm run skills:check`

## Enforcement Phases

1. **Phase 1 (advisory)**

- `skills:check` reports warnings and writes an audit scorecard.
- Hard failure for structural errors (invalid schema, missing required files/placeholders).

2. **Phase 2 (partial block)**

- Continue hard-failing structural errors.
- Keep budget/example quality issues as warnings.

3. **Phase 3 (full block)**

- Enable strict warning mode (`SKILLS_CHECK_PHASE=3`).
- Fail on quality warnings and routing eval threshold failures.
- Routing eval thresholds:
  - expected-hit rate `>= 95%`
  - forbidden misfire rate `<= 2%`

## Temporary Bypass for Hotfixes

`skills:check` supports temporary bypass for hotfix branches only:

- branch must match `hotfix/*`
- set `SKILLS_CHECK_BYPASS=1`

This bypass is intended for release emergencies only.
