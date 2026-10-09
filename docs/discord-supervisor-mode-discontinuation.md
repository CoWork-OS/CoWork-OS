# Discord supervisor mode discontinuation

**Decision:** Discontinue Discord supervisor mode as of 2026-10-09.

Supervisor mode ran a strict protocol between two CoWork agents over a dedicated Discord coordination channel: a worker posted status, review requests and evidence, a supervisor acknowledged or escalated, and escalations were mirrored into the activity feed with a resolve action. It needed a second bot, peer bot allowlists, watched channels and a `SUPERVISOR.md` policy file in the workspace kit, and it was the only reason the Discord adapter forwarded messages from other bots. Bots, Mission Control and the approval system cover supervision without a Discord-specific protocol.

This decision removes the supervisor service and exchange store, the supervisor section of the Discord settings page, the `supervisor` Discord channel config and `discordSupervisor` add-channel field, the `supervisorExchange:*` IPC channels and types, the `supervisor_exchange` activity type and its resolve button, the bot-message forwarding in the Discord adapter, the `SUPERVISOR.md` workspace kit file, and the supervisor guide.

**Upgrade data handling:** On first start of a release containing this change, CoWork OS drops the `supervisor_exchanges` and `supervisor_exchange_messages` tables from the active profile database. The same cleanup runs if an older database is later copied into the profile. A `supervisor` block left in a saved Discord channel config is ignored. Existing `.cowork/SUPERVISOR.md` files in workspaces are not touched; they are no longer read, and you can delete them.

Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
