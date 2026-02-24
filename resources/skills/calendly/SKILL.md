---
name: calendly
description:
  Manage Calendly scheduling via the v2 API. List event types, view scheduled events,
  check invitee details, manage availability schedules, cancel/reschedule events,
  create one-off links, and configure webhooks.
homepage: https://developer.calendly.com
metadata:
  {
    "cowork":
      {
        "emoji": "📅",
        "category": "Tools",
      },
  }
---

# Calendly 📅

Manage scheduling via the Calendly API v2. View meetings, check availability, manage invitees, create booking links, and configure webhooks — all from CoWork OS.

## Overview

Full read/write access to Calendly's scheduling platform. Uses a Personal Access Token (no OAuth flow required).

## Setup

1. Go to https://calendly.com/integrations/api_webhooks
2. Click "Generate New Token"
3. Store it:

```bash
mkdir -p ~/.config/calendly
echo "YOUR_TOKEN" > ~/.config/calendly/api_token
```

## API Coverage

| Resource | Operations |
|----------|-----------|
| **User Profile** | Get current user, timezone, organization |
| **Event Types** | List all, get details, filter active/inactive |
| **Scheduled Events** | List upcoming/past/cancelled, filter by date range |
| **Invitees** | List per event, view details, custom question answers, UTM tracking |
| **Cancellation** | Cancel with reason, preserve event record |
| **No-Shows** | Mark/unmark invitees as no-show |
| **One-Off Links** | Create single-use booking URLs |
| **Availability** | List schedules, view rules, check busy times, calculate free slots |
| **Webhooks** | Create/list/delete subscriptions for booking events |
| **Organization** | List members, roles |
| **Pagination** | All list endpoints, up to 100 per page |

## Common Workflows

| User Says | What Happens |
|-----------|-------------|
| "What meetings do I have this week?" | Query upcoming events, fetch invitees, format as daily agenda |
| "Who's my next meeting with?" | Next event + invitee details + location |
| "Cancel my 3pm meeting tomorrow" | Find event by time, POST cancellation with reason |
| "Create a one-time booking link" | POST to scheduling_links with max_event_count: 1 |
| "When am I free this week?" | Busy times subtracted from availability windows |
| "How many meetings last month?" | Count + group by type + total hours |
| "Show my scheduling links" | Active event types with URLs and durations |
| "Set up a webhook for new bookings" | POST webhook subscription for invitee.created |

## Output Format

```
📅 This Week's Meetings

  Monday, Feb 24
    2:30 PM – 3:00 PM  Discovery Call
      ↳ John Smith <john@example.com>  |  Zoom
    4:00 PM – 4:30 PM  Team Sync
      ↳ Sarah Lee <sarah@example.com>  |  Google Meet

  Tuesday, Feb 25
    No meetings

  Wednesday, Feb 26
    10:00 AM – 10:30 AM  Product Demo
      ↳ Alex Chen <alex@company.com>  |  Zoom
      ↳ Q: "What features interest you?" A: "API integrations"

  3 meetings this week  |  1.5 hours total
```

## Webhook Events

| Event | Fires When |
|-------|------------|
| `invitee.created` | Someone books a meeting |
| `invitee.canceled` | Someone cancels a booking |
| `invitee_no_show.created` | Invitee marked as no-show |
| `routing_form_submission.created` | Routing form submitted |

## Comparison with ClawHub Version

| Feature | ClawHub (v1.0.3) | CoWork OS |
|---------|-------------------|-----------|
| Auth | Managed OAuth | **Personal Access Token** (simpler, no OAuth flow) |
| Event types | Yes | Yes — **with formatted output and active/inactive filtering** |
| Scheduled events | Yes | Yes — **upcoming, past, cancelled, date range filtering, sorted** |
| Invitees | Yes | Yes — **with custom Q&A, UTM tracking, no-show status** |
| Availability | Yes | Yes — **schedules + busy times + free slot calculation** |
| Cancellation | Not mentioned | **Cancel with reason, preserving event record** |
| No-shows | Not mentioned | **Mark/unmark no-shows** |
| One-off links | Not mentioned | **Create single-use booking URLs** |
| Webhooks | "Manage webhooks" | **Full CRUD + event reference table** |
| Organization | Not mentioned | **List members and roles** |
| Pagination | Not mentioned | **Documented with count/page_token/sort params** |
| Workflows | Not documented | **8 step-by-step recipes** |
| Output formatting | Not documented | **Timezone-aware daily agenda format with example** |
| Setup guide | Managed OAuth | **3-step token setup with verification command** |

## Notes

- Rate limit: 100 requests per 10 seconds per user
- All times UTC in API responses — convert to user's timezone
- UUIDs are embedded in URI strings — extract from the end
- Cancellation is a POST (not DELETE) — preserves the event record
- `active: false` event types are disabled/hidden links
- Webhook retries use exponential backoff
