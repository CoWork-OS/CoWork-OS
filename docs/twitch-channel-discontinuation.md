# Twitch channel discontinuation

**Decision:** Discontinue the Twitch messaging channel as of 2026-10-08.

The Twitch adapter connected CoWork OS to Twitch IRC chat over WebSocket. Live-stream chat is a public, high-volume surface with strict message limits and no attachments, and it does not fit the knowledge-work and coding tasks the other channels serve. We are keeping the channels used for personal, team and enterprise messaging.

This decision removes the Twitch adapter and client, the **Settings > More Channels > Twitch** page, the `addTwitchChannel` gateway, IPC and browser-host paths, the Twitch channel persona, the connector-inventory row and the Twitch channel guide.

**Upgrade data handling:** An existing Twitch channel row in the gateway database is no longer loaded or connected. Remove it from **Settings > Channels** if it is still listed; its OAuth token is stored only in that row and leaves with it. Revoke the token in your Twitch account settings if you no longer use the bot.

Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
