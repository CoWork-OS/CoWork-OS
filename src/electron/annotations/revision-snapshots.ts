import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** Files larger than this are hashed but not kept, so their changes cannot be undone. */
export const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;
/** Kept bytes unused for this long are removed; undo then reports that the bytes are gone. */
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface FileSnapshot {
  sha256: string;
  size: number;
  /** True when the bytes are kept and can be restored. */
  kept: boolean;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * The bytes of artifact revisions, by SHA-256, so a revision can be restored. A revision row only
 * records the hash; this keeps the content of files a user pointed at and of the changes made to
 * them (up to 25 MB a file, 30 days after last use).
 */
export class RevisionSnapshotStore {
  constructor(
    private readonly root: string,
    private readonly maxBytes = MAX_SNAPSHOT_BYTES,
  ) {}

  private blobPath(sha256: string): string {
    if (!SHA256_PATTERN.test(sha256)) throw new Error("Invalid revision hash");
    return path.join(this.root, sha256.slice(0, 2), sha256);
  }

  async has(sha256: string): Promise<boolean> {
    try {
      await fs.access(this.blobPath(sha256));
      return true;
    } catch {
      return false;
    }
  }

  /** Hash a file and keep its bytes when it is small enough. Undefined when it does not exist. */
  async capture(filePath: string): Promise<FileSnapshot | undefined> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return undefined;
    }
    if (!stat.isFile()) return undefined;
    if (stat.size > this.maxBytes) {
      return { sha256: await hashFile(filePath), size: stat.size, kept: false };
    }
    const bytes = await fs.readFile(filePath);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const target = this.blobPath(sha256);
    const now = new Date();
    try {
      await fs.utimes(target, now, now);
    } catch {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temp, bytes, { mode: 0o600 });
      await fs.rename(temp, target);
    }
    return { sha256, size: bytes.length, kept: true };
  }

  /** Write the kept bytes of `sha256` to `destPath`, replacing it in one step. */
  async restore(sha256: string, destPath: string): Promise<void> {
    const bytes = await fs.readFile(this.blobPath(sha256));
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new Error("The kept copy of this revision is damaged.");
    }
    const temp = path.join(
      path.dirname(destPath),
      `.${path.basename(destPath)}.${crypto.randomUUID()}.restore`,
    );
    await fs.writeFile(temp, bytes);
    try {
      const mode = (await fs.stat(destPath).catch(() => undefined))?.mode;
      if (mode !== undefined) await fs.chmod(temp, mode & 0o7777);
      await fs.rename(temp, destPath);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  /** Remove kept bytes not used for `maxAgeMs`. Returns how many were removed. */
  async prune(now = Date.now(), maxAgeMs = SNAPSHOT_RETENTION_MS): Promise<number> {
    let removed = 0;
    let shards: string[];
    try {
      shards = await fs.readdir(this.root);
    } catch {
      return 0;
    }
    for (const shard of shards) {
      const dir = path.join(this.root, shard);
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        try {
          const stat = await fs.stat(file);
          if (now - stat.mtimeMs > maxAgeMs) {
            await fs.rm(file, { force: true });
            removed += 1;
          }
        } catch {
          // Removed concurrently.
        }
      }
    }
    return removed;
  }
}
