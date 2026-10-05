/**
 * Cross-process write lock of the memory repo (docs/memory-repo-phase1-design.md §5.5).
 *
 * The desktop app, the node daemon and parallel tasks all write through one
 * `MemoryRepoService` per process; writes are short, so a lock file created with `O_EXCL`
 * serializes them across processes. A lock older than `staleMs` whose process is gone is
 * taken over.
 */
import fs from "node:fs/promises";

export interface MemoryRepoLockOptions {
  /** Give up after this long (default 5 s). */
  timeoutMs?: number;
  /** A lock this old may be taken over when its pid is gone (default 30 s). */
  staleMs?: number;
  runtime?: string;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
}

export class MemoryRepoBusyError extends Error {
  constructor() {
    super("The memory repo is busy with another write; retry in a moment.");
    this.name = "MemoryRepoBusyError";
  }
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function takeOverIfStale(
  lockPath: string,
  staleMs: number,
  now: number,
  isPidAlive: (pid: number) => boolean,
): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const holder = JSON.parse(raw) as { pid?: number; at?: number };
    const age = now - Number(holder.at ?? 0);
    if (age < staleMs) return false;
    if (typeof holder.pid === "number" && isPidAlive(holder.pid) && holder.pid !== process.pid) {
      return false;
    }
  } catch {
    // Unreadable or half-written: judge by the file's age.
    try {
      const stat = await fs.stat(lockPath);
      if (now - stat.mtimeMs < staleMs) return false;
    } catch {
      return true;
    }
  }
  await fs.rm(lockPath, { force: true });
  return true;
}

/** Run `job` while holding `lockPath`. Throws MemoryRepoBusyError when it cannot be taken. */
export async function withMemoryRepoLock<T>(
  lockPath: string,
  job: () => Promise<T>,
  options: MemoryRepoLockOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 30_000;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const deadline = now() + timeoutMs;
  let handle: fs.FileHandle | null = null;
  for (;;) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      if (await takeOverIfStale(lockPath, staleMs, now(), isPidAlive)) continue;
      if (now() >= deadline) throw new MemoryRepoBusyError();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, runtime: options.runtime ?? "unknown", at: now() }),
    );
    await handle.close();
    handle = null;
    return await job();
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}
