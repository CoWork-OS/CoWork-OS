import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getUserDataDir } from "../../utils/user-data-dir";

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
  pending(): SpaceRun[] {
    const pending: SpaceRun[] = [];
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const file = path.join(this.directory, name);
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
            (!Number.isFinite(run.deleteRequestedAt) ||
              run.deleteRequestedAt > Date.now() + 60_000)) ||
          typeof run.createKey !== "string" ||
          typeof run.deleteKey !== "string" ||
          !Array.isArray(run.published)
        )
          throw new Error("Invalid SPACE journal identity");
        if (!["deleted", "create_rejected"].includes(run.phase)) pending.push(run);
      } finally {
        fs.closeSync(fd);
      }
    }
    return pending;
  }
}
