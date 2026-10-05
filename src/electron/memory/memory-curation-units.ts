import type Database from "better-sqlite3";
import {
  defineReadUnit,
  defineUnit,
  type UnitCatalog,
} from "../database/statements/statement-catalog";
import {
  bool,
  int,
  list,
  nullableStr,
  oneOf,
  record,
  str,
  tuple,
} from "../database/statements/unit-args";
import {
  MemoryCurationStore,
  type CurationApplyRequest,
  type CurationStoreOperation,
} from "./memory-curation-sql";
import { MEMORY_ITEMS_UNITS } from "./memory-items-units";
import type { PreparedMemoryItemWrite } from "./memory-items-types";

/**
 * Memory curator units (docs/memory-engine.md §9), part of the memory domain: an apply or
 * an undo is one transaction together with its audit-log row. Arguments are rebuilt from
 * checked fields.
 */

const ID_MAX = 512;
const id = (value: unknown, path: string) => str(value, path, ID_MAX);
const nullableId = (value: unknown, path: string) => nullableStr(value, path, ID_MAX);
const ids = (value: unknown, path: string) => list(value, path, id, 50);
const time = (value: unknown, path: string) => int(value, path);

/** The ingest unit's validator for a prepared write, reused for promotions. */
const preparedWrite = (value: unknown, path: string): PreparedMemoryItemWrite => {
  try {
    return MEMORY_ITEMS_UNITS.memoryItems_ingest.validate([value])[0];
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

function operation(value: unknown, path: string): CurationStoreOperation {
  const input = record(value, path);
  const op = oneOf(input.op, `${path}.op`, [
    "merge",
    "resolve_conflict",
    "decay",
    "expire_commitment",
    "promote",
  ] as const);
  switch (op) {
    case "merge":
      return {
        op,
        keepId: id(input.keepId, `${path}.keepId`),
        mergeIds: ids(input.mergeIds, `${path}.mergeIds`),
      };
    case "resolve_conflict":
      return {
        op,
        keepId: id(input.keepId, `${path}.keepId`),
        dropIds: ids(input.dropIds, `${path}.dropIds`),
      };
    case "decay":
    case "expire_commitment":
      return { op, itemIds: ids(input.itemIds, `${path}.itemIds`) };
    case "promote":
      return { op, write: preparedWrite(input.write, `${path}.write`) };
  }
}

function applyRequest(value: unknown, path = "args[0]"): CurationApplyRequest {
  const input = record(value, path);
  const field = (name: string) => `${path}.${name}`;
  return {
    workspaceId: id(input.workspaceId, field("workspaceId")),
    runId: nullableId(input.runId ?? null, field("runId")),
    candidateId: nullableId(input.candidateId ?? null, field("candidateId")),
    origin: oneOf(input.origin, field("origin"), ["auto", "review"] as const),
    fingerprint: str(input.fingerprint, field("fingerprint"), 2000),
    summary: str(input.summary, field("summary"), 1000),
    rationale: nullableStr(input.rationale ?? null, field("rationale"), 2000),
    allowProtected: bool(input.allowProtected, field("allowProtected")),
    operation: operation(input.operation, field("operation")),
    now: time(input.now, field("now")),
  };
}

export const MEMORY_CURATION_UNITS = {
  memoryCuration_apply: defineUnit(tuple(applyRequest), (db: Database.Database, [request]) =>
    new MemoryCurationStore(db).apply(request),
  ),
  memoryCuration_undo: defineUnit(
    tuple(id, id, time),
    (db: Database.Database, [logId, workspaceId, now]) =>
      new MemoryCurationStore(db).undo(logId, workspaceId, now),
  ),
  memoryCuration_findLog: defineReadUnit(tuple(id), (db: Database.Database, [logId]) =>
    new MemoryCurationStore(db).findLog(logId),
  ),
  memoryCuration_listLog: defineReadUnit(
    tuple(id, (value: unknown, path: string) => int(value, path, 1, 200)),
    (db: Database.Database, [workspaceId, limit]) =>
      new MemoryCurationStore(db).listLog(workspaceId, limit),
  ),
  memoryCuration_undoneFingerprints: defineReadUnit(
    tuple(id),
    (db: Database.Database, [workspaceId]) =>
      new MemoryCurationStore(db).undoneFingerprints(workspaceId),
  ),
  memoryCuration_archiveEvidence: defineReadUnit(
    tuple(id, time, (value: unknown, path: string) => int(value, path, 1, 1000)),
    (db: Database.Database, [workspaceId, since, limit]) =>
      new MemoryCurationStore(db).archiveEvidence(workspaceId, since, limit),
  ),
} satisfies UnitCatalog;
