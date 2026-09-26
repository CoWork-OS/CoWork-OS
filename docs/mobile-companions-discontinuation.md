# Mobile Companions discontinuation

**Decision:** Discontinue CoWork OS's Mobile Companions feature as of 2026-09-26.

The iOS and Android companion apps, which connected to the Control Plane as "nodes" for camera, location, screen recording, SMS, and notification actions, are no longer part of the product. Keeping native mobile apps, device permissions, and a separate node protocol working across platforms took sustained effort for a small share of usage. We are focusing development on core agent workflows, integrations, and reliability instead.

This decision removes the Mobile Companions settings tab, the companion token in Control Plane settings, the node role and `node.*` methods and events in the Control Plane protocol, related IPC and shared types, the unregistered `node_*` agent tool definitions, and the companion app source under `mobile/`.

**Upgrade handling:** On first launch of a release containing this change, CoWork OS deletes the separate mobile companion token from the encrypted Control Plane settings. The operator token, remote device connections, Tailscale, and SSH tunnel settings are unchanged. Managed and headless deployments no longer require a companion token, so upgrading does not block them. Settings saved by the new release never store the companion token.

An older companion app that tries to connect is refused with a "Mobile companions have been discontinued" error instead of being authenticated. Users can uninstall the companion app from their phones; its camera, location, and notification permissions are managed by iOS or Android and are removed with the app.

Remote CoWork devices, the Control Plane task API, the web dashboard, and messaging channels such as Telegram, WhatsApp, and Signal remain part of CoWork OS and are the supported ways to reach an agent from a phone. The **Allow LAN Connections** Control Plane option stays available for other CoWork devices on a trusted network. Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
