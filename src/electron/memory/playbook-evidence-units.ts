import type Database from "better-sqlite3";
import {
  defineReadUnit,
  defineUnit,
  type UnitCatalog,
} from "../database/statements/statement-catalog";
import { fields, num, str, strList, tuple } from "../database/statements/unit-args";
import { PlaybookEvidenceStore, type PlaybookEvidenceInput } from "./PlaybookEvidenceStore";

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
    sourceMemoryId: id,
    sourceContentHash: id,
    patternKey: text,
  })(value);

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
} satisfies UnitCatalog;
