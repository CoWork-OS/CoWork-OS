# Twitch channel discontinuation

**Decision:** Discontinue the Twitch messaging channel as of 2026-10-08.

The Twitch adapter connected CoWork OS to Twitch IRC chat over WebSocket. Live-stream chat is a public, high-volume surface with strict message limits and no attachments, and it does not fit the knowledge-work and coding tasks the other channels serve. We are keeping the channels used for personal, team and enterprise messaging.

This decision removes the Twitch adapter and client, the **Settings > More Channels > Twitch** page, the `addTwitchChannel` gateway, IPC and browser-host paths, the Twitch channel persona, the connector-inventory row and the Twitch channel guide.

**Upgrade data handling:** On first start of a release containing this change, CoWork OS deletes any leftover Twitch channel from the gateway database: its configuration and stored OAuth token, its pairings and sessions, and its channel message log. Tasks that Twitch chat created are ordinary tasks and stay in your task history. A scheduled task that delivered its results to Twitch keeps running on its schedule with delivery turned off, and shows a note saying why; choose another channel to receive its results. CoWork OS can no longer revoke the bot's token, so revoke it yourself on twitch.tv under **Settings > Connections** (or the Twitch developer console if you registered your own app).

Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
