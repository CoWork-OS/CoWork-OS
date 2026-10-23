import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RevisionSnapshotStore } from "../revision-snapshots";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "revision-snapshots-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

describe("RevisionSnapshotStore", () => {
  it("keeps a file's bytes by hash and restores them", async () => {
    const store = new RevisionSnapshotStore(path.join(dir, "kept"));
    const file = path.join(dir, "notes.md");
    await fs.writeFile(file, "first");
    await fs.chmod(file, 0o640);

    const snapshot = await store.capture(file);
    expect(snapshot).toEqual({ sha256: sha("first"), size: 5, kept: true });
    expect(await store.has(sha("first"))).toBe(true);

    await fs.writeFile(file, "second");
    await store.restore(sha("first"), file);
    expect(await fs.readFile(file, "utf8")).toBe("first");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".restore"))).toEqual([]);
  });

  it("hashes but does not keep a file over the size limit", async () => {
    const store = new RevisionSnapshotStore(path.join(dir, "kept"), 3);
    const file = path.join(dir, "big.bin");
    await fs.writeFile(file, "too big");
    expect(await store.capture(file)).toEqual({ sha256: sha("too big"), size: 7, kept: false });
    expect(await store.has(sha("too big"))).toBe(false);
  });

  it("returns nothing for a missing file or a directory", async () => {
    const store = new RevisionSnapshotStore(path.join(dir, "kept"));
    expect(await store.capture(path.join(dir, "missing"))).toBeUndefined();
    expect(await store.capture(dir)).toBeUndefined();
  });

  it("refuses a damaged copy and a malformed hash", async () => {
    const root = path.join(dir, "kept");
    const store = new RevisionSnapshotStore(root);
    const file = path.join(dir, "a.txt");
    await fs.writeFile(file, "original");
    await store.capture(file);
    const hash = sha("original");
    await fs.writeFile(path.join(root, hash.slice(0, 2), hash), "tampered");

    await expect(store.restore(hash, file)).rejects.toThrow("damaged");
    await expect(store.restore("../../etc/passwd", file)).rejects.toThrow("Invalid revision hash");
    expect(await fs.readFile(file, "utf8")).toBe("original");
  });

  it("prunes copies unused for longer than the retention", async () => {
    const store = new RevisionSnapshotStore(path.join(dir, "kept"));
    const file = path.join(dir, "a.txt");
    await fs.writeFile(file, "old");
    await store.capture(file);
    const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
    expect(await store.prune(Date.now())).toBe(0);
    expect(await store.prune(later)).toBe(1);
    expect(await store.has(sha("old"))).toBe(false);
  });
});
