import type Database from "better-sqlite3";
import {
  defineReadUnit,
  defineUnit,
  type UnitCatalog,
} from "../database/statements/statement-catalog";
import {
  bool,
  int,
  json,
  list,
  nullableStr,
  num,
  oneOf,
  opt,
  optBool,
  optStr,
  record,
  str,
  strList,
  tuple,
} from "../database/statements/unit-args";
import { MemoryItemsStore, deleteKitRenderState } from "./memory-items-sql";
import {
  MEMORY_ITEM_KINDS,
  MEMORY_ITEM_PRIVACY,
  MEMORY_ITEM_SCOPES,
  MEMORY_ITEM_SOURCES,
  MEMORY_ITEM_STATUSES,
  type ListMemoryItemsRequest,
  type MemoryItemsPageRequest,
  type MemorySourceRef,
  type PreparedMemoryItemWrite,
} from "./memory-items-types";

/**
 * Memory item units (docs/memory-engine.md), part of the memory domain: each runs in one
 * IMMEDIATE transaction, in the database worker when memory is routed there and on the
 * host connection otherwise. Arguments are rebuilt from checked fields, so the worker
 * never binds a value of the wrong shape.
 */

const ID_MAX = 512;
const CONTENT_MAX = 4000;

const id = (value: unknown, path: string) => str(value, path, ID_MAX);
const nullableId = (value: unknown, path: string) => nullableStr(value, path, ID_MAX);

function sourceRef(value: unknown, path: string): MemorySourceRef {
  const input = record(json(value, path, 16_000), path);
  return input as MemorySourceRef;
}

function preparedWrite(value: unknown, path = "args[0]"): PreparedMemoryItemWrite {
  const input = record(value, path);
  const field = (name: string) => `${path}.${name}`;
  return {
    workspaceId: nullableId(input.workspaceId, field("workspaceId")),
    scope: oneOf(input.scope, field("scope"), MEMORY_ITEM_SCOPES),
    scopeRef: nullableId(input.scopeRef, field("scopeRef")),
    kind: oneOf(input.kind, field("kind"), MEMORY_ITEM_KINDS),
    subjectKey: str(input.subjectKey, field("subjectKey"), 200),
    derivedSubject: bool(input.derivedSubject, field("derivedSubject")),
    content: str(input.content, field("content"), CONTENT_MAX),
    contentHash: str(input.contentHash, field("contentHash"), 128),
    source: oneOf(input.source, field("source"), MEMORY_ITEM_SOURCES),
    sourceRef: sourceRef(input.sourceRef ?? {}, field("sourceRef")),
    trust: num(input.trust, field("trust")),
    confidence: num(input.confidence, field("confidence")),
    pinned: bool(input.pinned, field("pinned")),
    privacy: oneOf(input.privacy, field("privacy"), MEMORY_ITEM_PRIVACY),
    taskId: nullableId(input.taskId, field("taskId")),
    originWorkspaceId: nullableId(input.originWorkspaceId, field("originWorkspaceId")),
    expiresAt:
      input.expiresAt === null || input.expiresAt === undefined
        ? null
        : int(input.expiresAt, field("expiresAt")),
    status: oneOf(input.status, field("status"), ["active", "archived"] as const),
    mode: oneOf(input.mode, field("mode"), ["live", "migration"] as const),
    now: int(input.now, field("now")),
    createdAt: opt((entry, entryPath) => int(entry, entryPath))(
      input.createdAt,
      field("createdAt"),
    ),
  };
}

function listRequest(value: unknown, path: string): ListMemoryItemsRequest {
  const input = record(value, path);
  const field = (name: string) => `${path}.${name}`;
  return {
    workspaceId:
      input.workspaceId === undefined
        ? undefined
        : nullableId(input.workspaceId, field("workspaceId")),
    includeGlobal: optBool(input.includeGlobal, field("includeGlobal")),
    scope:
      input.scope === undefined || input.scope === null
        ? undefined
        : oneOf(input.scope, field("scope"), MEMORY_ITEM_SCOPES),
    scopeRef: optStr(input.scopeRef, field("scopeRef"), ID_MAX),
    kinds:
      input.kinds === undefined || input.kinds === null
        ? undefined
        : list(input.kinds, field("kinds"), (entry, entryPath) =>
            oneOf(entry, entryPath, MEMORY_ITEM_KINDS),
          ),
    statuses:
      input.statuses === undefined || input.statuses === null
        ? undefined
        : list(input.statuses, field("statuses"), (entry, entryPath) =>
            oneOf(entry, entryPath, MEMORY_ITEM_STATUSES),
          ),
    subjectKey: optStr(input.subjectKey, field("subjectKey"), 200),
    sourceStore: optStr(input.sourceStore, field("sourceStore"), 120),
    pinnedOnly: optBool(input.pinnedOnly, field("pinnedOnly")),
    includePrivate: optBool(input.includePrivate, field("includePrivate")),
    limit:
      input.limit === undefined || input.limit === null
        ? undefined
        : int(input.limit, field("limit"), 1, 5000),
  };
}

function statusTarget(value: unknown, path: string) {
  const input = record(value, path);
  if (input.id !== undefined) return { id: id(input.id, `${path}.id`) };
  return {
    store: str(input.store, `${path}.store`, 120),
    sourceId: id(input.sourceId, `${path}.sourceId`),
  };
}

function pageRequest(value: unknown, path: string): MemoryItemsPageRequest {
  const input = record(value, path);
  const field = (name: string) => `${path}.${name}`;
  const enumList = <T extends string>(entry: unknown, name: string, allowed: readonly T[]) =>
    entry === undefined || entry === null
      ? undefined
      : list(entry, field(name), (item, itemPath) => oneOf(item, itemPath, allowed), 20);
  return {
    workspaceId: id(input.workspaceId, field("workspaceId")),
    kinds: enumList(input.kinds, "kinds", MEMORY_ITEM_KINDS),
    scopes: enumList(input.scopes, "scopes", MEMORY_ITEM_SCOPES),
    statuses: enumList(input.statuses, "statuses", MEMORY_ITEM_STATUSES),
    sources: enumList(input.sources, "sources", MEMORY_ITEM_SOURCES),
    query: optStr(input.query, field("query"), 500),
    pinnedOnly: optBool(input.pinnedOnly, field("pinnedOnly")),
    limit:
      input.limit === undefined || input.limit === null
        ? undefined
        : int(input.limit, field("limit"), 1, 200),
    offset:
      input.offset === undefined || input.offset === null
        ? undefined
        : int(input.offset, field("offset"), 0, 100_000),
  };
}

const closingStatus = (value: unknown, path: string) =>
  oneOf(value, path, ["superseded", "archived", "deleted"] as const);

export const MEMORY_ITEMS_UNITS = {
  memoryItems_findById: defineReadUnit(tuple(id), (db: Database.Database, [itemId]) =>
    new MemoryItemsStore(db).findById(itemId),
  ),
  memoryItems_findBySourceRef: defineReadUnit(
    tuple(
      (value: unknown, path: string) => str(value, path, 120),
      id,
      opt((value: unknown, path: string) =>
        list(value, path, (entry, entryPath) => oneOf(entry, entryPath, MEMORY_ITEM_STATUSES)),
      ),
    ),
    (db: Database.Database, [store, sourceId, statuses]) =>
      new MemoryItemsStore(db).findBySourceRef(store, sourceId, statuses),
  ),
  memoryItems_list: defineReadUnit(tuple(opt(listRequest)), (db: Database.Database, [request]) =>
    new MemoryItemsStore(db).list(request ?? {}),
  ),
  memoryItems_listForView: defineReadUnit(
    tuple(
      id,
      (value: unknown, path: string) => oneOf(value, path, ["user", "workspace"] as const),
      (value: unknown, path: string) => int(value, path, 1, 1000),
    ),
    (db: Database.Database, [workspaceId, view, limit]) =>
      new MemoryItemsStore(db).listForView(workspaceId, view, limit),
  ),
  memoryItems_ingest: defineUnit(tuple(preparedWrite), (db: Database.Database, [write]) =>
    new MemoryItemsStore(db).ingest(write),
  ),
  memoryItems_setStatus: defineUnit(
    tuple(statusTarget, closingStatus, (value: unknown, path: string) => int(value, path)),
    (db: Database.Database, [target, status, now]) =>
      new MemoryItemsStore(db).setStatus(target, status, now),
  ),
  memoryItems_markUsed: defineUnit(
    tuple(strList, (value: unknown, path: string) => int(value, path)),
    (db: Database.Database, [ids, now]) => new MemoryItemsStore(db).markUsed(ids, now),
  ),
  memoryItems_listCuratedForMigration: defineReadUnit(tuple(), (db: Database.Database) =>
    new MemoryItemsStore(db).listCuratedForMigration(),
  ),
  memoryItems_laneMigrationComplete: defineReadUnit(tuple(), (db: Database.Database) =>
    new MemoryItemsStore(db).isLaneMigrationComplete(),
  ),
  memoryItems_recordLaneMigration: defineUnit(
    tuple(
      (value: unknown, path: string) => {
        const input = record(value, path);
        const counts: Record<string, number> = {};
        for (const [key, entry] of Object.entries(input)) {
          counts[str(key, `${path} key`, 64)] = int(entry, `${path}.${key}`);
        }
        return counts;
      },
      (value: unknown, path: string) => int(value, path),
    ),
    (db: Database.Database, [summary, now]) =>
      new MemoryItemsStore(db).recordLaneMigration(summary, now),
  ),
  memoryItems_listPage: defineReadUnit(tuple(pageRequest), (db: Database.Database, [request]) =>
    new MemoryItemsStore(db).listPage(request),
  ),
  memoryItems_revisions: defineReadUnit(
    tuple(id, (value: unknown, path: string) => int(value, path, 1, 100)),
    (db: Database.Database, [itemId, max]) => new MemoryItemsStore(db).revisions(itemId, max),
  ),
  memoryItems_setPinned: defineUnit(
    tuple(id, bool, (value: unknown, path: string) => int(value, path)),
    (db: Database.Database, [itemId, pinned, now]) =>
      new MemoryItemsStore(db).setPinned(itemId, pinned, now),
  ),
  memoryItems_purgeGlobal: defineUnit(tuple(), (db: Database.Database) =>
    new MemoryItemsStore(db).purgeGlobal(),
  ),
  memoryItems_clearKitRenderState: defineUnit(tuple(id), (db: Database.Database, [workspaceId]) =>
    deleteKitRenderState(db, workspaceId),
  ),
} satisfies UnitCatalog;
