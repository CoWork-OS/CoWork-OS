# Advanced execution overrides discontinuation

**Decision:** Fold the Execute, Analyze, Debug and Verified execution overrides into **Do** as of 2026-10-09. The composer's work choices are **Ask**, **Do** and **Plan**.

Since 0.5.60 the composer offered two work choices, Ask and Do, plus an **Advanced…** menu that pinned one of five runtime strategies for the next message: Execute, Plan, Analyze, Debug or Verified. Do already selects a strategy from the request (the intent router and task strategy service pick full execution, read-only analysis, a verification gate after risky steps, or an evidence-first debugging loop), so four of the five pins duplicated a decision the runtime makes on its own, and the picker had to explain six runtime values to a user who wanted to say "work on it", "just talk" or "plan first". The mode suggestion bar under the composer also proposed Analyze, Verified, Execute and Debug pins from keyword matches.

This decision removes the Advanced… menu and the Execute, Analyze, Debug and Verified pins; **Plan** becomes the third top-level choice next to Ask and Do. `InteractionModeSelection.executionOverride` accepts only `plan`; the validation schema, the browser-host guards and the shared picker agree. The mode suggestion bar now suggests only Plan or a collaborative run. The unused execution-mode label, hint, order and icon tables in the renderer go with the menu.

**What stays:** the runtime execution modes themselves. `execute`, `chat`, `plan`, `analyze`, `verified` and `debug` remain the strategy values the task strategy service assigns, the tool policy engine and prompt sections branch on, worker roles (researchers run in `verified`), the `/cost` estimate (read-only analysis) and the debug session panel. Nothing changes for tasks whose strategy the runtime chose.

**Upgrade data handling:** No database change. Saved sessions and drafts that still carry an `analyze`, `debug`, `verified` or `execute` pin display as **Do** and the runtime chooses the strategy on the next turn; a saved `plan` pin displays as **Plan** and `chat` as **Ask**. Stored `executionMode` values are not rewritten.

Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
