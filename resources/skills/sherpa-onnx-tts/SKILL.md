---
name: sherpa-onnx-tts
description: "Local text-to-speech via sherpa-onnx (offline, no cloud)"
---

# Sherpa-onnx-tts

## Purpose

Local text-to-speech via sherpa-onnx (offline, no cloud)

## Routing

- Use when: Use when the user asks to local text-to-speech via sherpa-onnx offline, no cloud.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Sherpa-onnx-tts: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the sherpa-onnx-tts skill for this request.
- Help me with sherpa-onnx-tts.
- Use when the user asks to local text-to-speech via sherpa-onnx offline, no cloud.
- Sherpa-onnx-tts: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use sherpa-onnx-tts for unrelated requests.
- This request is outside sherpa-onnx-tts scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1204 characters.
- Runtime prompt is defined directly in `../sherpa-onnx-tts.json`. 
