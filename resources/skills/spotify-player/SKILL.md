---
name: spotify-player
description: "Terminal Spotify playback/search via spogo (preferred) or spotify_player."
---

# Spotify-player

## Purpose

Terminal Spotify playback/search via spogo (preferred) or spotify_player.

## Routing

- Use when: Use when the user asks to terminal Spotify playback/search via spogo preferred or spotify_player.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Spotify-player: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the spotify-player skill for this request.
- Help me with spotify-player.
- Use when the user asks to terminal Spotify playback/search via spogo preferred or spotify_player.
- Spotify-player: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use spotify-player for unrelated requests.
- This request is outside spotify-player scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 884 characters.
- Runtime prompt is defined directly in `../spotify-player.json`. 
