import fs from "fs";
import path from "path";
import { createHash } from "crypto";

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
  fs.mkdirSync(dir, { recursive: true });

  const snapshotRoot = getKitSnapshotRoot(absPath);
  fs.mkdirSync(snapshotRoot, { recursive: true });

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
