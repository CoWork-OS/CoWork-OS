---
name: screenshot-capture
description: "Capture desktop screenshots with OS-aware save-location rules, app/window/region support, and bundled helpers."
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Screenshot Capture

## Purpose

Capture screenshots of the desktop, an app, a window, or a region with the right save location.

## Routing

- Use when: Use when the user explicitly asks for a screenshot, for whole-system desktop captures, or when a tool-specific capture cannot get what you need.
- Do not use when: Do not use when a better-integrated screenshot tool is available for the requested surface, or when the request is unrelated to visual capture.
- Outputs: Saved screenshot path(s) plus a brief capture note when needed.
- Success criteria: Returns the saved screenshot path(s), uses the requested save location, and follows the platform-specific capture workflow without inventing unavailable tools.

## Trigger Examples

### Positive

- Take a screenshot of this app window.
- Capture the full desktop and save it to a file.
- Take a screenshot of Codex and put it in temp.
- Use Screenshot Capture for this desktop capture.

### Negative

- Summarize this text without taking a screenshot.
- Write a plan for a capture workflow.
- This is a browser-only automation task with a better tool available.
- This request does not involve any visual capture.

## Runtime Prompt

- Current runtime prompt length: defined directly in `../screenshot-capture.json`.
- Detailed save-location rules and command patterns live in `references/full-guidance.md`.
