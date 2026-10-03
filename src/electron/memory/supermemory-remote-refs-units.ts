import type Database from "better-sqlite3";
import {
  defineReadUnit,
  defineUnit,
  type UnitCatalog,
} from "../database/statements/statement-catalog";
import {
  int,
  list,
  nullableStr,
  oneOf,
  opt,
  record,
  str,
  strList,
  tuple,
} from "../database/statements/unit-args";
import {
  SUPERMEMORY_REMOTE_KINDS,
  SupermemoryRemoteRefStore,
  type SupermemoryRemoteRefInput,
} from "./supermemory-remote-refs-sql";

/**
 * Supermemory remote-id units (SEC-17), part of the memory domain: each runs in one
 * transaction, in the database worker when memory is routed there and on the host
 * otherwise. Arguments are rebuilt from checked fields.
 */

const ID_MAX = 512;
const limit = (value: unknown, path: string) => int(value, path, 1, 10_000);

function refInput(value: unknown, path = "args[0]"): SupermemoryRemoteRefInput {
  const input = record(value, path);
  const field = (name: string) => `${path}.${name}`;
  return {
    localRef: str(input.localRef, field("localRef"), ID_MAX),
    remoteId: str(input.remoteId, field("remoteId"), ID_MAX),
    remoteKind: oneOf(input.remoteKind, field("remoteKind"), SUPERMEMORY_REMOTE_KINDS),
    containerTag: str(input.containerTag, field("containerTag"), 200),
    workspaceId: nullableStr(input.workspaceId ?? null, field("workspaceId"), ID_MAX),
    taskId: nullableStr(input.taskId ?? null, field("taskId"), ID_MAX),
    createdAt: int(input.createdAt, field("createdAt")),
  };
}

function listFilter(value: unknown, path: string): { workspaceId?: string | null; limit: number } {
  const input = record(value, path);
  return {
    workspaceId: nullableStr(input.workspaceId ?? null, `${path}.workspaceId`, ID_MAX),
    limit: limit(input.limit, `${path}.limit`),
  };
}

export const SUPERMEMORY_REMOTE_REF_UNITS = {
  supermemoryRefs_record: defineUnit(tuple(refInput), (db: Database.Database, [input]) =>
    new SupermemoryRemoteRefStore(db).record(input),
  ),
  supermemoryRefs_listOrphans: defineReadUnit(tuple(limit), (db: Database.Database, [max]) =>
    new SupermemoryRemoteRefStore(db).listOrphans(max),
  ),
  supermemoryRefs_list: defineReadUnit(tuple(listFilter), (db: Database.Database, [filter]) =>
    new SupermemoryRemoteRefStore(db).list(filter),
  ),
  supermemoryRefs_findByRemoteIds: defineReadUnit(
    tuple(strList),
    (db: Database.Database, [remoteIds]) =>
      new SupermemoryRemoteRefStore(db).findByRemoteIds(remoteIds),
  ),
  supermemoryRefs_count: defineReadUnit(tuple(), (db: Database.Database) =>
    new SupermemoryRemoteRefStore(db).count(),
  ),
  supermemoryRefs_deleteByIds: defineUnit(
    tuple(
      opt((value: unknown, path: string) =>
        list(value, path, (entry, entryPath) => int(entry, entryPath, 1)),
      ),
    ),
    (db: Database.Database, [ids]) => new SupermemoryRemoteRefStore(db).deleteByIds(ids ?? []),
  ),
} satisfies UnitCatalog;
