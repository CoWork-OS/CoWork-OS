import type Database from "better-sqlite3";
import type {
  DreamingCandidate,
  DreamingRun,
  ListDreamingCandidatesRequest,
  ListDreamingRunsRequest,
  ReviewDreamingCandidateRequest,
} from "../../shared/types";
import type { DreamingStore } from "./dreaming-sql";
import { createMemoryStatementPort, type MemoryStatementPort } from "./memory-statement-port";

/**
 * Dreaming runs and candidates (async SQLite migration plan, DB6). Each operation is one
 * memory-domain transaction unit over `DreamingStore`: in the database worker when
 * memory is routed there, one host transaction otherwise. The connection is used only to
 * create the port.
 */
export class DreamingRepository {
  private readonly sql: MemoryStatementPort;

  constructor(db: Database.Database) {
    this.sql = createMemoryStatementPort(db);
  }

  /** The memory statement port, for repositories of the same domain (curation). */
  get statementPort(): MemoryStatementPort {
    return this.sql;
  }

  createRun(
    input: Omit<DreamingRun, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): Promise<DreamingRun> {
    return this.sql.unit("dreaming_createRun", [input]);
  }

  updateRun(
    id: string,
    patch: Parameters<DreamingStore["updateRun"]>[1],
  ): Promise<DreamingRun | undefined> {
    return this.sql.unit("dreaming_updateRun", [id, patch]);
  }

  findRunById(id: string): Promise<DreamingRun | undefined> {
    return this.sql.unit("dreaming_findRunById", [id]);
  }

  listRuns(request: ListDreamingRunsRequest = {}): Promise<DreamingRun[]> {
    return this.sql.unit("dreaming_listRuns", [request]);
  }

  createCandidate(
    input: Omit<DreamingCandidate, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): Promise<DreamingCandidate> {
    return this.sql.unit("dreaming_createCandidate", [input]);
  }

  bulkCreateCandidates(
    inputs: Array<
      Omit<DreamingCandidate, "id" | "createdAt"> & { id?: string; createdAt?: number }
    >,
  ): Promise<DreamingCandidate[]> {
    return this.sql.unit("dreaming_bulkCreateCandidates", [inputs]);
  }

  findCandidateById(id: string): Promise<DreamingCandidate | undefined> {
    return this.sql.unit("dreaming_findCandidateById", [id]);
  }

  listCandidates(request: ListDreamingCandidatesRequest = {}): Promise<DreamingCandidate[]> {
    return this.sql.unit("dreaming_listCandidates", [request]);
  }

  reviewCandidate(request: ReviewDreamingCandidateRequest): Promise<DreamingCandidate | undefined> {
    return this.sql.unit("dreaming_reviewCandidate", [request]);
  }
}
