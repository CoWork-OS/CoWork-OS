---
name: usecase-booking-options
description: "Find booking openings in a time window, cross-check calendar, propose 3 options. Stops before booking."
---

# Booking Options

## Purpose

Find booking openings in a time window, cross-check calendar, propose 3 options. Stops before booking.

## Routing

- Use when: Use when the user asks to find booking openings in a time window, cross-check calendar, propose 3 options. Stops before booking.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Booking Options: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the usecase-booking-options skill for this request.
- Help me with booking options.
- Use when the user asks to find booking openings in a time window, cross-check calendar, propose 3 options. Stops before booking.
- Booking Options: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use usecase-booking-options for unrelated requests.
- This request is outside booking options scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| url | string | Yes | Booking URL (OpenTable/Calendly/spa/etc.) |
| expected_name | string | No | Optional venue/service name to verify after navigation |
| party_size | number | No | Party size |
| days_ahead | number | No | How many days ahead to check |
| start_time | string | No | Start time (e.g., "18:30") |
| end_time | string | No | End time (e.g., "20:30") |

## Runtime Prompt

- Current runtime prompt length: 1416 characters.
- Runtime prompt is defined directly in `../usecase-booking-options.json`. 
