import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { QueuedAttachmentRecoveryError, QueuedAttachmentStore } from "../queued-attachment-store";

const tempRoots: string[] = [];

function createStore(): QueuedAttachmentStore {
  const root = mkdtempSync(path.join(tmpdir(), "cowork-queued-attachments-"));
  tempRoots.push(root);
  return new QueuedAttachmentStore(path.join(root, "store"));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("QueuedAttachmentStore", () => {
  it("writes opaque, durable records before a receipt can reference them", () => {
    const store = createStore();
    const persistence = store.persist("task-1", "message-1", [
      {
        data: "aGVsbG8=",
        mimeType: "image/png",
        filename: "hello.png",
        sizeBytes: 5,
      },
    ]);

    expect(persistence.refs).toEqual([
      {
        key: expect.stringMatching(/^[0-9a-f-]{36}$/),
        mimeType: "image/png",
        filename: "hello.png",
        sizeBytes: 5,
      },
    ]);
    expect(JSON.stringify(persistence.refs)).not.toContain("aGVsbG8=");
    expect(persistence.refs[0]).not.toHaveProperty("filePath");
    expect(statSync(store.rootDir).mode & 0o777).toBe(0o700);
    const filePath = persistence.images[0].filePath!;
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(filePath, "utf8")).toBe("hello");
    expect(store.hydrate("task-1", "message-1", persistence.refs)).toEqual([
      expect.objectContaining({
        filePath,
        mimeType: "image/png",
        filename: "hello.png",
        sizeBytes: 5,
        tempFile: false,
      }),
    ]);
  });

  it("copies source files so a temp source can disappear after acceptance", () => {
    const store = createStore();
    const source = path.join(path.dirname(store.rootDir), "source.png");
    writeFileSync(source, Buffer.from("source-bytes"));
    const persistence = store.persist("task-1", "message-1", [
      {
        filePath: source,
        mimeType: "image/png",
        filename: "source.png",
        sizeBytes: 12,
        tempFile: true,
      },
    ]);
    unlinkSync(source);
    expect(readFileSync(persistence.images[0].filePath!, "utf8")).toBe("source-bytes");
    expect(store.hydrate("task-1", "message-1", persistence.refs)[0].filePath).toBe(
      persistence.images[0].filePath,
    );
  });

  it("rejects declared sizes that underreport the durable bytes", () => {
    const store = createStore();
    expect(() =>
      store.persist("task-1", "message-1", [
        { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 1 },
      ]),
    ).toThrow(/declared size does not match/i);
  });

  it("rejects cross-task references, missing bytes, corrupt bytes, and symlink substitution", () => {
    const store = createStore();
    const persistence = store.persist("task-1", "message-1", [
      { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
    ]);
    const ref = persistence.refs;

    expect(() => store.hydrate("task-2", "message-1", ref)).toThrow(QueuedAttachmentRecoveryError);

    const contentPath = persistence.images[0].filePath!;
    unlinkSync(contentPath);
    expect(() => store.hydrate("task-1", "message-1", ref)).toThrow(
      /attachment bytes are missing/i,
    );

    const second = store.persist("task-1", "message-2", [
      { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
    ]);
    writeFileSync(second.images[0].filePath!, "tampered");
    expect(() => store.hydrate("task-1", "message-2", second.refs)).toThrow(
      /integrity validation/i,
    );

    const third = store.persist("task-1", "message-3", [
      { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
    ]);
    const symlinkTarget = path.join(store.rootDir, "outside");
    writeFileSync(symlinkTarget, "outside");
    unlinkSync(third.images[0].filePath!);
    symlinkSync(symlinkTarget, third.images[0].filePath!);
    expect(() => store.hydrate("task-1", "message-3", third.refs)).toThrow(/regular file/i);
  });

  it("releases only owned records after durable delivery", () => {
    const store = createStore();
    const persistence = store.persist("task-1", "message-1", [
      { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
    ]);
    const contentPath = persistence.images[0].filePath!;
    store.release("task-2", "message-1", persistence.refs);
    expect(() => store.hydrate("task-1", "message-1", persistence.refs)).not.toThrow();
    store.release("task-1", "message-1", persistence.refs);
    expect(() => store.hydrate("task-1", "message-1", persistence.refs)).toThrow(
      /manifest is missing/i,
    );
    expect(() => readFileSync(contentPath)).toThrow();
  });

  it("cleans an aged content-only crash orphan while preserving recent bytes", () => {
    const store = createStore();
    const persisted = store.persist("task-1", "message-1", [
      { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
    ]);
    const contentPath = persisted.images[0].filePath!;
    unlinkSync(path.join(store.rootDir, `${persisted.refs[0].key}.json`));
    const oldSeconds = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(contentPath, oldSeconds, oldSeconds);

    expect(store.cleanupOrphanedContentFiles(Date.now() - 24 * 60 * 60 * 1000, () => false)).toBe(
      1,
    );
    expect(() => readFileSync(contentPath)).toThrow();

    const recent = store.persist("task-1", "message-2", [
      { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
    ]);
    unlinkSync(path.join(store.rootDir, `${recent.refs[0].key}.json`));
    expect(store.cleanupOrphanedContentFiles(Date.now() - 24 * 60 * 60 * 1000, () => false)).toBe(
      0,
    );
    expect(readFileSync(recent.images[0].filePath!, "utf8")).toBe("hello");
  });
});
