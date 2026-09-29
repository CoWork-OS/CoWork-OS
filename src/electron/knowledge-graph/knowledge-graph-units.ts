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
  kg_getEntity: defineReadUnit(tuple(id), (db, [entityId]) => store(db).getEntity(entityId)),
  kg_getEdge: defineReadUnit(tuple(id), (db, [edgeId]) => store(db).getEdge(edgeId)),
  kg_getEdgesBetween: defineReadUnit(tuple(id, id, opt(num)), (db, [a, b, asOf]) =>
    store(db).getEdgesBetween(a, b, asOf),
  ),
  kg_getObservations: defineReadUnit(tuple(id, opt(int)), (db, [entityId, limit]) =>
    store(db).getObservations(entityId, limit),
  ),
  kg_searchEntities: defineReadUnit(tuple(id, text, opt(int)), (db, [ws, query, limit]) =>
    store(db).searchEntities(ws, query, limit),
  ),
  kg_getNeighbors: defineReadUnit(
    tuple(id, opt(int), opt(strList), opt(num)),
    (db, [entityId, depth, edgeTypes, asOf]) =>
      store(db).getNeighbors(entityId, depth, edgeTypes, asOf),
  ),
  kg_getSubgraph: defineReadUnit(tuple(strList, opt(num)), (db, [entityIds, asOf]) =>
    store(db).getSubgraph(entityIds, asOf),
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
    tuple(id, (value: unknown) =>
      fields({ description: opt(text), properties: opt(properties), confidence: opt(num) })(value),
    ),
    (db, [entityId, patch]) => store(db).updateEntity(entityId, patch),
  ),
  kg_deleteEntity: defineUnit(tuple(id), (db, [entityId]) => store(db).deleteEntity(entityId)),
  kg_createEdgeChecked: defineUnit(
    tuple(id, edgeInput, source, opt(id), num),
    (db, [ws, input, edgeSource, taskId, now]) =>
      store(db).createEdgeChecked(ws, input, edgeSource, taskId, now),
  ),
  kg_deleteEdge: defineUnit(tuple(id), (db, [edgeId]) => store(db).deleteEdge(edgeId)),
  kg_invalidateEdge: defineUnit(tuple(id, num), (db, [edgeId, validTo]) =>
    store(db).invalidateEdge(edgeId, validTo),
  ),
  kg_addObservationChecked: defineUnit(
    tuple(observationInput, source, opt(id)),
    (db, [input, observationSource, taskId]) =>
      store(db).addObservationChecked(input, observationSource, taskId),
  ),
  kg_applyConfidenceDecay: defineUnit(tuple(id, opt(num), opt(num)), (db, [ws, decayRate, floor]) =>
    store(db).applyConfidenceDecay(ws, decayRate, floor),
  ),
} satisfies UnitCatalog;
