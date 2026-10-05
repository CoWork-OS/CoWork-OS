import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRepoService } from "../MemoryRepoService";
import { parseMemoryRepoEntries } from "../memory-repo-format";
import {
  memoryRepoSkipMessage,
  promoteObservationToMemoryFolder,
  rememberPreferredNameInFolder,
  writableMemoryRepo,
} from "../memory-repo-producers";

describe("memory folder producers", () => {
  let base: string;
  let service: MemoryRepoService;
  const get = () => service;
  const lines = (file: string) =>
    parseMemoryRepoEntries(fs.readFileSync(path.join(service.root, file), "utf8"));

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-producers-"));
    service = new MemoryRepoService({ root: path.join(base, "memory"), runtime: "node" });
    await service.start();
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("is null without a writable folder", async () => {
    expect(writableMemoryRepo(() => null)).toBeNull();
    const readOnly = new MemoryRepoService({ root: service.root, runtime: "cli", readOnly: true });
    await readOnly.start();
    expect(writableMemoryRepo(() => readOnly)).toBeNull();
    expect(await rememberPreferredNameInFolder("Alex", {}, () => null)).toBeNull();
    expect(
      await promoteObservationToMemoryFolder(
        { workspaceId: "ws-1", target: "workspace", kind: "project_fact", content: "Uses Postgres" },
        () => null,
      ),
    ).toBeNull();
  });

  it("mirrors the preferred name into me.md, replacing an earlier name", async () => {
    await rememberPreferredNameInFolder("Alex", { taskId: "task-1" }, get);
    await rememberPreferredNameInFolder("Sam", { taskId: "task-2" }, get);
    expect(lines("me.md")).toEqual([
      expect.objectContaining({
        text: "Preferred name: Sam",
        by: "user",
        kind: "identity",
        subject: "preferred_name",
        metadata: expect.objectContaining({ source: "cowork://tasks/task-2" }),
      }),
    ]);
  });

  it("promotes an observation as the user's line in the workspace file or me.md", async () => {
    const workspace = await promoteObservationToMemoryFolder(
      {
        workspaceId: "ws-1",
        workspaceName: "Billing",
        taskId: "task-1",
        target: "workspace",
        kind: "workflow_rule",
        content: "Run the migrations before deploying",
      },
      get,
    );
    expect(workspace).toMatchObject({ success: true, file: "workspaces/billing.md" });
    expect(lines("workspaces/billing.md")).toContainEqual(
      expect.objectContaining({ text: "Run the migrations before deploying", by: "user", kind: "rule" }),
    );
    const user = await promoteObservationToMemoryFolder(
      { workspaceId: "ws-1", target: "user", kind: "preference", content: "Prefers dark mode" },
      get,
    );
    expect(user).toMatchObject({ success: true, file: "me.md" });
    // Commitments stay in memory_items.
    expect(
      await promoteObservationToMemoryFolder(
        { workspaceId: "ws-1", target: "workspace", kind: "active_commitment", content: "Ship it Friday" },
        get,
      ),
    ).toBeNull();
    expect(
      await promoteObservationToMemoryFolder(
        { workspaceId: "ws-1", target: "user", kind: "preference", content: "ok" },
        get,
      ),
    ).toMatchObject({ success: false, error: expect.stringMatching(/too short/) });
  });

  it("explains skips in words", () => {
    expect(memoryRepoSkipMessage({ status: "skipped", reason: "busy" })).toMatch(/busy/);
    expect(memoryRepoSkipMessage({ status: "skipped", reason: "too_large", detail: "me.md is full" })).toBe(
      "Not saved: me.md is full.",
    );
  });
});
