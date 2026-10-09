# Supermemory discontinuation

**Decision:** Discontinue the Supermemory external memory provider as of 2026-10-09.

Supermemory was an optional, opt-in external lane beside CoWork's local memory: a profile and search block injected into prompts, an `external` scope in `memory_recall`, `memory_remember` and `memory_forget`, best-effort mirroring of non-private archive memories to the Supermemory API, remote-copy tracking so local deletes could forget the mirror, and a Connections card in Memory settings. Since 0.5.60 the memory folder is where CoWork keeps what it knows, and a second, remote store doubled the privacy surface (an API key in settings, copies of memories leaving the device, orphan sweeps to keep them in sync) for a lane almost nobody turned on.

This decision removes the Supermemory service and remote-copy store, the external memory provider abstraction and its prompt section, the `external` recall lane and tool scope, the external write target and `external_only` approval mode of the memory write gate, the `supermemory` source in Mission Control recall, the Supermemory rows in the Memory Hub Sources tab, the Connections card, the `supermemory:*` IPC channels and shared types, and the Supermemory guide.

**Upgrade data handling:** On first start of a release containing this change, CoWork OS deletes the `supermemory` settings row (the API key, container template and switches) from the active profile database and drops the `supermemory_remote_refs` table. The same cleanup runs if an older database is later copied into the profile. Memories that were mirrored to Supermemory are **not** deleted there, because CoWork no longer holds the credentials or the remote ids; remove them in your Supermemory account if you no longer want them. A saved `COWORK_MEMORY_WRITE_APPROVAL_MODE=external_only` or the matching setting now behaves like `off`. Local memory, the memory folder, Dreaming, the archive and the knowledge graph are unchanged.

Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
