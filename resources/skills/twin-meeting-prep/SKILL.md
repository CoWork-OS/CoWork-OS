---
name: twin-meeting-prep
description: "Prepare a structured brief for an upcoming meeting with relevant context, open items, data points, and talking points. Used by digital twin personas to reduce meeting preparation overhead."
---

# Meeting Preparation Brief

## Purpose

Prepare a structured brief for an upcoming meeting with relevant context, open items, data points, and talking points. Used by digital twin personas to reduce meeting preparation overhead.

## Routing

- Use when: Use when preparing for meetings, 1-on-1s, reviews, planning sessions, or any scheduled discussion.
- Do not use when: Don't use for generating meeting minutes after a meeting has occurred.
- Outputs: Structured meeting brief with context, open items, and talking points
- Success criteria: Brief provides sufficient context to enter the meeting prepared and confident

## Trigger Examples

### Positive

- Use the twin-meeting-prep skill for this request.
- Help me with meeting preparation brief.
- Use when preparing for meetings, 1-on-1s, reviews, planning sessions, or any scheduled discussion.
- Meeting Preparation Brief: provide an actionable result.

### Negative

- Don't use for generating meeting minutes after a meeting has occurred.
- Do not use twin-meeting-prep for unrelated requests.
- This request is outside meeting preparation brief scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| meeting_topic | string | Yes | What the meeting is about (e.g., 'Sprint planning', 'Architecture review for auth service', '1-on-1 with Sarah') |

## Runtime Prompt

- Current runtime prompt length: 825 characters.
- Runtime prompt is defined directly in `../twin-meeting-prep.json`. 
