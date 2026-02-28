---
name: agentic-image-loop
description: "Generate -> annotate -> refine -> repeat using generate_image + Visual Annotator (Live Canvas)."
---

# Agentic Image Loop

## Purpose

Generate -> annotate -> refine -> repeat using generate_image + Visual Annotator (Live Canvas).

## Routing

- Use when: Use when the user asks to generate -> annotate -> refine -> repeat using generate_image + Visual Annotator Live Canvas.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Agentic Image Loop: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the agentic-image-loop skill for this request.
- Help me with agentic image loop.
- Use when the user asks to generate -> annotate -> refine -> repeat using generate_image + Visual Annotator Live Canvas.
- Agentic Image Loop: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use agentic-image-loop for unrelated requests.
- This request is outside agentic image loop scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 2117 characters.
- Runtime prompt is defined directly in `../agentic-image-loop.json`. 
