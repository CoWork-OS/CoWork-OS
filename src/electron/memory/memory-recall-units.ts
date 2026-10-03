import type Database from "better-sqlite3";
import { defineReadUnit, type UnitCatalog } from "../database/statements/statement-catalog";
import {
  int,
  list,
  nullableStr,
  num,
  oneOf,
  optBool,
  record,
  str,
  tuple,
} from "../database/statements/unit-args";
import { MemoryRecallStore, type MemoryItemRecallRequest } from "./memory-recall-sql";
import { MEMORY_ITEM_KINDS, MEMORY_ITEM_SCOPES } from "./memory-items-types";

/**
 * Read units of MemoryRecall's `memory` lane (memory domain). Arguments are rebuilt from
 * checked fields, so the worker never binds a value of the wrong shape.
 */

const ID_MAX = 512;

function recallRequest(value: unknown, path: string): MemoryItemRecallRequest {
  const input = record(value, path);
  const field = (name: string) => `${path}.${name}`;
  const optional = <T>(entry: unknown, check: () => T): T | undefined =>
    entry === undefined || entry === null ? undefined : check();
  return {
    workspaceId: nullableStr(input.workspaceId ?? null, field("workspaceId"), ID_MAX),
    query: str(input.query ?? "", field("query"), 4000),
    taskId: optional(input.taskId, () => str(input.taskId, field("taskId"), ID_MAX)),
    contactRef: optional(input.contactRef, () =>
      str(input.contactRef, field("contactRef"), ID_MAX),
    ),
    kinds: optional(input.kinds, () =>
      list(input.kinds, field("kinds"), (entry, entryPath) =>
        oneOf(entry, entryPath, MEMORY_ITEM_KINDS),
      ),
    ),
    scopes: optional(input.scopes, () =>
      list(input.scopes, field("scopes"), (entry, entryPath) =>
        oneOf(entry, entryPath, MEMORY_ITEM_SCOPES),
      ),
    ),
    minTrust: optional(input.minTrust, () => num(input.minTrust, field("minTrust"))),
    includePrivate: optBool(input.includePrivate, field("includePrivate")),
    ids: optional(input.ids, () =>
      list(input.ids, field("ids"), (entry, entryPath) => str(entry, entryPath, ID_MAX), 100),
    ),
    limit: int(input.limit, field("limit"), 1, 100),
    now: int(input.now, field("now")),
  };
}

export const MEMORY_RECALL_UNITS = {
  memoryRecall_searchItems: defineReadUnit(
    tuple(recallRequest),
    (db: Database.Database, [request]) => new MemoryRecallStore(db).searchItems(request),
  ),
} satisfies UnitCatalog;
