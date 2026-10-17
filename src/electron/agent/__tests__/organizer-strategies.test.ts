import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { Workspace } from "../../../shared/types";
import { FolderOrganizer } from "../skills/organizer";

let workspacePath: string;
let organizer: FolderOrganizer;

beforeEach(async () => {
  workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-organizer-"));
  const workspace = {
    id: "ws-test",
    name: "test",
    path: workspacePath,
    createdAt: 0,
    permissions: { read: true, write: true, delete: true, shell: false, network: false },
  } as Workspace;
  const daemon = { logEvent: vi.fn(), getTask: () => null };
  organizer = new FolderOrganizer(workspace, daemon as never, "task-test");
});

afterEach(async () => {
  await fs.rm(workspacePath, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("FolderOrganizer strategies", () => {
  it("rejects the removed custom strategy instead of reporting success", async () => {
    await fs.writeFile(path.join(workspacePath, "note.txt"), "hi");

    await expect(organizer.organize(".", "custom" as never)).rejects.toThrow(
      /Unsupported strategy: custom/,
    );

    // Nothing may be moved when the strategy is rejected.
    expect(await fs.readdir(workspacePath)).toEqual(["note.txt"]);
  });

  it("still organizes by type", async () => {
    await fs.writeFile(path.join(workspacePath, "photo.png"), "x");
    await fs.writeFile(path.join(workspacePath, "note.txt"), "x");

    const changes = await organizer.organize(".", "by_type");

    expect(changes).toBe(2);
    expect(await fs.readdir(path.join(workspacePath, "Images"))).toEqual(["photo.png"]);
    expect(await fs.readdir(path.join(workspacePath, "Documents"))).toEqual(["note.txt"]);
  });

  it("still organizes by modified month", async () => {
    await fs.writeFile(path.join(workspacePath, "report.pdf"), "x");

    const changes = await organizer.organize(".", "by_date");

    expect(changes).toBe(1);
    const dirs = await fs.readdir(workspacePath);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^\d{4}-\d{2}$/);
    expect(await fs.readdir(path.join(workspacePath, dirs[0]))).toEqual(["report.pdf"]);
  });
});
