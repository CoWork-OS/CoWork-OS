import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import type { KitWriterRuntime } from "../memory/kit-writer-lease-sql";
import { createMemoryStatementPort } from "../memory/memory-statement-port";
import { CrossSignalService } from "./CrossSignalService";
import { FeedbackService } from "./FeedbackService";
import { KitWriterOwnership } from "./kit-writer-ownership";

/**
 * The workspace kit writers of a process (CROSS_SIGNALS.md, MISTAKES.md and the feedback
 * files), gated by the profile's kit-writer lease. Used by the desktop app and the
 * node daemon; `start()` resolves once the first lease round is done.
 */
export function createKitWriterOwnership(options: {
  db: Database.Database;
  agentDaemon: AgentDaemon;
  runtime: KitWriterRuntime;
}): KitWriterOwnership {
  const { db } = options;
  return new KitWriterOwnership({
    port: createMemoryStatementPort(db),
    agentDaemon: options.agentDaemon,
    runtime: options.runtime,
    writers: [
      { name: "CrossSignalService", create: () => new CrossSignalService(db) },
      { name: "FeedbackService", create: () => new FeedbackService(db) },
    ],
  });
}
