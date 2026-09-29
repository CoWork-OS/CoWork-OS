import type Database from "better-sqlite3";
import {
  defineReadUnit,
  defineUnit,
  type UnitCatalog,
} from "../database/statements/statement-catalog";
import {
  fields,
  num,
  nullableStr,
  oneOf,
  opt,
  str,
  strList,
  tuple,
} from "../database/statements/unit-args";
import {
  PlaybookEvidenceStore,
  type PlaybookEvidenceInput,
  type PlaybookOutcomeGrade,
} from "./PlaybookEvidenceStore";

/**
 * Playbook evidence units (async SQLite migration plan, DB6), part of the memory domain.
 * The host passes the clock reading, so invalidation and link times are the host's.
 */

const GRADES: readonly PlaybookOutcomeGrade[] = [
  "observed_runtime_success",
  "contract_verified",
  "user_confirmed",
  "failure",
  "corrected",
];
const OUTCOMES = ["success", "failure"] as const;
const id = (value: unknown, path: string) => str(value, path, 512);
const outcome = (value: unknown, path: string) => oneOf(value, path, OUTCOMES);
const nullableId = (value: unknown, path: string) => nullableStr(value, path, 512);

const evidenceInput = (value: unknown): PlaybookEvidenceInput =>
  fields({
    workspaceId: id,
    taskId: id,
    executionKey: id,
    turnId: nullableId,
    terminalEventId: nullableId,
    sourceMemoryId: nullableId,
    sourceContentHash: nullableId,
    outcome,
    grade: (entry: unknown, path: string) => oneOf(entry, path, GRADES),
    patternKey: (entry: unknown, path: string) => str(entry, path, 4096),
    title: (entry: unknown, path: string) => str(entry, path, 4096),
    approach: (entry: unknown, path: string) => str(entry, path, 4096),
    requestExcerpt: (entry: unknown, path: string) => str(entry, path, 4096),
    toolsUsed: strList,
    sourceRefs: strList,
  })(value);

const store = (db: Database.Database, now: number) =>
  new PlaybookEvidenceStore(db, () => now, false);
/** Reads never write, so their clock is unused. */
const reader = (db: Database.Database) => store(db, 0);

export const PLAYBOOK_EVIDENCE_UNITS = {
  playbook_find: defineReadUnit(tuple(id, id, outcome), (db, [ws, key, result]) =>
    reader(db).find(ws, key, result),
  ),
  playbook_get: defineReadUnit(tuple(id), (db, [evidenceId]) => reader(db).get(evidenceId)),
  playbook_listActiveLinks: defineReadUnit(tuple(id), (db, [ws]) => reader(db).listActiveLinks(ws)),
  playbook_record: defineUnit(tuple(evidenceInput, num), (db, [input, now]) =>
    store(db, now).record(input),
  ),
  playbook_verifiedSuccesses: defineUnit(tuple(id, opt(id), num), (db, [ws, exclude, now]) =>
    store(db, now).verifiedSuccesses(ws, exclude),
  ),
  playbook_verifiedFailures: defineUnit(tuple(id, num), (db, [ws, now]) =>
    store(db, now).verifiedFailures(ws),
  ),
  playbook_linkAll: defineUnit(tuple(id, strList, num), (db, [from, to, now]) =>
    store(db, now).linkAll(from, to),
  ),
  playbook_invalidateTaskSuccesses: defineUnit(
    tuple(id, id, (value: unknown, path: string) => str(value, path, 512), num),
    (db, [ws, taskId, reason, now]) => store(db, now).invalidateTaskSuccesses(ws, taskId, reason),
  ),
  playbook_sweepWorkspace: defineUnit(tuple(id, num), (db, [ws, now]) =>
    store(db, now).sweepWorkspace(ws),
  ),
} satisfies UnitCatalog;
