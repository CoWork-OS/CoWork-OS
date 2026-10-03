import type Database from "better-sqlite3";
import {
  defineReadUnit,
  defineUnit,
  type UnitCatalog,
} from "../database/statements/statement-catalog";
import {
  bool,
  fields,
  int,
  list,
  nullableStr,
  num,
  oneOf,
  opt,
  record,
  str,
  strList,
  tuple,
} from "../database/statements/unit-args";
import { PlaybookEvidenceStore, type PlaybookEvidenceInput } from "./PlaybookEvidenceStore";
import {
  PLAYBOOK_ENTRY_KINDS,
  PlaybookEntrySqlStore,
  type PlaybookEntryInput,
  type PlaybookEntryListOptions,
} from "./playbook-entries-sql";

/**
 * Playbook evidence units (async SQLite migration plan, DB6), part of the memory domain.
 * The host passes the clock reading, so record, invalidation and link times are the host's.
 */

const id = (value: unknown, path: string) => str(value, path, 512);
const text = (value: unknown, path: string) => str(value, path, 4096);

const evidenceInput = (value: unknown): PlaybookEvidenceInput =>
  fields({
    workspaceId: id,
    taskId: id,
    sourceEntryId: id,
    sourceContentHash: id,
    patternKey: text,
  })(value);

const entryInput = (value: unknown): PlaybookEntryInput =>
  fields({
    workspaceId: id,
    taskId: (v: unknown, path: string) => nullableStr(v, path, 512),
    kind: (v: unknown, path: string) => oneOf(v, path, PLAYBOOK_ENTRY_KINDS),
    content: (v: unknown, path: string) => str(v, path, 20_000),
    isPrivate: bool,
    patternKey: text,
  })(value);

const listOptions = (value: unknown, path: string): PlaybookEntryListOptions => {
  const input = record(value, path);
  return {
    kinds:
      input.kinds === undefined
        ? undefined
        : list(input.kinds, `${path}.kinds`, (v, p) => oneOf(v, p, PLAYBOOK_ENTRY_KINDS)),
    since: input.since === undefined ? undefined : int(input.since, `${path}.since`),
    limit: input.limit === undefined ? undefined : int(input.limit, `${path}.limit`, 1, 1000),
    includePrivate:
      input.includePrivate === undefined
        ? undefined
        : bool(input.includePrivate, `${path}.includePrivate`),
  };
};

const store = (db: Database.Database, now: number) =>
  new PlaybookEvidenceStore(db, () => now, false);
/** Reads never write, so their clock is unused. */
const reader = (db: Database.Database) => store(db, 0);

export const PLAYBOOK_EVIDENCE_UNITS = {
  playbook_find: defineReadUnit(tuple(id, id), (db, [ws, taskId]) => reader(db).find(ws, taskId)),
  playbook_get: defineReadUnit(tuple(id), (db, [evidenceId]) => reader(db).get(evidenceId)),
  playbook_listActiveLinks: defineReadUnit(tuple(id), (db, [ws]) => reader(db).listActiveLinks(ws)),
  playbook_record: defineUnit(tuple(evidenceInput, num), (db, [input, now]) =>
    store(db, now).record(input),
  ),
  // A write: reading a source invalidates evidence whose memory was deleted or edited.
  playbook_listReadable: defineUnit(tuple(id, num), (db, [ws, now]) =>
    store(db, now).listReadable(ws),
  ),
  playbook_linkAll: defineUnit(tuple(id, strList, num), (db, [from, to, now]) =>
    store(db, now).linkAll(from, to),
  ),
  playbook_invalidateTask: defineUnit(tuple(id, id, id, num), (db, [ws, taskId, reason, now]) =>
    store(db, now).invalidateTask(ws, taskId, reason),
  ),
  // The entry and (for a success) its evidence row commit together.
  playbook_recordOutcome: defineUnit(tuple(entryInput, num), (db, [input, now]) =>
    store(db, now).recordOutcome(input),
  ),
  playbook_listEntries: defineReadUnit(tuple(id, opt(listOptions)), (db, [ws, options]) =>
    new PlaybookEntrySqlStore(db).list(ws, options ?? {}),
  ),
  playbook_countOutcomes: defineReadUnit(tuple(id, num), (db, [ws, since]) =>
    new PlaybookEntrySqlStore(db).countOutcomes(ws, since),
  ),
  playbook_listCorrections: defineReadUnit(tuple(id, num), (db, [ws, since]) =>
    reader(db).listCorrections(ws, since),
  ),
} satisfies UnitCatalog;
