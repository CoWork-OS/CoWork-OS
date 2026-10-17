import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { Workspace } from "../../../../shared/types";
import { FolderOrganizer } from "../organizer";

let workspacePath: string;
let organizer: FolderOrganizer;
let logEvent: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-organizer-"));
  const workspace = {
    id: "ws-test",
    name: "test",
    path: workspacePath,
    createdAt: 0,
    permissions: { read: true, write: true, delete: true, shell: false, network: false },
  } as Workspace;
  logEvent = vi.fn();
  const daemon = { logEvent, getTask: () => null };
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

  it("rejects an unsupported strategy before checking the path", async () => {
    await expect(organizer.organize("../outside", "custom" as never)).rejects.toThrow(
      /Unsupported strategy: custom/,
    );
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

  it("leaves dotfiles in place", async () => {
    await fs.writeFile(path.join(workspacePath, ".gitignore"), "x");
    await fs.writeFile(path.join(workspacePath, "note.txt"), "x");

    expect(await organizer.organize(".", "by_type")).toBe(1);
    expect((await fs.readdir(workspacePath)).sort()).toEqual([".gitignore", "Documents"]);
  });

  it("never overwrites a same-named file already in the subfolder", async () => {
    await fs.mkdir(path.join(workspacePath, "Images"));
    await fs.writeFile(path.join(workspacePath, "Images", "photo.png"), "old");
    await fs.writeFile(path.join(workspacePath, "photo.png"), "new");

    expect(await organizer.organize(".", "by_type")).toBe(0);
    expect(await fs.readFile(path.join(workspacePath, "Images", "photo.png"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(workspacePath, "photo.png"), "utf8")).toBe("new");
  });

  it("skips a subfolder whose name is taken by a file instead of failing", async () => {
    await fs.writeFile(path.join(workspacePath, "Other"), "x");
    await fs.writeFile(path.join(workspacePath, "data.bin"), "x");
    await fs.writeFile(path.join(workspacePath, "note.txt"), "x");

    expect(await organizer.organize(".", "by_type")).toBe(1);
    expect((await fs.readdir(workspacePath)).sort()).toEqual(["Documents", "Other", "data.bin"]);
  });

  it("logs each move for by_date like by_type", async () => {
    await fs.writeFile(path.join(workspacePath, "report.pdf"), "x");

    await organizer.organize(".", "by_date");

    expect(logEvent).toHaveBeenCalledWith(
      "task-test",
      "file_modified",
      expect.objectContaining({ action: "organize", from: "report.pdf" }),
    );
  });
});
