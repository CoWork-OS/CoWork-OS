# Knowledge Graph System

CoWork OS includes a built-in knowledge graph that provides structured entity and relationship memory for the agent. Unlike flat-text memory, the knowledge graph stores typed entities, directed relationships, and timestamped observations in a normalized SQLite schema with full-text search.

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

| Type | Icon | Description |
|------|------|-------------|
| person | :bust_in_silhouette: | A person or individual |
| organization | :office: | A company, team, or organization |
| project | :file_folder: | A project or initiative |
| technology | :gear: | A programming language, framework, or tool |
| concept | :bulb: | An abstract idea, pattern, or principle |
| file | :page_facing_up: | A file or document in the codebase |
| service | :wrench: | A running service, microservice, or daemon |
| api_endpoint | :electric_plug: | An API endpoint or route |
| database_table | :card_file_box: | A database table or collection |
| environment | :globe_with_meridians: | A deployment environment |

### Entities (`kg_entities`)
Core nodes in the graph. Each entity has a type, name, optional description, flexible JSON properties, confidence score (0-1), and source tracking.

**Unique constraint:** `(workspace_id, entity_type_id, name)` ensures no duplicate entities of the same type and name within a workspace.

### Edges (`kg_edges`)
Typed directed relationships between entities.

**Built-in edge types (15):**
`uses`, `depends_on`, `part_of`, `created_by`, `maintained_by`, `deployed_to`, `connects_to`, `extends`, `implements`, `references`, `owns`, `belongs_to`, `related_to`, `blocked_by`, `replaced_by`

Custom edge types are also supported.

**Unique constraint:** `(workspace_id, source_entity_id, target_entity_id, edge_type)` prevents duplicate edges.

### Observations (`kg_observations`)
Timestamped facts or notes attached to entities. Append-only log that tracks changes and discoveries over time.

## Search Capabilities

### Full-Text Search (FTS5)
Entity names and descriptions are indexed in an FTS5 virtual table with BM25 ranking. Auto-sync triggers keep the index updated on INSERT, UPDATE, and DELETE.

### Graph Traversal
Neighbors can be retrieved up to 3 hops deep using iterative BFS traversal with optional edge type filtering. Subgraph queries return all entities and connecting edges for a given set of entity IDs.

### LIKE Fallback
If FTS5 is unavailable (rare SQLite builds), search falls back to `LIKE` pattern matching with confidence-based ranking.

## Auto-Extraction

After each successful task, the executor calls `KnowledgeGraphService.extractEntitiesFromTaskResult()` which uses regex-based pattern matching to identify:

- **Technologies:** Common frameworks, languages, and tools (React, Node.js, TypeScript, Docker, etc.)
- **File paths:** Source file references matching common patterns (src/, lib/, app/, etc.)
- **API endpoints:** HTTP method + path patterns (GET /api/users, POST /auth/login, etc.)

Auto-extracted entities are stored with `source='auto'` and `confidence=0.85`.

## Confidence Scoring & Decay

- **Manual entities:** confidence 1.0 (default)
- **Agent-created entities:** confidence 1.0
- **Auto-extracted entities:** confidence 0.85

Confidence decay runs periodically for auto-extracted entities older than 30 days:
- Decay rate: 0.95 per run (5% reduction each cycle)
- Floor: 0.3 (entities never decay below this)

When an entity is created again (upsert), its confidence is boosted by 0.1 (capped at 1.0).

## Context Injection

`KnowledgeGraphService.buildContextForTask()` searches the knowledge graph for entities relevant to a task prompt and builds a formatted context string:

```
KNOWLEDGE GRAPH (known entities and relationships):
- [technology] React: Frontend framework (->uses TypeScript; ->part_of frontend-app)
- [service] auth-service: Authentication microservice (->connects_to PostgreSQL)
```

This context is available for injection into the agent's system prompt alongside playbook and memory context.

## Agent Tools (9)

| Tool | Description |
|------|-------------|
| `kg_create_entity` | Create or update an entity with type, name, description, and properties |
| `kg_update_entity` | Update an entity's description, properties, or confidence |
| `kg_delete_entity` | Delete an entity (cascades to edges and observations) |
| `kg_create_edge` | Create a typed relationship between two entities |
| `kg_delete_edge` | Remove a relationship |
| `kg_add_observation` | Append a timestamped observation to an entity |
| `kg_search` | Full-text search with optional type filtering |
| `kg_get_neighbors` | Get connected entities up to 3 hops deep |
| `kg_get_subgraph` | Get entities and edges for a set of entity IDs |

## Usage & Testing

You can interact with the knowledge graph by giving the agent natural-language prompts. The agent has access to all 9 `kg_*` tools and will use them based on your request.

### Creating Entities and Relationships

Try prompts like:

- **"Create a knowledge graph of our project stack: we use React for the frontend, Node.js with Express for the backend, PostgreSQL for the database, and Redis for caching. The frontend depends on the backend, and the backend connects to both PostgreSQL and Redis."**
- **"Add a person entity for Sarah — she's the tech lead who maintains the auth-service and the payments API."**
- **"Track that we just upgraded from React 17 to React 18 and migrated from Webpack to Vite."** (creates entities + observations)

### Searching and Querying

- **"Search the knowledge graph for everything related to authentication."**
- **"What technologies do we use? Search the knowledge graph."**
- **"Show me all entities connected to the auth-service and what depends on it."** (uses `kg_get_neighbors`)

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

These auto-extracted entities appear with `confidence=0.85` and decay over time if not reinforced.

## Privacy & Isolation

- All entities and relationships are workspace-scoped
- Entity types are per-workspace (built-in types are seeded per workspace)
- Inherits workspace-level privacy and security settings
- No cross-workspace data leakage

## Comparison with ClawHub Ontology

| Capability | ClawHub Ontology | CoWork OS Knowledge Graph |
|------------|-----------------|--------------------------|
| **Storage** | Flat JSON file | SQLite with 4 normalized tables |
| **Search** | Linear scan | FTS5 full-text search with BM25 ranking |
| **Graph traversal** | Manual JSON parsing | Iterative BFS queries (up to 3 hops) |
| **Entity types** | Fixed schema | 10 built-in + user-extensible |
| **Edge types** | Basic relationships | 15 built-in typed relationships + custom |
| **Observations** | None | Append-only timestamped fact log per entity |
| **Auto-extraction** | None | Regex-based extraction from task results |
| **Confidence scoring** | None | 0-1 confidence with time-based decay |
| **Deduplication** | None | Upsert on (workspace, type, name) |
| **Context injection** | Manual tool use | Auto-injected into task system prompts |
| **Multi-workspace** | Single file | Per-workspace isolation |
| **Privacy** | None | Inherits workspace memory privacy settings |
| **Agent tools** | ~3 basic | 9 comprehensive tools |
| **Subgraph queries** | None | Multi-entity subgraph extraction |
| **Cascade deletes** | Manual cleanup | Automatic via FK constraints + transactions |
