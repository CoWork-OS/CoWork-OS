---
name: cloud-migration
description: "Cloud migration strategy and execution: assessment frameworks, migration patterns, database migration, network cutover, and multi-cloud planning."
---

# Cloud Migration

## Purpose

Cloud migration strategy and execution: assessment frameworks, migration patterns, database migration, network cutover, and multi-cloud planning.

## Routing

- Use when: Use when the user asks about cloud migration, moving from on-prem to cloud, AWS to GCP, cloud to cloud migration, migration assessment, the 6 Rs, lift and shift, or cloud modernization strategy.
- Do not use when: Do not use for day-to-day Terraform operations (use terraform-ops), Kubernetes management (use kubernetes-ops), or Docker Compose (use docker-compose-ops).
- Outputs: Migration plans, assessment frameworks, cutover checklists, and cost analysis guidance.
- Success criteria: Returns a structured migration plan with phases, wave groupings, and actionable steps.

## Trigger Examples

### Positive

- Use the cloud-migration skill for this request.
- Help me with cloud migration.
- Use when the user asks about cloud migration, moving from on-prem to cloud, AWS to GCP, cloud to cloud migration, migration assessment, the 6 Rs, lift and shift, or cloud modernization strategy.
- Cloud Migration: provide an actionable result.

### Negative

- Do not use for day-to-day Terraform operations (use terraform-ops), Kubernetes management (use kubernetes-ops), or Docker Compose (use docker-compose-ops).
- Do not use cloud-migration for unrelated requests.
- This request is outside cloud migration scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 940 characters.
- Runtime prompt is defined directly in `../cloud-migration.json`. 
