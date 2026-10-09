# First-task beta discontinuation

**Decision:** Discontinue the first-task beta as of 2026-10-09.

The first-task beta was a flag-gated onboarding experiment: a compact first-run screen, a bundled "release brief" sample mission with fixture files and a packaged checker, a revision contract for the sample, a model preflight probe, and a "was this useful" prompt after the first real task. It shipped only in builds with `VITE_FIRST_TASK_BETA=1`, never in a stable installer, and it kept a parallel onboarding path, an internal access profile and three database tables alive for a flow nobody could reach.

This decision removes the first-task module, the first-run screen, the sample mission card, the real-work feedback prompt, the bundled `release-brief-v1` fixture and its packaging step, the `firstTask:*` IPC channels, the internal `release_brief_sample` access profile and the `sample` task source, the Vite beta flag, and the beta guide. The ordinary onboarding flow and the starter missions on the welcome screen stay.

**Upgrade data handling:** On first start of a release containing this change, CoWork OS drops the `first_task_setup`, `first_task_attempts` and `first_task_real_work` tables from the active profile database. The same cleanup runs if an older database is later copied into the profile. Any sample task a beta build created is an ordinary task and is kept.

Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
