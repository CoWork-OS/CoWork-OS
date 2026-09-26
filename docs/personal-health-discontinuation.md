# Personal Health discontinuation

**Decision:** Discontinue CoWork OS's personal Health feature as of 2026-09-26.

The Health dashboard, Apple Health import and sync flows, and the macOS HealthKit bridge are no longer part of the product. HealthKit provisioning and device setup added substantial platform-specific work, while health records require sustained privacy and data-handling care. We are focusing development on core agent workflows, integrations, and reliability instead.

This decision removes the Health navigation and settings UI, related IPC and shared types, native HealthKit helper source, build and packaging steps, and feature documentation.

**Upgrade data handling:** On first launch of a release containing this change, CoWork OS deletes the retired encrypted Health settings category, including any unreadable-row backup in the active profile database. The same cleanup runs if an older database is later copied into the profile. Settings backups created by the new release omit Health, and restoring an older settings backup skips it. On macOS, startup also removes request and response files left in temporary folders by older HealthKit bridge launches. Anyone who needs information from an older CoWork Health view should save it before upgrading. This cleanup does not alter the original Apple Health library, source files imported from elsewhere, or independent system backups.

The mobile companion apps never included Health features; they were discontinued separately (see [Mobile Companions discontinuation](mobile-companions-discontinuation.md)). The HealthKit bridge was a macOS helper app bundled with CoWork OS (shown as "CoWork Health Sync"); upgrading removes it from the app bundle. Apple Health authorization that the operating system granted to that helper can outlive it, so users who connected Apple Health should revoke the helper's access in Apple's Health privacy settings.

Operational health checks for services, connectors, and the workspace kit remain part of CoWork OS. Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
