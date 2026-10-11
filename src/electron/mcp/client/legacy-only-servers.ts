/**
 * Remembers MCP servers that exit when probed with `server/discover` and must be
 * started with the classic `initialize` handshake instead.
 *
 * Without persistence every app launch probes such a server once, it exits, and it is
 * started a second time. Once a file is configured with `persistTo`, entries survive
 * restarts. Entries are re-checked after a week so an upgraded server gets probed again.
 *
 * Keys are hashed before they are stored: they include the server's command, args and
 * URL, which can carry tokens.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createLogger } from "../../utils/logger";

const logger = createLogger("MCP LegacyOnlyServers");

export const LEGACY_ONLY_SERVERS_FILE = "mcp-initialize-only-servers.json";
export const LEGACY_ONLY_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredFile {
  version: 1;
  /** sha256(key) -> when the server was last seen rejecting discovery (epoch ms). */
  servers: Record<string, number>;
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export class LegacyOnlyServerStore {
  private entries = new Map<string, number>();
  private filePath: string | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Load saved entries from `filePath` and save changes there from now on. */
  persistTo(filePath: string): void {
    this.filePath = filePath;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<StoredFile>;
      if (parsed?.version !== 1 || !parsed.servers || typeof parsed.servers !== "object") return;
      for (const [hash, recordedAt] of Object.entries(parsed.servers)) {
        if (/^[0-9a-f]{64}$/.test(hash) && Number.isFinite(recordedAt)) {
          // Keep entries recorded in this session; they are newer than the file.
          if (!this.entries.has(hash)) this.entries.set(hash, recordedAt);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.debug("Ignoring unreadable initialize-only server list:", error);
      }
    }
  }

  has(key: string): boolean {
    const hash = hashKey(key);
    const recordedAt = this.entries.get(hash);
    if (recordedAt === undefined) return false;
    if (this.now() - recordedAt > LEGACY_ONLY_RECHECK_MS) {
      this.entries.delete(hash);
      this.save();
      return false;
    }
    return true;
  }

  add(key: string): void {
    this.entries.set(hashKey(key), this.now());
    this.save();
  }

  private save(): void {
    if (!this.filePath) return;
    const contents: StoredFile = { version: 1, servers: Object.fromEntries(this.entries) };
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(contents), { mode: 0o600 });
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      // Best effort: the in-memory entry still spares reconnects this session.
      logger.debug("Could not save initialize-only server list:", error);
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Nothing left to clean up.
      }
    }
  }
}

/**
 * Shared by every connection, keyed by how a server is launched or reached, so
 * reconnects (and, once the client manager persists it, later launches) go straight
 * to `initialize`.
 */
export const legacyOnlyServers = new LegacyOnlyServerStore();
