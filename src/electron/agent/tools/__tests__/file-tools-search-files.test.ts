/**
 * search_files stops content search after a fixed number of files; that stop must be reported so
 * an empty result is not mistaken for "the text does not exist".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Workspace } from "../../../../shared/types";
import { FileTools } from "../file-tools";

describe("FileTools search_files truncation", () => {
  let tmpDir: string;
  let fileTools: FileTools;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-search-files-"));
    const workspace: Workspace = {
      id: "w1",
      name: "Test",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    };
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
      captureTaskMutationBaseline: vi.fn(),
    } as Any;
    fileTools = new FileTools(workspace, daemon, "task-1");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeFiles = (count: number) => {
    for (let index = 0; index < count; index += 1) {
      const dir = path.join(tmpDir, `group-${Math.floor(index / 100)}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `file-${index}.txt`), `plain content ${index}\n`);
    }
  };

  it("flags the result as truncated when the file scan cap stops the search", async () => {
    writeFiles(620);

    const result = await fileTools.searchFiles("needle-not-present");

    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toMatch(/500 files/);
    expect(result.truncationReason).toMatch(/grep|glob/);
  });

  it("reports a complete search when every file was checked", async () => {
    writeFiles(40);

    const result = await fileTools.searchFiles("needle-not-present");

    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.truncationReason).toBeUndefined();
  });
});
