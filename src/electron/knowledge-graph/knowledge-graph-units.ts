import type Database from "better-sqlite3";
import {
  defineReadUnit,
  defineUnit,
  type UnitCatalog,
} from "../database/statements/statement-catalog";
import {
  fields,
  int,
  json,
  num,
  oneOf,
  opt,
  str,
  strList,
  tuple,
} from "../database/statements/unit-args";
import { KnowledgeGraphStore } from "./knowledge-graph-sql";

/**
 * Knowledge graph transaction units (async SQLite migration plan, DB6), part of the
 * memory domain. Each runs one `KnowledgeGraphStore` method against the connection it is
 * given, so the method's reads and writes share one transaction (a snapshot for reads).
 */

const SOURCES = ["manual", "auto", "agent"] as const;
const source = (value: unknown, path: string) => oneOf(value, path, SOURCES);
const id = (value: unknown, path: string) => str(value, path, 512);
const text = (value: unknown, path: string) => str(value, path, 100_000);
const properties = (value: unknown, path: string) => json(value, path) as Record<string, unknown>;

const entityInput = (value: unknown) =>
  fields({
    entityType: text,
    name: text,
    description: opt(text),
    properties: opt(properties),
    confidence: opt(num),
  })(value);

const edgeInput = (value: unknown) =>
  fields({
    sourceEntityId: id,
    targetEntityId: id,
    edgeType: text,
    properties: opt(properties),
    confidence: opt(num),
    validFrom: opt(num),
    validTo: opt(num),
  })(value);

const observationInput = (value: unknown) => fields({ entityId: id, content: text })(value);

const store = (db: Database.Database) => new KnowledgeGraphStore(db);

export const KNOWLEDGE_GRAPH_UNITS = {
  // Reads
  kg_getEntityTypes: defineReadUnit(tuple(id), (db, [workspaceId]) =>
    store(db).getEntityTypes(workspaceId),
  ),
  // By-id units take the caller's workspace first; ids from other workspaces are not found.
  kg_getEntity: defineReadUnit(tuple(id, id), (db, [ws, entityId]) =>
    store(db).getEntity(ws, entityId),
  ),
  kg_getEdge: defineReadUnit(tuple(id, id), (db, [ws, edgeId]) => store(db).getEdge(ws, edgeId)),
  kg_getEdgesBetween: defineReadUnit(tuple(id, id, id, opt(num)), (db, [ws, a, b, asOf]) =>
    store(db).getEdgesBetween(ws, a, b, asOf),
  ),
  kg_getObservations: defineReadUnit(tuple(id, id, opt(int)), (db, [ws, entityId, limit]) =>
    store(db).getObservations(ws, entityId, limit),
  ),
  kg_searchEntities: defineReadUnit(tuple(id, text, opt(int)), (db, [ws, query, limit]) =>
    store(db).searchEntities(ws, query, limit),
  ),
  kg_getNeighbors: defineReadUnit(
    tuple(id, id, opt(int), opt(strList), opt(num)),
    (db, [ws, entityId, depth, edgeTypes, asOf]) =>
      store(db).getNeighbors(ws, entityId, depth, edgeTypes, asOf),
  ),
  kg_getSubgraph: defineReadUnit(tuple(id, strList, opt(num)), (db, [ws, entityIds, asOf]) =>
    store(db).getSubgraph(ws, entityIds, asOf),
  ),
  kg_getStats: defineReadUnit(tuple(id), (db, [workspaceId]) => store(db).getStats(workspaceId)),
  kg_contextEntities: defineReadUnit(
    tuple(id, text, int, opt(num)),
    (db, [ws, query, limit, asOf]) => store(db).contextEntities(ws, query, limit, asOf),
  ),
  // Writes
  kg_upsertEntity: defineUnit(
    tuple(id, entityInput, source, opt(id)),
    (db, [ws, input, entitySource, taskId]) =>
      store(db).upsertEntity(ws, input, entitySource, taskId),
  ),
  kg_updateEntity: defineUnit(
    tuple(id, id, (value: unknown) =>
      fields({ description: opt(text), properties: opt(properties), confidence: opt(num) })(value),
    ),
    (db, [ws, entityId, patch]) => store(db).updateEntity(ws, entityId, patch),
  ),
  kg_deleteEntity: defineUnit(tuple(id, id), (db, [ws, entityId]) =>
    store(db).deleteEntity(ws, entityId),
  ),
  kg_createEdgeChecked: defineUnit(
    tuple(id, edgeInput, source, opt(id), num),
    (db, [ws, input, edgeSource, taskId, now]) =>
      store(db).createEdgeChecked(ws, input, edgeSource, taskId, now),
  ),
  kg_deleteEdge: defineUnit(tuple(id, id), (db, [ws, edgeId]) => store(db).deleteEdge(ws, edgeId)),
  kg_invalidateEdge: defineUnit(tuple(id, id, num), (db, [ws, edgeId, validTo]) =>
    store(db).invalidateEdge(ws, edgeId, validTo),
  ),
  kg_addObservationChecked: defineUnit(
    tuple(id, observationInput, source, opt(id)),
    (db, [ws, input, observationSource, taskId]) =>
      store(db).addObservationChecked(ws, input, observationSource, taskId),
  ),
  kg_applyConfidenceDecay: defineUnit(tuple(id, opt(num), opt(num)), (db, [ws, decayRate, floor]) =>
    store(db).applyConfidenceDecay(ws, decayRate, floor),
  ),
} satisfies UnitCatalog;
