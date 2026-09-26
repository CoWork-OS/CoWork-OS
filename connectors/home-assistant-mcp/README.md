# Home Assistant MCP Connector

Bundled CoWork OS connector for a local or remote Home Assistant instance, using the [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/).

Tools:

- `home-assistant.health`: reachability, token check, version, and the current service-call allowlist
- `home-assistant.list_entities`: list or search entities with their current state
- `home-assistant.get_state`: one entity's state and attributes
- `home-assistant.list_services`: available services and fields, marked allowlisted or blocked
- `home-assistant.call_service`: call a service on explicit entities

Environment:

- `HOME_ASSISTANT_URL`: instance URL, e.g. `http://homeassistant.local:8123`
- `HOME_ASSISTANT_TOKEN`: long-lived access token (Home Assistant profile > Security)
- `HOME_ASSISTANT_ALLOWED_DOMAINS`: comma-separated domains the agent may control, e.g. `light,switch,climate`
- `HOME_ASSISTANT_ALLOWED_ENTITIES`: comma-separated entity IDs or `*` patterns, e.g. `lock.front_door,switch.fan_*`
- `HOME_ASSISTANT_TIMEOUT_MS`: optional request timeout (default 15000)

## Safety model

Reading states and services works as soon as the URL and token are set. Service calls are **off until you allowlist something**:

- An entity may be targeted when its domain is in `HOME_ASSISTANT_ALLOWED_DOMAINS` or it matches `HOME_ASSISTANT_ALLOWED_ENTITIES`.
- Every call must name explicit `entityIds`. Area, device, label and "all" targets are rejected, so one call cannot fan out to devices you did not list.
- Domains that run code, stop or reconfigure Home Assistant, or delete history (`shell_command`, `python_script`, `hassio`, `recorder`, `backup`, and similar) are always blocked. From the `homeassistant` domain only `turn_on`, `turn_off`, `toggle` and `update_entity` are allowed.
- Each call is still an MCP tool call, so CoWork's normal approval policy applies on top of the allowlist.
- Services on `lock`, `alarm_control_panel`, `cover`, `valve` and `siren` entities (including generic `homeassistant.toggle` on them) also need `confirm: true`, which the agent may set only after the user agrees to that exact action. This still holds if the user has an "always allow" approval rule for the connector.
- `target` objects and area/device IDs inside `data` are rejected, so targets always come from `entityIds`.

Use a dedicated Home Assistant user with a non-admin token where possible. `home-assistant.health` warns when `HOME_ASSISTANT_URL` is plain HTTP to a non-loopback host, because the token then crosses the network unencrypted.
