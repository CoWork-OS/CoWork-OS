import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { ensureWorkspaceDirectorySync } from "../utils/workspace-directory";

function ensureKitDirectory(absPath: string, directory: string): void {
  let ancestor = path.dirname(absPath);
  while (path.dirname(ancestor) !== ancestor) {
    if (path.basename(ancestor) === ".cowork") {
      ensureWorkspaceDirectorySync(path.dirname(ancestor), directory);
      return;
    }
    ancestor = path.dirname(ancestor);
  }
  // Non-kit callers must already have a parent directory, too.
  ensureWorkspaceDirectorySync(path.dirname(absPath), directory);
}

export interface KitRevisionMeta {
  file: string;
  changedBy: "user" | "agent" | "system";
  reason?: string;
  sha256: string;
  createdAt: string;
}

export type KitRevisionPathGuard = (absPath: string, operation: "read" | "write") => void;

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function getKitSnapshotRoot(absPath: string): string {
  return path.join(path.dirname(absPath), ".history", path.basename(absPath));
}

export function getKitRevisionCount(absPath: string): number {
  const snapshotRoot = getKitSnapshotRoot(absPath);
  const revisionsPath = path.join(snapshotRoot, "revisions.jsonl");
  if (!fs.existsSync(revisionsPath)) return 0;
  try {
    const raw = fs.readFileSync(revisionsPath, "utf8").trim();
    if (!raw) return 0;
    return raw.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function writeKitFileWithSnapshot(
  absPath: string,
  content: string,
  changedBy: KitRevisionMeta["changedBy"],
  reason?: string,
  pathGuard?: KitRevisionPathGuard,
): void {
  const alreadyExists = fs.existsSync(absPath);
  if (alreadyExists) pathGuard?.(absPath, "read");

  const existing = alreadyExists ? fs.readFileSync(absPath, "utf8") : null;
  const nextSha = sha(content);
  const prevSha = existing ? sha(existing) : null;

  if (existing !== null && prevSha === nextSha) {
    return;
  }

  // Guard the final target before creating any snapshot side effects. This
  // keeps a narrow profile from receiving a partial history write when the
  // requested file itself is not writable.
  pathGuard?.(absPath, "write");
  const dir = path.dirname(absPath);
  ensureKitDirectory(absPath, dir);

  const snapshotRoot = getKitSnapshotRoot(absPath);
  pathGuard?.(snapshotRoot, "write");
  ensureKitDirectory(absPath, snapshotRoot);

  if (existing !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotPath = path.join(snapshotRoot, `${stamp}.md`);
    pathGuard?.(snapshotPath, "write");
    fs.writeFileSync(snapshotPath, existing, "utf8");

    const meta: KitRevisionMeta = {
      file: path.basename(absPath),
      changedBy,
      reason,
      sha256: prevSha!,
      createdAt: new Date().toISOString(),
    };

    const revisionsPath = path.join(snapshotRoot, "revisions.jsonl");
    pathGuard?.(revisionsPath, "write");
    fs.appendFileSync(revisionsPath, JSON.stringify(meta) + "\n", "utf8");
  }

  fs.writeFileSync(absPath, content, "utf8");
}

const KIT_SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.md$/;

export const KIT_SNAPSHOT_RETENTION_DEFAULTS = {
  /** Newest snapshots kept per kit file. */
  keep: 20,
  /** Snapshots older than this are removed (the newest one is always kept). */
  maxAgeMs: 90 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Bound one kit file's `.history/<file>/` directory (audit LIFE-3): keep the newest
 * `keep` snapshots that are younger than `maxAgeMs`, always keeping the newest one, and
 * trim `revisions.jsonl` to the same number of entries (one entry is appended per
 * snapshot). Only regular files named like snapshots are removed; a symlinked history
 * directory is left alone. Returns the number of snapshots removed.
 */
export function pruneKitSnapshots(
  snapshotRoot: string,
  options: { keep?: number; maxAgeMs?: number; now?: number } = {},
): number {
  const keep = Math.max(1, options.keep ?? KIT_SNAPSHOT_RETENTION_DEFAULTS.keep);
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? KIT_SNAPSHOT_RETENTION_DEFAULTS.maxAgeMs);
  const now = options.now ?? Date.now();
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(snapshotRoot);
  } catch {
    return 0;
  }
  if (!rootStat.isDirectory()) return 0;

  const snapshots = fs
    .readdirSync(snapshotRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && KIT_SNAPSHOT_NAME.test(entry.name))
    .map((entry) => {
      const filePath = path.join(snapshotRoot, entry.name);
      return { filePath, name: entry.name, mtimeMs: fs.lstatSync(filePath).mtimeMs };
    })
    // ISO stamps sort chronologically by name; newest first.
    .sort((a, b) => b.name.localeCompare(a.name));

  let removed = 0;
  snapshots.forEach((snapshot, index) => {
    if (index === 0) return;
    if (index < keep && now - snapshot.mtimeMs <= maxAgeMs) return;
    fs.rmSync(snapshot.filePath, { force: true });
    removed += 1;
  });

  const revisionsPath = path.join(snapshotRoot, "revisions.jsonl");
  const kept = snapshots.length - removed;
  try {
    const stat = fs.lstatSync(revisionsPath);
    if (stat.isFile()) {
      const lines = fs.readFileSync(revisionsPath, "utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length > kept) {
        const trimmed = lines.slice(-kept);
        fs.writeFileSync(revisionsPath, trimmed.length ? `${trimmed.join("\n")}\n` : "", "utf8");
      }
    }
  } catch {
    // No revision log; nothing to trim.
  }
  return removed;
}
