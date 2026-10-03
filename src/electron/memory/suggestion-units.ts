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
  json,
  nullableStr,
  num,
  oneOf,
  record,
  str,
  tuple,
} from "../database/statements/unit-args";
import {
  STORED_SUGGESTION_STATUSES,
  SUGGESTION_FEEDBACK_ACTIONS,
  SuggestionSqlStore,
  type StoredSuggestionInput,
  type SuggestionFeedbackInput,
} from "./suggestions-sql";

/**
 * Proactive suggestion units (suggestions-sql.ts), part of the memory domain. The host
 * passes ids and clock readings, so units never read a clock or generate ids.
 */

const id = (value: unknown, path: string) => str(value, path, 512);
const text = (value: unknown, path: string) => nullableStr(value, path, 8192);
const payload = (value: unknown, path: string) =>
  record(json(value, path, 64_000), path) as Record<string, unknown>;

const suggestionInput = (value: unknown): StoredSuggestionInput =>
  fields({
    id,
    workspaceId: id,
    payload,
    isPrivate: bool,
    createdAt: int,
    expiresAt: int,
  })(value);

const feedbackInput = (value: unknown): SuggestionFeedbackInput =>
  fields({
    id,
    workspaceId: id,
    suggestionId: (v: unknown, path: string) => nullableStr(v, path, 512),
    action: (v: unknown, path: string) => oneOf(v, path, SUGGESTION_FEEDBACK_ACTIONS),
    title: (v: unknown, path: string) => str(v, path, 2048),
    suggestionClass: text,
    sourceEntity: text,
    actionPrompt: text,
    editedPrompt: text,
    isPrivate: bool,
    createdAt: int,
  })(value);

const store = (db: Database.Database) => new SuggestionSqlStore(db);

export const SUGGESTION_UNITS = {
  suggestion_insert: defineUnit(tuple(suggestionInput), (db, [input]) => store(db).insert(input)),
  suggestion_get: defineReadUnit(tuple(id, id), (db, [ws, suggestionId]) =>
    store(db).get(ws, suggestionId),
  ),
  suggestion_listActive: defineReadUnit(tuple(id, num, int), (db, [ws, now, limit]) =>
    store(db).listActive(ws, now, limit),
  ),
  suggestion_setStatus: defineUnit(
    tuple(id, id, (v: unknown, p: string) => oneOf(v, p, STORED_SUGGESTION_STATUSES), num),
    (db, [ws, suggestionId, status, now]) => store(db).setStatus(ws, suggestionId, status, now),
  ),
  suggestion_setSnoozedUntil: defineUnit(
    tuple(id, id, (v: unknown, p: string) => (v === null ? null : num(v, p)), num),
    (db, [ws, suggestionId, until, now]) => store(db).setSnoozedUntil(ws, suggestionId, until, now),
  ),
  suggestion_insertFeedback: defineUnit(tuple(feedbackInput), (db, [input]) =>
    store(db).insertFeedback(input),
  ),
  suggestion_countFeedback: defineReadUnit(
    tuple(id, (v: unknown, p: string) => oneOf(v, p, SUGGESTION_FEEDBACK_ACTIONS), int),
    (db, [ws, action, limit]) => store(db).countFeedback(ws, action, limit),
  ),
  suggestion_listFeedback: defineReadUnit(tuple(id, int), (db, [ws, limit]) =>
    store(db).listFeedback(ws, limit),
  ),
} satisfies UnitCatalog;
