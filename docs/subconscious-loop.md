# Workflow Intelligence, formerly Subconscious

This page is kept for compatibility with older links.

The user-facing concept is now **Workflow Intelligence**. It combines Memory, Heartbeat, internal Reflection, Dreaming, and reviewable Suggestions into one loop:

- Memory is the source of truth.
- Heartbeat decides when there is enough signal to reflect.
- Reflection evaluates evidence internally.
- Dreaming tidies the memory folder about once a day, with changes to your own notes left for review.
- Suggestions are the default user-facing output.
- User response teaches future scoring.

See the canonical architecture guide: [Workflow Intelligence](workflow-intelligence.md).

Implementation note: some internal names still use `Subconscious` for compatibility, including `.cowork/subconscious/`, `SubconsciousLoopService`, and legacy SQLite table names.
