/**
 * write_file reports whether it replaced an existing file and the approximate line counts of
 * the change on its file_created event, which the timeline shows as "Edited x.ts +2 −1".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Workspace } from "../../../../shared/types";
import { FileTools } from "../file-tools";

type Any = any; // oxlint-disable-line typescript-eslint(no-explicit-any)

describe("FileTools write_file line stats", () => {
  let tmpDir: string;
  let fileTools: FileTools;
  let logEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-file-line-stats-"));
    const workspace: Workspace = {
      id: "w1",
      name: "Test",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    };
    logEvent = vi.fn();
    const daemon = {
      logEvent,
      requestApproval: vi.fn().mockResolvedValue(true),
      captureTaskMutationBaseline: vi.fn(),
    } as Any;
    fileTools = new FileTools(workspace, daemon, "task-1");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const fileCreatedPayload = () =>
    logEvent.mock.calls.filter(([, type]) => type === "file_created").at(-1)?.[2];

  it("reports a new file with every line added", async () => {
    await fileTools.writeFile("notes.md", "one\ntwo\nthree\n");

    expect(fileCreatedPayload()).toMatchObject({
      path: "notes.md",
      existed: false,
      linesAdded: 3,
      linesRemoved: 0,
    });
  });

  it("reports an overwrite with the lines it changed", async () => {
    fs.writeFileSync(path.join(tmpDir, "notes.md"), "one\ntwo\nthree\n");

    await fileTools.writeFile("notes.md", "one\nTWO\nthree\nfour\n");

    expect(fileCreatedPayload()).toMatchObject({
      path: "notes.md",
      existed: true,
      linesAdded: 2,
      linesRemoved: 1,
    });
  });
});
