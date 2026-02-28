---
name: camsnap
description: "Capture frames or clips from RTSP/ONVIF cameras."
---

# Camsnap

## Purpose

Capture frames or clips from RTSP/ONVIF cameras.

## Routing

- Use when: Use when the user asks to capture frames or clips from RTSP/ONVIF cameras.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Camsnap: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the camsnap skill for this request.
- Help me with camsnap.
- Use when the user asks to capture frames or clips from RTSP/ONVIF cameras.
- Camsnap: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use camsnap for unrelated requests.
- This request is outside camsnap scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 589 characters.
- Runtime prompt is defined directly in `../camsnap.json`. 
