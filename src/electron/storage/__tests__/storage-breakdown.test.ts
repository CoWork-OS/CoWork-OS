import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatStorageBytes } from "../../../shared/storage-usage";
import {
  categoryForEntry,
  databaseCopyFiles,
  scanStorage,
  trashDatabaseCopies,
} from "../storage-breakdown";

let root: string;
let outside: string;

function file(rel: string, bytes: number) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-storage-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-storage-outside-"));
  file("cowork-os.db", 1000);
  file("cowork-os.db-wal", 200);
  file("cowork-os.pre-cleanup-20260101.db", 500);
  file("cowork-os.pre-cleanup-20260101.db-shm", 50);
  file("backups/cowork-os-20260405.db", 300);
  file("backups/cowork-os-20260405.db-wal", 30);
  file("Partitions/cowork-browser-a/Cache/data", 400);
  file("Partitions/cowork-browser-a/Local Storage/leveldb", 70);
  file("Code Cache/js", 60);
  file("artifact-revisions/blob", 40);
  file("chronicle/frame.jpg", 25);
  file("memory-repo/me.md", 10);
  file("skills/s/SKILL.md", 5);
  file("Preferences", 3);
  file("backups/legacy-memory-20261001.json.enc", 7);
  fs.writeFileSync(path.join(outside, "big"), Buffer.alloc(5000));
  fs.symlinkSync(path.join(outside, "big"), path.join(root, "linked"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("scanStorage", () => {
  it("adds up each kind of data and lists the database copies", async () => {
    const result = await scanStorage(root, { nowMs: 1 });
    const bytes = Object.fromEntries(result.categories.map((c) => [c.id, c.bytes]));
    expect(bytes).toMatchObject({
      database: 1200,
      database_copies: 887,
      cache: 460,
      browser_data: 70,
      undo_history: 40,
      chronicle: 25,
      memory: 10,
      skills_tools: 5,
    });
    // The link counts as a link, never as the 5,000-byte file it points to.
    expect(bytes.other).toBeLessThan(1000);
    expect(result.totalBytes).toBe(result.categories.reduce((sum, c) => sum + c.bytes, 0));
    expect(result.partial).toBe(false);
    expect(result.disk?.freeBytes).toBeGreaterThan(0);
    expect(
      result.databaseCopies.map(({ id, name, folder, bytes: size }) => ({
        id,
        name,
        folder,
        size,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          id: "profile/cowork-os.pre-cleanup-20260101.db",
          name: "cowork-os.pre-cleanup-20260101.db",
          folder: "profile",
          size: 550,
        },
        {
          id: "backups/cowork-os-20260405.db",
          name: "cowork-os-20260405.db",
          folder: "backups",
          size: 330,
        },
      ]),
    );
    expect(result.databaseCopies).toHaveLength(3);
    expect(result.databaseCopies.filter((copy) => copy.onlyCopy).map((copy) => copy.name)).toEqual([
      "legacy-memory-20261001.json.enc",
    ]);
  });

  it("reports a partial count when it runs out of time", async () => {
    const result = await scanStorage(root, { maxScanMs: -1 });
    expect(result.partial).toBe(true);
  });
});

describe("categories", () => {
  it("never takes the live database for a copy", () => {
    expect(categoryForEntry("cowork-os.db")).toBe("database");
    expect(categoryForEntry("cowork-os.db-shm")).toBe("database");
    expect(categoryForEntry("cowork-os.db.bak")).toBe("database_copies");
    expect(categoryForEntry("cowork-os.pre-reset.db")).toBe("database_copies");
    expect(categoryForEntry("cowork-os.db.bak.metric-cleanup.20260304")).toBe("database_copies");
    for (const busy of ["cowork-os.db.tmp", "cowork-os.db-migrating", "cowork-os.db.lock"]) {
      expect(categoryForEntry(busy)).toBe("other");
    }
    expect(categoryForEntry("GPUCache")).toBe("cache");
    expect(categoryForEntry("workspace-123")).toBe("files");
    expect(categoryForEntry("settings.json")).toBe("other");
  });
});

describe("database copies", () => {
  it("resolves a copy to its files and refuses anything else", async () => {
    expect(
      (await databaseCopyFiles(root, "profile/cowork-os.pre-cleanup-20260101.db")).map((p) =>
        path.basename(p),
      ),
    ).toEqual(["cowork-os.pre-cleanup-20260101.db", "cowork-os.pre-cleanup-20260101.db-shm"]);
    for (const id of [
      "profile/cowork-os.db",
      "profile/Preferences",
      "backups/../cowork-os.db",
      "backups/..",
      "other/cowork-os.db",
      "profile/skills/s",
      "/etc/passwd",
    ]) {
      expect(await databaseCopyFiles(root, id)).toEqual([]);
    }
  });

  it("moves copies to the Trash with their -wal and -shm, and reports unknown ids", async () => {
    const trashed: string[] = [];
    const result = await trashDatabaseCopies(
      root,
      ["backups/cowork-os-20260405.db", "profile/cowork-os.db", "backups/missing.db"],
      async (target) => {
        trashed.push(path.relative(root, target));
      },
    );
    expect(trashed.sort()).toEqual([
      path.join("backups", "cowork-os-20260405.db"),
      path.join("backups", "cowork-os-20260405.db-wal"),
    ]);
    expect(result.trashed).toEqual(["backups/cowork-os-20260405.db"]);
    expect(result.failed.map((item) => item.name)).toEqual([
      "profile/cowork-os.db",
      "backups/missing.db",
    ]);
  });

  it("reports a copy the Trash refused", async () => {
    const result = await trashDatabaseCopies(
      root,
      ["profile/cowork-os.pre-cleanup-20260101.db"],
      async () => {
        throw new Error("Trash unavailable");
      },
    );
    expect(result).toEqual({
      trashed: [],
      failed: [
        { name: "profile/cowork-os.pre-cleanup-20260101.db", reason: "The Trash refused it." },
      ],
    });
  });
});

describe("formatStorageBytes", () => {
  it("shows sizes as Finder does", () => {
    expect(formatStorageBytes(0)).toBe("0 KB");
    expect(formatStorageBytes(400)).toBe("1 KB");
    expect(formatStorageBytes(1_500_000)).toBe("1.5 MB");
    expect(formatStorageBytes(6_600_000_000)).toBe("6.6 GB");
    expect(formatStorageBytes(123_000_000)).toBe("123 MB");
  });
});
