---
name: skill-creator
description: "Create or update AgentSkills for CoWork-OSS. Use when designing, structuring, or packaging skills. Supports JSON format with requirements, installation specs, and metadata."
---

# Skill-creator

## Purpose

Create or update AgentSkills for CoWork-OSS. Use when designing, structuring, or packaging skills. Supports JSON format with requirements, installation specs, and metadata.

## Routing

- Use when: Use when the user asks to create or update AgentSkills for CoWork-OSS. Use when designing, structuring, or packaging skills. Supports JSON format with requirements, installation specs, and metadata.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Skill-creator: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the skill-creator skill for this request.
- Help me with skill-creator.
- Use when the user asks to create or update AgentSkills for CoWork-OSS. Use when designing, structuring, or packaging skills. Supports JSON format with requirements, installation specs, and metadata.
- Skill-creator: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use skill-creator for unrelated requests.
- This request is outside skill-creator scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 962 characters.
- Runtime prompt is defined directly in `../skill-creator.json`. 
