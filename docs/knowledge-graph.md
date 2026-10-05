# Knowledge Graph System

CoWork OS includes a built-in knowledge graph that provides structured entity and relationship memory for the agent. Unlike flat-text memory, the knowledge graph stores typed entities, directed relationships, timestamped observations, and optional temporal validity windows in a normalized SQLite schema with full-text search.

Graph extraction, search, and memory promotion run beneath the task's [access
profile](access-profiles.md). A graph result is context, not a permission
grant: it cannot widen filesystem, command-tool, network, connector, or export
access, and background extraction skips or fails closed when the profile does
not permit the required read path.

## Architecture

```
Agent Task Execution
    |
    v
+---------------------------+     +---------------------------+
| Auto-Extraction Hook      | --> | KnowledgeGraphService     |
| (executor.ts post-task)   |     | (business logic + search) |
+---------------------------+     +---------------------------+
                                          |
                                          v
                                  +---------------------------+
                                  | KnowledgeGraphRepository  |
                                  | (SQLite CRUD + FTS5)      |
                                  +---------------------------+
                                          |
                                          v
                                  +---------------------------+
                                  | 4 Tables + FTS5 vtable    |
                                  | (kg_entity_types,         |
                                  |  kg_entities, kg_edges,   |
                                  |  kg_observations)         |
                                  +---------------------------+
```

## Schema

### Entity Types (`kg_entity_types`)

Defines the vocabulary of entity types. 10 built-in types are seeded per workspace on startup. Users and agents can create custom types.

**Built-in types:**

| Type           | Icon                   | Description                                |
| -------------- | ---------------------- | ------------------------------------------ |
| person         | :bust_in_silhouette:   | A person or individual                     |
| organization   | :office:               | A company, team, or organization           |
| project        | :file_folder:          | A project or initiative                    |
| technology     | :gear:                 | A programming language, framework, or tool |
| concept        | :bulb:                 | An abstract idea, pattern, or principle    |
| file           | :page_facing_up:       | A file or document in the codebase         |
| service        | :wrench:               | A running service, microservice, or daemon |
| api_endpoint   | :electric_plug:        | An API endpoint or route                   |
| database_table | :card_file_box:        | A database table or collection             |
| environment    | :globe_with_meridians: | A deployment environment                   |

### Entities (`kg_entities`)

Core nodes in the graph. Each entity has a type, name, optional description, flexible JSON properties, confidence score (0-1), and source tracking (`source`: who created it, raised to the highest-precedence writer that later confirmed it; `description_source`: who wrote the current description; `last_seen_at`: last reinforcement).

**Names are unique case-insensitively.** `normalized_name` (NFKC, whitespace collapsed, lower-cased) has a unique index on `(workspace_id, entity_type_id, normalized_name)`, so `Go`, `go` and `GO` are one entity; any casing finds it on upsert. The schema upgrade that adds the column backfills it and first merges existing case duplicates: the canonical entity is the one with the highest source precedence (then the most edges and observations, then the oldest); edges and observations move to it (self-loops and duplicate current edges are dropped, duplicate observations removed), the best description by source precedence is kept, properties merge with the higher-precedence source winning, and contact identities pointing at a merged entity are re-pointed. Known technologies keep their canonical casing (`Electron`, not `electron`).

### Edges (`kg_edges`)

Typed directed relationships between entities.

**Built-in edge types (15):**
`uses`, `depends_on`, `part_of`, `created_by`, `maintained_by`, `deployed_to`, `connects_to`, `extends`, `implements`, `references`, `owns`, `belongs_to`, `related_to`, `blocked_by`, `replaced_by`

Custom edge types are also supported.

Edges can also carry:

- `valid_from`: when the relationship became true
- `valid_to`: when the relationship stopped being current

Current facts are protected by a partial unique index on `(workspace_id, source_entity_id, target_entity_id, edge_type)` where `valid_to IS NULL`. Historical edges are allowed, but overlapping intervals for the same directed relation are rejected.

### Observations (`kg_observations`)

Timestamped facts or notes attached to entities. Append-only log that tracks changes and discoveries over time, without repeats: an observation whose `fingerprint` (a mailbox event's, otherwise a hash of the normalized text) or text already exists on the entity is not added again; the existing one is returned (and adopted by a higher-precedence writer). A new observation reinforces its entity.

## Search Capabilities

### Full-Text Search (FTS5)

Entity names and descriptions are indexed in an FTS5 virtual table with BM25 ranking. Auto-sync triggers keep the index updated on INSERT, UPDATE, and DELETE.

### Graph Traversal

Neighbors can be retrieved up to 3 hops deep using iterative BFS traversal with optional edge type filtering. Subgraph queries return all entities and connecting edges for a given set of entity IDs. Both traversal paths can optionally filter by historical `as_of` timestamp, so the graph can answer “what was true then?” instead of only “what is true now?”

### LIKE Fallback

If FTS5 is unavailable (rare SQLite builds), search falls back to `LIKE` pattern matching with confidence-based ranking.

## Auto-Extraction

After each successful task, the executor calls `KnowledgeGraphService.extractEntitiesFromTaskResult()` which uses pattern matching (no LLM) to identify:

- **Technologies:** a fixed list of frameworks, languages and tools (rules in `knowledge-graph/kg-extraction.ts`)
- **File paths:** Source file references matching common patterns (src/, lib/, app/, etc.)
- **API endpoints:** upper-case HTTP method + path (GET /api/users, POST /auth/login, etc.)

Auto-extracted entities are stored with `source='auto'` and `confidence=0.85`.

### Technology extraction rules

Technology names are matched with three levels of precision, and never inside a path, URL or dotted identifier (`src/electron/main.ts` is not "Electron"):

| Level | Names | Matched when |
| --- | --- | --- |
| Distinctive | TypeScript, JavaScript, Node.js, Next.js, Python, Docker, Kubernetes, PostgreSQL (Postgres), MongoDB, Redis, GraphQL, Webpack, FastAPI, Django, SQLite | any casing; stored in canonical casing |
| Exact casing | Vue, Vite, Angular, Electron, Flask, Tailwind, REST (RESTful) | only as written ("REST API", not "a restful weekend") |
| Ambiguous English words | Go, Rust, Express, React | only in a code-ish context: inline code (`` `go` ``), an import / `require` / `npm install` of the package, a file name (`main.go`, `Cargo.toml`), a shell command (`go build`, `cargo test`), a dotted version (`Go 1.22`, `React 18`), "using X" / "written in X", or a technical noun after the name ("Go module", "Express server", "React component") |

So "let's go ahead and rest; express our thanks and react calmly" extracts nothing.

### Mailbox ingest

`KnowledgeGraphService.ingestMailboxEvent()` (called by `MailboxAutomationHub`) adds the contact (person), their organization, a project hint and one observation per entity:

- Free-mail, personal-ISP and relay domains (gmail.com, googlemail.com, outlook / hotmail / live / msn, yahoo, icloud.com, me.com, proton, gmx, yandex, aol, zoho, privaterelay.appleid.com, users.noreply.github.com, ...) never become an organization or a `works_at` edge.
- The organization is named after the registrable domain, not the first label: `news.amazon.com` → "Amazon", `mail.acme.co.uk` → "Acme". An explicit `company` / `organization` in the event wins.
- Automated senders (noreply, notifications, bounces, newsletters, ...) do not become people; their organization still gets the observation.
- Each event adds its observation once per entity (fingerprint `mailbox:<type>:<event fingerprint>`), however often it is delivered.

## Source Precedence

Writers rank **manual > agent (`kg_*` tools) > auto (extraction, mailbox)**:

- An upsert or update never replaces a description written by a higher-precedence source; the rest of the write (properties, confidence) still applies, and `kg_update_entity` says when it kept the description.
- On upsert, properties merge with the higher-precedence source winning on conflicting keys.
- An entity's `source` is raised to the highest writer that confirmed it, so an agent-confirmed entity is no longer decayed or eligible for cleanup.

## Memory Settings

Automatic writes (task extraction and mailbox ingest) respect the workspace's memory settings: nothing is written when memory is off (`enabled = 0`) or `privacyMode` is `disabled`, or when the task prompt, result or mail text carries `<no-memory>`. If the settings cannot be read, automatic writes are skipped. Explicit `kg_*` tool writes (`kg_create_entity`, `kg_update_entity`, `kg_create_edge`, `kg_add_observation`) may proceed with memory off, as the user asked for them, but are refused in a task that opted out with `<no-memory>` (or whose content carries it). Reads and deletes are never blocked.

## Confidence Scoring & Decay

- **Manual entities:** confidence 1.0 (default)
- **Agent-created entities:** confidence 1.0
- **Auto-extracted entities:** confidence 0.85

Confidence decay runs at most once a day per workspace (after task extraction) for auto-extracted entities not **reinforced** for 30 days. Reinforcement (`last_seen_at`) is set on creation, on every upsert or update, and when a new observation is added; decay keys on it rather than on `created_at`, so an entity that keeps being seen keeps its confidence. Decay changes only `confidence`: it does not touch `updated_at`.

- Decay rate: 0.95 per run (5% reduction each cycle)
- Floor: 0.3 (entities never decay below this)
- Manual and agent entities never decay

When an entity is created again (upsert), its confidence is boosted by 0.1 (capped at 1.0).

## One-Time Cleanup

`KnowledgeGraphCleanup.ts` removes the noise the old extraction left, once per profile: it runs two minutes after startup (`KnowledgeGraphService.initialize`), is claimed through `maintenance-claim-sql.ts` so the desktop app and the node daemon never run it together, and records the marker `kg_quality_cleanup_v1` in `maintenance_state` with its counts (also logged). Each phase is idempotent and one transaction:

1. merge case duplicates (as above);
2. delete automatic technology entities that are ambiguous English words (`go`, `rust`, `express`, `react`) or English-word names in a casing extraction no longer accepts (`rest`, `electron`);
3. delete free-mail / relay organizations (by stored domain, or by name for mailbox rows without one) and the automatic `works_at` edges to them;
4. rename organizations the old ingest named after a mail subdomain ("News" from `news.amazon.com`, "Accounts" from `accounts.google.com`) to the registrable label, merging into an existing organization of that name;
5. delete the person entities the old ingest made of automated senders (mailbox rows whose `email` property, or "Email contact …" description, is a noreply, notifications, bounce, newsletter, news, alerts or updates address), with their edges and observations;
6. delete duplicate observations (same normalized text on one entity; the highest-precedence source, then the oldest, is kept).

Deletions only touch `source = 'auto'` entities that no manual or agent edge or observation references; manual and agent entities are never deleted (a case duplicate is merged into its canonical entity instead).

## Context Injection

`KnowledgeGraphService.buildContextForTask()` searches the knowledge graph for entities relevant to a task prompt and builds a formatted context string:

```
KNOWLEDGE GRAPH (known entities and relationships):
- [technology] React: Frontend framework (->uses TypeScript; ->part_of frontend-app)
- [service] auth-service: Authentication microservice (->connects_to PostgreSQL)
```

This context is capped at 5 entities and 1,500 characters. It is **not** injected into the default prompt: with wake-up layers on (the default, `wakeUpLayersEnabled`), memory synthesis excludes the knowledge graph. It is only used by the legacy synthesis path when wake-up layers are turned off. Agents reach the graph through the `kg_*` tools instead. When temporal knowledge is enabled, task-context building uses only currently valid edges by default.

## Agent Tools (10)

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `kg_create_entity`   | Create or update an entity with type, name, description, and properties                     |
| `kg_update_entity`   | Update an entity's description, properties, or confidence                                   |
| `kg_delete_entity`   | Delete an entity (cascades to edges and observations)                                       |
| `kg_create_edge`     | Create a typed relationship between two entities, optionally with `valid_from` / `valid_to` |
| `kg_delete_edge`     | Remove a relationship                                                                       |
| `kg_invalidate_edge` | Close an active relationship without deleting its history                                   |
| `kg_add_observation` | Append a timestamped observation to an entity                                               |
| `kg_search`          | Full-text search with optional type filtering                                               |
| `kg_get_neighbors`   | Get connected entities up to 3 hops deep, optionally `as_of` a historical timestamp         |
| `kg_get_subgraph`    | Get entities and edges for a set of entity IDs, optionally `as_of` a historical timestamp   |

## Usage & Testing

You can interact with the knowledge graph by giving the agent natural-language prompts. The 10 `kg_*` tools are registered when the knowledge graph service is initialized. The read tools (`kg_search`, `kg_get_neighbors`, `kg_get_subgraph`) are in the memory lane and load on demand through tool search; the write tools are exposed conditionally. All `kg_*` tools are blocked in group and public channel contexts, and the write tools count as writes in plan, analyze and verifier modes.

### Creating Entities and Relationships

Try prompts like:

- **"Create a knowledge graph of our project stack: we use React for the frontend, Node.js with Express for the backend, PostgreSQL for the database, and Redis for caching. The frontend depends on the backend, and the backend connects to both PostgreSQL and Redis."**
- **"Add a person entity for Sarah — she's the tech lead who maintains the auth-service and the payments API."**
- **"Track that we just upgraded from React 17 to React 18 and migrated from Webpack to Vite."** (creates entities + observations)
- **"Track that Redis stopped being part of the stack last month without deleting the old history."** (uses `kg_invalidate_edge`)

### Searching and Querying

- **"Search the knowledge graph for everything related to authentication."**
- **"What technologies do we use? Search the knowledge graph."**
- **"Show me all entities connected to the auth-service and what depends on it."** (uses `kg_get_neighbors`)
- **"Show me what the backend graph looked like on January 15, 2026."** (uses `as_of`)

### Adding Observations

- **"Add an observation to PostgreSQL: experiencing high query latency on the users table since Tuesday."**
- **"Note on the auth-service: migrated from JWT to session-based auth last sprint."**

### Graph Exploration

- **"Get a subgraph of our backend architecture — include the backend service, PostgreSQL, Redis, and the API endpoints."**
- **"What is connected to React? Show me 2 hops deep."**

### Auto-Extraction (Passive)

The knowledge graph also grows passively. After each completed task, the system automatically extracts:

- Technology mentions (React, TypeScript, Docker, etc.)
- File paths referenced in the task (src/components/App.tsx, etc.)
- API endpoints (GET /api/users, POST /auth/login, etc.)

These auto-extracted entities appear with `confidence=0.85` and decay over time if not reinforced. Ambiguous names (Go, Rust, Express, React) are only picked up from code-ish context, so prose such as "let's go" adds nothing.

## Privacy & Isolation

- All entities and relationships are workspace-scoped, and every tool operation (get, update, delete, edges, observations, search, neighbors, subgraph) is filtered by the active workspace; IDs from another workspace are not found
- Entity types are per-workspace (built-in types are seeded per workspace)
- Result sizes are capped: `kg_search` returns at most 50 results, neighbor traversal at most 3 hops and 200 results, subgraphs at most 100 entities and 1,000 edges, observations at most 100
- Deleting a task removes KG observations and edges it created (and entities left orphaned); **Clear All Memories** removes the workspace's graph

## Comparison with ClawHub Ontology

| Capability             | ClawHub Ontology    | CoWork OS Knowledge Graph                   |
| ---------------------- | ------------------- | ------------------------------------------- |
| **Storage**            | Flat JSON file      | SQLite with 4 normalized tables             |
| **Search**             | Linear scan         | FTS5 full-text search with BM25 ranking     |
| **Graph traversal**    | Manual JSON parsing | Iterative BFS queries (up to 3 hops)        |
| **Entity types**       | Fixed schema        | 10 built-in + user-extensible               |
| **Edge types**         | Basic relationships | 15 built-in typed relationships + custom    |
| **Observations**       | None                | Append-only timestamped fact log per entity |
| **Auto-extraction**    | None                | Regex-based extraction from task results    |
| **Confidence scoring** | None                | 0-1 confidence with time-based decay        |
| **Deduplication**      | None                | Upsert on (workspace, type, case-insensitive name); observation fingerprints |
| **Context injection**  | Manual tool use     | Tool-driven (`kg_*`); not in the default prompt |
| **Multi-workspace**    | Single file         | Per-workspace isolation                     |
| **Privacy**            | None                | Automatic writes respect workspace memory settings and `<no-memory>` |
| **Agent tools**        | ~3 basic            | 10 comprehensive tools                      |
| **Subgraph queries**   | None                | Multi-entity subgraph extraction            |
| **Cascade deletes**    | Manual cleanup      | Automatic via FK constraints + transactions |
