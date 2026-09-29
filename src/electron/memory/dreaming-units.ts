import {
  defineReadUnit,
  defineUnit,
  type UnitCatalog,
} from "../database/statements/statement-catalog";
import { json, list, opt, str, tuple } from "../database/statements/unit-args";
import type {
  DreamingCandidate,
  DreamingRun,
  ListDreamingCandidatesRequest,
  ListDreamingRunsRequest,
  ReviewDreamingCandidateRequest,
} from "../../shared/types";
import { DreamingStore } from "./dreaming-sql";

/**
 * Dreaming units (async SQLite migration plan, DB6), part of the memory domain. Record
 * arguments are checked as JSON-compatible values; the store binds each field to a
 * typed statement parameter.
 */

type RunInput = Omit<DreamingRun, "id" | "createdAt"> & { id?: string; createdAt?: number };
type CandidateInput = Omit<DreamingCandidate, "id" | "createdAt"> & {
  id?: string;
  createdAt?: number;
};
type RunPatch = Parameters<DreamingStore["updateRun"]>[1];

const id = (value: unknown, path: string) => str(value, path, 512);
const record =
  <T>() =>
  (value: unknown, path: string) =>
    json(value, path) as T;

export const DREAMING_UNITS = {
  dreaming_findRunById: defineReadUnit(tuple(id), (db, [runId]) =>
    new DreamingStore(db).findRunById(runId),
  ),
  dreaming_listRuns: defineReadUnit(
    tuple(opt(record<ListDreamingRunsRequest>())),
    (db, [request]) => new DreamingStore(db).listRuns(request),
  ),
  dreaming_findCandidateById: defineReadUnit(tuple(id), (db, [candidateId]) =>
    new DreamingStore(db).findCandidateById(candidateId),
  ),
  dreaming_listCandidates: defineReadUnit(
    tuple(opt(record<ListDreamingCandidatesRequest>())),
    (db, [request]) => new DreamingStore(db).listCandidates(request),
  ),
  dreaming_createRun: defineUnit(tuple(record<RunInput>()), (db, [input]) =>
    new DreamingStore(db).createRun(input),
  ),
  dreaming_updateRun: defineUnit(tuple(id, record<RunPatch>()), (db, [runId, patch]) =>
    new DreamingStore(db).updateRun(runId, patch),
  ),
  dreaming_createCandidate: defineUnit(tuple(record<CandidateInput>()), (db, [input]) =>
    new DreamingStore(db).createCandidate(input),
  ),
  dreaming_bulkCreateCandidates: defineUnit(
    tuple((value: unknown, path: string) => list(value, path, record<CandidateInput>())),
    // One unit is one transaction already.
    (db, [inputs]) => inputs.map((input) => new DreamingStore(db).createCandidate(input)),
  ),
  dreaming_reviewCandidate: defineUnit(
    tuple(record<ReviewDreamingCandidateRequest>()),
    (db, [request]) => new DreamingStore(db).reviewCandidate(request),
  ),
} satisfies UnitCatalog;
