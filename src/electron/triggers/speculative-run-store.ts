/**
 * Durable list of recent speculative reproduce-and-fix runs, so their outcomes survive a
 * restart and a run interrupted by one is finished on the next start. A small JSON file in the
 * app's data folder: it holds at most MAX_STORED_SPECULATIVE_RUNS records and no secrets.
 */
import * as fs from "fs";
import * as path from "path";
import type { SpeculativeRun } from "../../shared/types";

export const MAX_STORED_SPECULATIVE_RUNS = 200;

export interface SpeculativeRunStore {
  load(): Promise<SpeculativeRun[]>;
  save(runs: SpeculativeRun[]): Promise<void>;
}

function isRunRecord(value: unknown): value is SpeculativeRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Partial<SpeculativeRun>;
  return (
    typeof run.id === "string" &&
    typeof run.triggerId === "string" &&
    typeof run.workspaceId === "string" &&
    typeof run.status === "string" &&
    typeof run.outcome === "string" &&
    typeof run.startedAt === "number" &&
    typeof run.deadlineAt === "number" &&
    !!run.origin &&
    typeof run.origin === "object"
  );
}

/** Newest first, bounded; a running run is never dropped. */
export function boundSpeculativeRuns(runs: SpeculativeRun[]): SpeculativeRun[] {
  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
  if (sorted.length <= MAX_STORED_SPECULATIVE_RUNS) return sorted;
  const running = sorted.filter((run) => run.status === "running");
  const finished = sorted.filter((run) => run.status !== "running");
  return [
    ...running,
    ...finished.slice(0, Math.max(0, MAX_STORED_SPECULATIVE_RUNS - running.length)),
  ].sort((a, b) => b.startedAt - a.startedAt);
}

export class FileSpeculativeRunStore implements SpeculativeRunStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<SpeculativeRun[]> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as { runs?: unknown };
      return Array.isArray(parsed?.runs) ? parsed.runs.filter(isRunRecord) : [];
    } catch {
      // A damaged file only loses the run history; it must not stop new runs.
      return [];
    }
  }

  save(runs: SpeculativeRun[]): Promise<void> {
    const body = JSON.stringify({ version: 1, runs: boundSpeculativeRuns(runs) });
    const write = async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
      await fs.promises.rename(temp, this.filePath);
    };
    // Writes go out in order; a failed write does not block the next one.
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => undefined);
    return next;
  }
}

export class MemorySpeculativeRunStore implements SpeculativeRunStore {
  runs: SpeculativeRun[] = [];

  constructor(initial: SpeculativeRun[] = []) {
    this.runs = initial.map((run) => structuredClone(run));
  }

  async load(): Promise<SpeculativeRun[]> {
    return this.runs.map((run) => structuredClone(run));
  }

  async save(runs: SpeculativeRun[]): Promise<void> {
    this.runs = boundSpeculativeRuns(runs).map((run) => structuredClone(run));
  }
}
