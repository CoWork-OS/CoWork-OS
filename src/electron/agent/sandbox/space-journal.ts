import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getUserDataDir } from "../../utils/user-data-dir";
import { createLogger } from "../../utils/logger";

const log = createLogger("SpaceJournal");
const TERMINAL_PHASES = new Set(["deleted", "create_rejected", "abandoned"]);
const RETAIN_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SpaceRun {
  version: 1;
  id: string;
  pid: number;
  createdAt: number;
  apiUrl: string;
  dataPlaneUrl: string;
  createBody: Record<string, unknown>;
  createKey: string;
  deleteKey: string;
  sandboxId?: string;
  createOperationId?: string;
  deleteOperationId?: string;
  deleteRequestedAt?: number;
  phase: string;
  commandKey?: string;
  processId?: string;
  stdout?: string;
  stderr?: string;
  published: string[];
  artifacts?: Array<{ path: string; sha256: string }>;
  outcomeUnknown?: boolean;
}

/** Host-private storage. Nothing goes in the workspace or VM. Tokens are never saved. */
export class SpaceJournal {
  readonly directory: string;
  constructor(workspacePath: string, apiUrl: string) {
    const key = createHash("sha256")
      .update(apiUrl + "\0" + path.resolve(workspacePath))
      .digest("hex");
    this.directory = path.join(getUserDataDir(), "space-runs", key);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink())
      throw new Error("Unsafe SPACE journal directory");
  }
  save(run: SpaceRun): void {
    const target = path.join(this.directory, `${run.id}.json`);
    const temporary = path.join(this.directory, `${run.id}.${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(run));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, target);
      // fsync the containing directory as well as the file before effects.
      if (process.platform !== "win32") {
        const directory = fs.openSync(this.directory, "r");
        try {
          fs.fsyncSync(directory);
        } finally {
          fs.closeSync(directory);
        }
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  /** Drops a run's record once nothing about it needs reconciling or inspecting. */
  remove(id: string): void {
    fs.rmSync(path.join(this.directory, `${id}.json`), { force: true });
  }
  pending(): SpaceRun[] {
    const pending: SpaceRun[] = [];
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const file = path.join(this.directory, name);
      let run: SpaceRun;
      try {
        run = readRun(file, name);
      } catch (error) {
        // One unreadable record must not block every later run; it stays for inspection.
        log.warn(`Skipping SPACE journal ${name}: ${(error as Error).message}`);
        continue;
      }
      if (!TERMINAL_PHASES.has(run.phase)) pending.push(run);
      // Records kept only for inspection (unknown outcomes, abandoned cleanup) expire.
      else if (Date.now() - run.createdAt > RETAIN_TERMINAL_MS) fs.rmSync(file, { force: true });
    }
    return pending;
  }
}

function readRun(file: string, name: string): SpaceRun {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 16 * 1024 * 1024)
      throw new Error("Invalid SPACE journal size");
    const run = JSON.parse(fs.readFileSync(fd, "utf8")) as SpaceRun;
    if (
      run.version !== 1 ||
      `${run.id}.json` !== name ||
      !Number.isFinite(run.createdAt) ||
      run.createdAt > Date.now() + 60_000 ||
      (run.deleteRequestedAt !== undefined &&
        (!Number.isFinite(run.deleteRequestedAt) || run.deleteRequestedAt > Date.now() + 60_000)) ||
      typeof run.createKey !== "string" ||
      typeof run.deleteKey !== "string" ||
      !Array.isArray(run.published)
    )
      throw new Error("Invalid SPACE journal identity");
    return run;
  } finally {
    fs.closeSync(fd);
  }
}
