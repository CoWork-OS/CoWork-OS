# X integration discontinuation

**Decision:** Discontinue the X (Twitter) integration as of 2026-10-08.

The X integration had three parts: mention-triggered task ingress through the Bird CLI (bridge mode) or a native `x` gateway channel, the `x_action` agent tool that read, searched and posted through the connected account with a browser-automation fallback, and the **Settings > More Channels > X (Twitter)** page that stored browser or manual cookies. Scraping X through injected browser scripts is fragile and exposed to X's terms of service, and public mention intake does not fit the knowledge-work and coding tasks the other channels serve.

This decision removes the mention bridge service, the `x` channel adapter, the `x_action` tool and its browser scripts, the X settings page, the `x:*` IPC channels, the `addXChannel` gateway, IPC and browser-host paths, the X composer mention, the X channel persona and the X mention trigger guides. The gateway now lists 17 channels.

**Kept:** the read-only `x_search` tool, which searches X through xAI's API with your Grok OAuth or xAI API key and never touched the X account or cookies, and the bundled `bird` and `twitter` skills, which drive their own command-line tools.

**Upgrade data handling:** On first start of a release containing this change, CoWork OS deletes the `x` settings row (cookie source, manual `auth_token` and `ct0` cookies, mention-trigger settings) from the active profile database. The same cleanup runs if an older database is later copied into the profile. An existing `x` channel row in the gateway database is no longer loaded or offered as a delivery channel. Tasks that mentions created are ordinary tasks and are kept.

Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
