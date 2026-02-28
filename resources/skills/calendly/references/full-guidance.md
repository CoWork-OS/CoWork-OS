# Calendly — Scheduling Intelligence

Manage scheduling via the Calendly API v2. Read event types, scheduled events, invitees, availability, and webhooks.

## Setup

### 1. Get a Personal Access Token

1. Go to https://calendly.com/integrations/api_webhooks
2. Click "Generate New Token"
3. Copy the token
4. Store it:

```bash
mkdir -p ~/.config/calendly
echo "YOUR_TOKEN_HERE" > ~/.config/calendly/api_token
```

### 2. Verify it works

```bash
CAL_TOKEN=$(cat ~/.config/calendly/api_token)
curl -s 'https://api.calendly.com/users/me' \
  -H "Authorization: Bearer $CAL_TOKEN" \
  -H "Content-Type: application/json" | python3 -c "
import json, sys
d = json.load(sys.stdin)['resource']
print(f'Name: {d["name"]}')
print(f'Email: {d["email"]}')
print(f'Slug: {d["slug"]}')
print(f'URI: {d["uri"]}')
print(f'Timezone: {d["timezone"]}')
"
```

> The `uri` field (e.g., `https://api.calendly.com/users/XXXXXXXX`) is your **user URI** — many endpoints need it.

## API Basics

All requests need:

```bash
CAL_TOKEN=$(cat ~/.config/calendly/api_token)
curl -s 'https://api.calendly.com/...' \
  -H "Authorization: Bearer $CAL_TOKEN" \
  -H "Content-Type: application/json"
```

Base URL: `https://api.calendly.com`

Rate limit: 100 requests per 10 seconds per user.

---

## Current User

### Get your profile

```bash
CAL_TOKEN=$(cat ~/.config/calendly/api_token)
curl -s 'https://api.calendly.com/users/me' \
  -H "Authorization: Bearer $CAL_TOKEN"
```

Key fields: `name`, `email`, `slug`, `uri`, `timezone`, `scheduling_url`, `current_organization`

---

## Event Types

Event types are the scheduling links (e.g., "30 Minute Meeting", "Discovery Call").

### List all event types

```bash
CAL_TOKEN=$(cat ~/.config/calendly/api_token)
USER_URI=$(curl -s 'https://api.calendly.com/users/me' -H "Authorization: Bearer $CAL_TOKEN" | python3 -c "import json,sys; print(json.load(sys.stdin)['resource']['uri'])")

curl -s "https://api.calendly.com/event_types?user=$USER_URI&count=20" \
  -H "Authorization: Bearer $CAL_TOKEN" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for et in d['collection']:
    status = '✓' if et['active'] else '✗'
    dur = et.get('duration', '?')
    print(f'{status} {et["name"]} ({dur} min) — {et["scheduling_url"]}')
"
```

### Get a specific event type

```bash
curl -s 'https://api.calendly.com/event_types/{event_type_uuid}' \
  -H "Authorization: Bearer $CAL_TOKEN"
```

### Event type fields

| Field | Description |
|-------|-------------|
| `name` | Display name ("30 Minute Meeting") |
| `slug` | URL slug |
| `duration` | Duration in minutes |
| `scheduling_url` | Public booking link |
| `active` | Whether it's live |
| `kind` | `solo` or `group` |
| `type` | `StandardEventType` or `AdhocEventType` |
| `color` | Hex color |
| `description_plain` | Plain text description |
| `internal_note` | Private note |
| `pooling_type` | For round-robin: `round_robin` or `collective` |
| `custom_questions` | Intake form questions |

---

## Scheduled Events

These are actual booked meetings.

### List upcoming events

```bash
CAL_TOKEN=$(cat ~/.config/calendly/api_token)
USER_URI=$(curl -s 'https://api.calendly.com/users/me' -H "Authorization: Bearer $CAL_TOKEN" | python3 -c "import json,sys; print(json.load(sys.stdin)['resource']['uri'])")

curl -s "https://api.calendly.com/scheduled_events?user=$USER_URI&status=active&sort=start_time:asc&count=25&min_start_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -H "Authorization: Bearer $CAL_TOKEN" | python3 -c "
import json, sys
from datetime import datetime
d = json.load(sys.stdin)
for ev in d['collection']:
    start = datetime.fromisoformat(ev['start_time'].replace('Z', '+00:00'))
    end = datetime.fromisoformat(ev['end_time'].replace('Z', '+00:00'))
    print(f'{start.strftime(\"%b %d %H:%M\")} – {end.strftime(\"%H:%M\")}  {ev["name"]}')
    print(f'  Status: {ev["status"]}  |  Location: {ev.get("location", {}).get("type", "N/A")}')
    print(f'  URI: {ev["uri"]}')
    print()
"
```

### List past events

```bash
curl -s "https://api.calendly.com/scheduled_events?user=$USER_URI&status=active&sort=start_time:desc&count=10&max_start_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -H "Authorization: Bearer $CAL_TOKEN"
```

### List cancelled events

```bash
curl -s "https://api.calendly.com/scheduled_events?user=$USER_URI&status=canceled&count=10" \
  -H "Authorization: Bearer $CAL_TOKEN"
```

### Get a specific event

```bash
curl -s 'https://api.calendly.com/scheduled_events/{event_uuid}' \
  -H "Authorization: Bearer $CAL_TOKEN"
```

### Filter by date range

```bash
curl -s "https://api.calendly.com/scheduled_events?user=$USER_URI&status=active&min_start_time=2026-03-01T00:00:00Z&max_start_time=2026-03-31T23:59:59Z" \
  -H "Authorization: Bearer $CAL_TOKEN"
```

### Scheduled event fields

| Field | Description |
|-------|-------------|
| `name` | Event type name |
| `status` | `active` or `canceled` |
| `start_time` | ISO 8601 start |
| `end_time` | ISO 8601 end |
| `event_type` | URI of the event type |
| `location` | Meeting location (Zoom, Google Meet, phone, etc.) |
| `invitees_counter` | `{ total, active, limit }` |
| `created_at` | When booked |
| `updated_at` | Last update |
| `cancellation` | Cancellation details (if cancelled) |
| `event_memberships` | Host(s) assigned |

---

## Invitees

People who booked a meeting.

### List invitees for an event

```bash
curl -s 'https://api.calendly.com/scheduled_events/{event_uuid}/invitees?count=50' \
  -H "Authorization: Bearer $CAL_TOKEN" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for inv in d['collection']:
    print(f'{inv["name"]} <{inv["email"]}>')
    print(f'  Status: {inv["status"]}  |  Timezone: {inv.get("timezone", "N/A")}')
    if inv.get('questions_and_answers'):
        for qa in inv['questions_and_answers']:
            print(f'  Q: {qa["question"]}  A: {qa["answer"]}')
    print()
"
```

### Get a specific invitee

```bash
curl -s 'https://api.calendly.com/scheduled_events/{event_uuid}/invitees/{invitee_uuid}' \
  -H "Authorization: Bearer $CAL_TOKEN"
```

### Invitee fields

| Field | Description |
|-------|-------------|
| `name` | Invitee's name |
| `email` | Invitee's email |
| `status` | `active` or `canceled` |
| `timezone` | Invitee's timezone |
| `questions_and_answers` | Responses to custom questions |
| `tracking` | UTM parameters (utm_source, utm_medium, etc.) |
| `cancel_url` | Link invitee can use to cancel |
| `reschedule_url` | Link invitee can use to reschedule |
| `created_at` | When they booked |
| `no_show` | No-show status if marked |
| `payment` | Payment info if Calendly Payments enabled |

---

## Cancel & Reschedule

### Cancel an event

```bash
CAL_TOKEN=$(cat ~/.config/calendly/api_token)
curl -s -X POST 'https://api.calendly.com/scheduled_events/{event_uuid}/cancellation' \
  -H "Authorization: Bearer $CAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Schedule conflict — will reschedule shortly"}'
```

### Mark invitee as no-show

```bash
curl -s -X POST 'https://api.calendly.com/invitee_no_shows' \
  -H "Authorization: Bearer $CAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"invitee": "https://api.calendly.com/scheduled_events/{event_uuid}/invitees/{invitee_uuid}"}'
```

### Undo no-show

```bash
curl -s -X DELETE 'https://api.calendly.com/invitee_no_shows/{no_show_uuid}' \
  -H "Authorization: Bearer $CAL_TOKEN"
```

---

## One-Off Scheduling Links

Create single-use or limited-use booking links.

```bash
CAL_TOKEN=$(cat ~/.config/calendly/api_token)
curl -s -X POST 'https://api.calendly.com/scheduling_links' \
  -H "Authorization: Bearer $CAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "max_event_count": 1,
    "owner": "https://api.calendly.com/event_types/{event_type_uuid}",
    "owner_type": "EventType"
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)['resource']
print(f'Booking URL: {d["booking_url"]}')
"
```

---

## Availability

### List availability schedules

```bash
CAL_TOKEN=$(cat ~/.config/calendly/api_token)
USER_URI=$(curl -s 'https://api.calendly.com/users/me' -H "Authorization: Bearer $CAL_TOKEN" | python3 -c "import json,sys; print(json.load(sys.stdin)['resource']['uri'])")

curl -s "https://api.calendly.com/user_availability_schedules?user=$USER_URI" \
  -H "Authorization: Bearer $CAL_TOKEN" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for sched in d['collection']:
    default = ' (default)' if sched.get('default') else ''
    print(f'{sched["name"]}{default}')
    print(f'  Timezone: {sched["timezone"]}')
    for rule in sched.get('rules', []):
        if rule['type'] == 'wday':
            day = rule['wday']
            intervals = ', '.join(f'{i["from"]}–{i["to"]}' for i in rule.get('intervals', []))
            print(f'  {day}: {intervals if intervals else "OFF"}')
    print()
"
```

### Get a specific availability schedule

```bash
curl -s 'https://api.calendly.com/user_availability_schedules/{schedule_uuid}' \
  -H "Authorization: Bearer $CAL_TOKEN"
```

### Check user busy times

```bash
curl -s "https://api.calendly.com/user_busy_times?user=$USER_URI&start_time=$(date -u +%Y-%m-%dT00:00:00Z)&end_time=$(date -u -v+7d +%Y-%m-%dT23:59:59Z 2>/dev/null || date -u -d '+7 days' +%Y-%m-%dT23:59:59Z)" \
  -H "Authorization: Bearer $CAL_TOKEN" | python3 -c "
import json, sys
from datetime import datetime
d = json.load(sys.stdin)
for busy in d['collection']:
    start = datetime.fromisoformat(busy['start_time'].replace('Z', '+00:00'))
    end = datetime.fromisoformat(busy['end_time'].replace('Z', '+00:00'))
    btype = busy.get('type', 'calendly')
    print(f'{start.strftime(\"%b %d %H:%M\")} – {end.strftime(\"%H:%M\")}  [{btype}]')
"
```

---

## Webhooks

### Create a webhook subscription

```bash
CAL_TOKEN=$(cat ~/.config/calendly/api_token)
ORG_URI=$(curl -s 'https://api.calendly.com/users/me' -H "Authorization: Bearer $CAL_TOKEN" | python3 -c "import json,sys; print(json.load(sys.stdin)['resource']['current_organization'])")

curl -s -X POST 'https://api.calendly.com/webhook_subscriptions' \
  -H "Authorization: Bearer $CAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"https://your-server.com/webhooks/calendly\",
    \"events\": [\"invitee.created\", \"invitee.canceled\"],
    \"organization\": \"$ORG_URI\",
    \"scope\": \"user\",
    \"user\": \"$USER_URI\"
  }"
```

### Available webhook events

| Event | Fires When |
|-------|------------|
| `invitee.created` | Someone books a meeting |
| `invitee.canceled` | Someone cancels a booking |
| `invitee_no_show.created` | Invitee marked as no-show |
| `routing_form_submission.created` | Routing form submitted |

### List webhook subscriptions

```bash
curl -s "https://api.calendly.com/webhook_subscriptions?organization=$ORG_URI&scope=user&user=$USER_URI" \
  -H "Authorization: Bearer $CAL_TOKEN"
```

### Delete a webhook

```bash
curl -s -X DELETE 'https://api.calendly.com/webhook_subscriptions/{webhook_uuid}' \
  -H "Authorization: Bearer $CAL_TOKEN"
```

---

## Organization & Membership

### Get organization members

```bash
CAL_TOKEN=$(cat ~/.config/calendly/api_token)
ORG_URI=$(curl -s 'https://api.calendly.com/users/me' -H "Authorization: Bearer $CAL_TOKEN" | python3 -c "import json,sys; print(json.load(sys.stdin)['resource']['current_organization'])")

curl -s "https://api.calendly.com/organization_memberships?organization=$ORG_URI&count=50" \
  -H "Authorization: Bearer $CAL_TOKEN" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for m in d['collection']:
    u = m['user']
    print(f'{u["name"]} <{u["email"]}> — role: {m["role"]}')
"
```

---

## Pagination

All list endpoints support pagination:

| Param | Description |
|-------|-------------|
| `count` | Results per page (max 100, default 20) |
| `page_token` | Token from previous response for next page |
| `sort` | Sort field and direction, e.g. `start_time:asc` |

The response includes `pagination.next_page_token` — pass it as `page_token` for the next page. When `null`, you've reached the end.

---

## Common Workflows

### "What meetings do I have this week?"

1. Get user URI from `/users/me`
2. Query `/scheduled_events` with `min_start_time` = now, `max_start_time` = end of week, `status=active`
3. For each event, fetch invitees to show who's attending
4. Format as a daily agenda

### "Who's my next meeting with?"

1. Query upcoming events sorted by `start_time:asc`, `count=1`
2. Fetch invitees for that event
3. Show name, email, time, location, and any custom question answers

### "Cancel my 3pm meeting tomorrow"

1. Query events for tomorrow
2. Find the one at 3pm
3. POST to `/scheduled_events/{uuid}/cancellation` with a reason

### "Create a one-time booking link for John"

1. List event types to find the right one
2. POST to `/scheduling_links` with `max_event_count: 1`
3. Return the `booking_url`

### "When am I free this week?"

1. Query `/user_busy_times` for the next 7 days
2. Get availability schedule for working hours
3. Calculate free slots by subtracting busy times from availability windows
4. Present as available time blocks

### "How many meetings did I have last month?"

1. Query `/scheduled_events` with date range for last month
2. Count total, group by event type
3. Calculate average per week, total hours

### "Show my scheduling links"

1. Query `/event_types` for active types
2. Show name, duration, and `scheduling_url` for each

### "Set up a webhook for new bookings"

1. Get org URI from `/users/me`
2. POST to `/webhook_subscriptions` with `invitee.created` event
3. Return the webhook UUID for management

---

## Formatting Guidelines

When presenting calendar data:

- **Times in user's timezone** — convert from UTC using the user's timezone from `/users/me`
- **Date format**: `Mon Feb 24, 2:30 PM – 3:00 PM EST`
- **Meeting details**: name, attendee(s), location type, duration
- **Group by day** for weekly views
- **Show empty days** as "No meetings" rather than skipping them
- **Free slots**: show as time blocks ("2:00 PM – 4:00 PM available")
- **Invitee responses**: show custom question answers when relevant

### Example agenda format

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

---

## Notes

- **Personal Access Token** is the simplest auth — no OAuth flow needed
- Token page: https://calendly.com/integrations/api_webhooks
- **Rate limit**: 100 requests per 10 seconds per user
- **UUIDs are in URIs** — extract the UUID from the end of the URI string
- **All times are UTC** in API responses — convert to user's timezone for display
- **Pagination**: max 100 results per page, use `page_token` for more
- **Organization-scoped** endpoints need the org URI from `/users/me` → `current_organization`
- **Event type `active: false`** means the link is disabled/hidden
- **Cancellation** is a POST, not a DELETE — it preserves the event record with cancellation details
- **Webhook retries**: Calendly retries failed webhooks with exponential backoff
