# Everyday Agent discontinuation

**Decision:** Discontinue the Everyday Agent surface as of 2026-10-08.

Everyday Agent was an opt-in consent, trust-pattern and receipt layer with its own page under **More > Everyday**, a Settings tab, a Home card, a Mission Control focus mode and an admin-policy section. It never had an executor of its own, and the policy it compiled was not read by the task runtime, the tool-policy pipeline, routines or managed agents. Keeping a second consent model beside access profiles and approvals made the app harder to explain without changing what tasks were allowed to do. We are focusing on the task workspace, access profiles, Bots and Automations instead.

This decision removes the Everyday page, the Settings tab, the Home card, the Mission Control focus chip, the `everydayAgent` admin-policy section, the `everydayAgent.*` Control Plane methods, the browser-host methods, the IPC channels and shared types, and the feature documentation.

**Upgrade data handling:** On first start of a release containing this change, CoWork OS drops the `everyday_agent_*` tables (profile, consent history, pause scopes, receipts, previews, trust patterns, connector summaries, browser-profile metadata, routine provenance and task links) from the active profile database. The same cleanup runs if an older database is later copied into the profile. An `everydayAgent` section in an existing `admin-policies.json` is ignored. The managed agent preset named **Everyday Agent** that enabling consent created is an ordinary bot and is left in place; remove it from the Bots page if you no longer want it.

Access profiles, approval workflows, hard guardrails, Workflow Intelligence suggestions and core memory candidates are unchanged. Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
