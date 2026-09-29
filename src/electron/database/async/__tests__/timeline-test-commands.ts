import type Database from "better-sqlite3";
import { SessionProgressService } from "../../../sessions/SessionProgressService";
import { drainTimelineProjectionOutbox } from "../../../sessions/timeline-projection";
import { WorkSessionContractService } from "../../../sessions/WorkSessionContractService";
import { WorkSessionProtocolService } from "../../../sessions/WorkSessionProtocolService";

// Worker commands for crash scenarios in timeline-projection.test.ts; bundled with esbuild
// and loaded through `testCommandsModule`. Never part of the application build.

const services = (db: Database.Database) => {
  const protocol = new WorkSessionProtocolService(db);
  return {
    protocol,
    contracts: new WorkSessionContractService(db, protocol),
    progress: new SessionProgressService(db),
  };
};

export const commands = {
  /** Project one entry, then exit before COMMIT: nothing may persist. */
  "test.drainOneThenExitBeforeCommit": {
    kind: "write",
    tables: [],
    run(db: Database.Database) {
      drainTimelineProjectionOutbox(db, services(db), 1);
      process.exit(0);
    },
  },
  /** Project one entry, COMMIT, then exit before replying: the outcome is unknown. */
  "test.drainOneThenExitAfterCommit": {
    kind: "write",
    tables: [],
    run(db: Database.Database) {
      drainTimelineProjectionOutbox(db, services(db), 1);
      db.exec("COMMIT");
      process.exit(0);
    },
  },
};
