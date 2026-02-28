---
name: video-frames
description: "Extract frames or short clips from videos using ffmpeg."
---

# Video-frames

## Purpose

Extract frames or short clips from videos using ffmpeg.

## Routing

- Use when: Use when the user asks to extract frames or short clips from videos using ffmpeg.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Video-frames: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the video-frames skill for this request.
- Help me with video-frames.
- Use when the user asks to extract frames or short clips from videos using ffmpeg.
- Video-frames: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use video-frames for unrelated requests.
- This request is outside video-frames scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 462 characters.
- Runtime prompt is defined directly in `../video-frames.json`. 
