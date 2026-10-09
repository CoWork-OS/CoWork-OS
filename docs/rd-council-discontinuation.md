# R&D Council discontinuation

**Decision:** Discontinue R&D Council as of 2026-10-08.

R&D Council scheduled multi-model debates over a curated source bundle and delivered a synthesized memo to a channel. It was one of several ways to run more than one model on a task beside Mixture of Agents presets, collaborative teams, `/multitask`, Multi-LLM judge mode and Comparison mode. We are keeping sub-agent orchestration and Mixture of Agents and removing the overlapping modes.

This decision removes the **Settings > Automations > R&D Council** sub-tab, the Council owner and run history in the Automation Studio Library and Activity views, the `council:*` IPC channels, the `councilMode` and `councilRunId` task fields, the Council synthesis prompt in the team orchestrator, and the Council cron bridge.

**Upgrade data handling:** On first start of a release containing this change, CoWork OS drops the `council_configs`, `council_runs` and `council_memos` tables from the active profile database. The same cleanup runs if an older database is later copied into the profile. A scheduled task that a Council created only held a Council trigger, so it is turned off with a note explaining why and cannot run or be re-enabled until you give it a real prompt; edit or remove it in **Settings > Automations > Scheduled Tasks**. Delivered memos that were already posted to a channel are not affected.

Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
