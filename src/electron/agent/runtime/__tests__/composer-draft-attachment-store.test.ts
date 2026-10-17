import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ComposerDraftAttachmentStore } from "../composer-draft-attachment-store";
import {
  isApprovedImportFile,
  rememberApprovedImportFiles,
} from "../../../security/file-import-approvals";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ComposerDraftAttachmentStore", () => {
  it("imports restored staged bytes with their original name and MIME after restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-draft-attachments-"));
    temporaryDirectories.push(directory);
    const store = new ComposerDraftAttachmentStore(directory);
    const ref = await store.put({
      draftKey: "local:workspace:new:main",
      workspaceId: "workspace",
      name: "dinner-notes.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("Dinner for four").toString("base64"),
    });
    const resolved = await store.resolve("local:workspace:new:main", "workspace", ref.refId);
    expect(resolved).not.toBeNull();
    const restoredStore = new ComposerDraftAttachmentStore(directory);
    const imported = await restoredStore.readForWorkspaceImport(resolved!.path, "workspace");
    expect(imported?.ref).toMatchObject({ name: "dinner-notes.txt", mimeType: "text/plain" });
    expect(imported?.bytes.toString()).toBe("Dinner for four");
    expect(isApprovedImportFile(resolved!.path)).toBe(false);
    expect(
      await restoredStore.readForWorkspaceImport(resolved!.path, "another-workspace"),
    ).toBeNull();
    await store.release("local:workspace:new:main", "workspace", ref.refId);
    expect(await restoredStore.readForWorkspaceImport(resolved!.path, "workspace")).toBeNull();
  });

  it("rejects tampered cache bytes, invalid metadata, and unregistered cache neighbors", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-draft-attachments-"));
    temporaryDirectories.push(directory);
    const store = new ComposerDraftAttachmentStore(directory);
    const ref = await store.put({
      draftKey: "local:workspace:new:main",
      workspaceId: "workspace",
      name: "notes.txt",
      dataBase64: Buffer.from("original").toString("base64"),
    });
    const resolved = (await store.resolve("local:workspace:new:main", "workspace", ref.refId))!;
    await writeFile(resolved.path, "modified");
    expect(await store.readForWorkspaceImport(resolved.path, "workspace")).toBeNull();
    await writeFile(resolved.path, "original");
    const metadataPath = resolved.path.replace(/\.bin$/, ".json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, workspaceId: "another-workspace" }),
    );
    expect(await store.readForWorkspaceImport(resolved.path, "workspace")).toBeNull();
    await writeFile(metadataPath, JSON.stringify({ ...metadata, refId: "a".repeat(32) }));
    expect(await store.readForWorkspaceImport(resolved.path, "workspace")).toBeNull();
    const neighbor = path.join(path.dirname(resolved.path), `${"b".repeat(32)}.bin`);
    await writeFile(neighbor, "original");
    expect(await store.readForWorkspaceImport(neighbor, "workspace")).toBeNull();
    expect(
      await store.readForWorkspaceImport(path.join(directory, "outside.txt"), "workspace"),
    ).toBeNull();
  });

  it("rejects a staged file replaced by a symbolic link even when the bytes match", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-draft-attachments-"));
    temporaryDirectories.push(directory);
    const store = new ComposerDraftAttachmentStore(directory);
    const ref = await store.put({
      draftKey: "local:workspace:new:main",
      workspaceId: "workspace",
      name: "notes.txt",
      dataBase64: Buffer.from("original").toString("base64"),
    });
    const resolved = (await store.resolve("local:workspace:new:main", "workspace", ref.refId))!;
    const outside = path.join(directory, "outside.txt");
    await writeFile(outside, "original");
    await unlink(resolved.path);
    await symlink(outside, resolved.path);
    expect(await store.readForWorkspaceImport(resolved.path, "workspace")).toBeNull();
  });

  it("rekeys staged bytes with their draft owner", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-draft-attachments-"));
    temporaryDirectories.push(directory);
    const store = new ComposerDraftAttachmentStore(directory);
    const sourceDraftKey = "local:workspace:new:main";
    const destinationDraftKey = "local:workspace:task-1:main";

    const ref = await store.put({
      draftKey: sourceDraftKey,
      workspaceId: "workspace",
      name: "note.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("hello draft").toString("base64"),
    });

    expect(await store.resolve(sourceDraftKey, "workspace", ref.refId)).not.toBeNull();
    expect(await store.rekeyDraft(sourceDraftKey, destinationDraftKey, "workspace")).toBe(1);
    expect(await store.resolve(sourceDraftKey, "workspace", ref.refId)).toBeNull();

    const resolved = await store.resolve(destinationDraftKey, "workspace", ref.refId);
    expect(resolved?.ref.sha256).toBe(ref.sha256);
    expect(resolved?.path ? await readFile(resolved.path, "utf8") : null).toBe("hello draft");
  });

  it("reconciles orphaned pairs, data-only files, and temporary files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-draft-attachments-"));
    temporaryDirectories.push(directory);
    const store = new ComposerDraftAttachmentStore(directory);
    const workspaceDirectory = path.join(
      directory,
      createHash("sha256").update("workspace").digest("hex"),
    );
    await mkdir(workspaceDirectory, { recursive: true });
    await writeFile(path.join(workspaceDirectory, "orphan.bin"), "orphan");
    await writeFile(
      path.join(workspaceDirectory, "orphan.json"),
      JSON.stringify({
        refId: "22222222-2222-4222-8222-222222222222",
        name: "orphan.txt",
        size: 6,
        sha256: "b".repeat(64),
        draftKey: "local:workspace:missing:main",
        workspaceId: "workspace",
      }),
    );
    await writeFile(path.join(workspaceDirectory, "unpaired.bin"), "unpaired");
    await writeFile(path.join(workspaceDirectory, ".stale.bin.tmp"), "temp");

    expect(await store.reconcile([])).toBe(4);
    await expect(readFile(path.join(workspaceDirectory, "orphan.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(workspaceDirectory, "orphan.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(workspaceDirectory, "unpaired.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps attachment pairs referenced by a live draft", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-draft-attachments-"));
    temporaryDirectories.push(directory);
    const store = new ComposerDraftAttachmentStore(directory);
    const ref = await store.put({
      draftKey: "local:workspace:task-1:main",
      workspaceId: "workspace",
      name: "keep.txt",
      dataBase64: Buffer.from("keep").toString("base64"),
    });

    expect(
      await store.reconcile([
        { draftKey: "local:workspace:task-1:main", workspaceId: "workspace", refId: ref.refId },
      ]),
    ).toBe(0);
    expect(
      await store.resolve("local:workspace:task-1:main", "workspace", ref.refId),
    ).not.toBeNull();
  });

  it("requires native-picker approval for path-backed attachments", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-draft-attachments-"));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, "source.txt");
    await writeFile(sourcePath, "selected");
    const store = new ComposerDraftAttachmentStore(path.join(directory, "store"));

    await expect(
      store.put({
        draftKey: "local:workspace:task-1:main",
        workspaceId: "workspace",
        name: "source.txt",
        sourcePath,
      }),
    ).rejects.toThrow("native file picker");

    rememberApprovedImportFiles([sourcePath]);
    const ref = await store.put({
      draftKey: "local:workspace:task-1:main",
      workspaceId: "workspace",
      name: "source.txt",
      sourcePath,
    });
    expect(ref.size).toBe(8);
  });
});
