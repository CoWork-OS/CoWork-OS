# Workflow Intelligence, formerly Subconscious

This page is kept for compatibility with older links.

The user-facing concept is now **Workflow Intelligence**. It combines Memory, Heartbeat, internal Reflection, and reviewable Suggestions into one loop:

- Memory is the source of truth.
- Heartbeat decides when there is enough signal to reflect.
- Reflection evaluates evidence internally.
- Suggestions are the default user-facing output.
- User response teaches future scoring.

See the canonical architecture guide: [Workflow Intelligence](workflow-intelligence.md).

Implementation note: some internal names still use `Subconscious` for compatibility, including `.cowork/subconscious/`, `SubconsciousLoopService`, and legacy SQLite table names.
