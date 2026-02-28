---
name: calendly
description: "Manage Calendly scheduling via the v2 API. List event types, view scheduled events, check invitee details, manage availability schedules, cancel/reschedule events, create one-off links, and configure webhooks. Use when the user asks about their calendar, upcoming meetings, scheduling links, or availability."
---

# Calendly

## Purpose

Manage Calendly scheduling via the v2 API. List event types, view scheduled events, check invitee details, manage availability schedules, cancel/reschedule events, create one-off links, and configure webhooks. Use when the user asks about their calendar, upcoming meetings, scheduling links, or availability.

## Routing

- Use when: User asks about Calendly meetings, scheduling links, availability, booking, upcoming events, or wants to manage their Calendly calendar
- Do not use when: User asks about Google Calendar, Apple Calendar, Outlook calendar, or general time management without Calendly
- Outputs: Meeting agendas, invitee details, availability windows, scheduling links, webhook configurations
- Success criteria: User receives accurate calendar data formatted as a clear agenda with times in their timezone

## Trigger Examples

### Positive

- Use the calendly skill for this request.
- Help me with calendly.
- User asks about Calendly meetings, scheduling links, availability, booking, upcoming events, or wants to manage their Calendly calendar
- Calendly: provide an actionable result.

### Negative

- User asks about Google Calendar, Apple Calendar, Outlook calendar, or general time management without Calendly
- Do not use calendly for unrelated requests.
- This request is outside calendly scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| query | string | No | What to check or manage (e.g., 'upcoming meetings', 'cancel 3pm tomorrow', 'my scheduling links') |

## Runtime Prompt

- Current runtime prompt length: 845 characters.
- Runtime prompt is defined directly in `../calendly.json`. 
