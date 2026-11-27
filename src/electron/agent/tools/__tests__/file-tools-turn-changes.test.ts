/**
 * The file tools record each change in the turn change journal, so a turn can be undone:
 * write_file, edit_file, rename_file, copy_file and delete_file.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { FIRST_TURN_KEY } from "../../../../shared/turn-changes";
import { RevisionSnapshotStore } from "../../../annotations/revision-snapshots";
import {
  TurnChangeJournal,
  setActiveTurnChangeJournal,
} from "../../../turn-changes/turn-change-journal";
import { EditTools } from "../edit-tools";
import { FileTools } from "../file-tools";

vi.mock("electron", () => ({}));

describe("file tools record turn changes", () => {
  let tmp: string;
  let workspaceDir: string;
  let journal: TurnChangeJournal;
  let fileTools: FileTools;
  let editTools: EditTools;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-tool-turn-changes-"));
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "ws-")));
    journal = new TurnChangeJournal({
      root: path.join(tmp, "journal"),
      snapshots: new RevisionSnapshotStore(path.join(tmp, "blobs")),
      trash: async (filePath) => fs.rmSync(filePath),
    });
    setActiveTurnChangeJournal(journal);
    const workspace: Workspace = {
      id: "w1",
      name: "Test",
      path: workspaceDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    };
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
      captureTaskMutationBaseline: vi.fn(),
    } as Any;
    fileTools = new FileTools(workspace, daemon, "task-1");
    editTools = new EditTools(workspace, daemon, "task-1");
  });

  afterEach(() => {
    setActiveTurnChangeJournal(null);
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const at = (name: string) => path.join(workspaceDir, name);
  const listed = async () => {
    // edit_file records without waiting; give it a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [set] = await journal.list("task-1", [], workspaceDir);
    return set?.files.map((file) => [file.displayPath, file.kind]) ?? [];
  };

  it("records writes, edits, renames, copies and deletes, and undoes them", async () => {
    fs.writeFileSync(at("keep.md"), "alpha\n");
    fs.writeFileSync(at("gone.md"), "bye\n");
    fs.writeFileSync(at("src.md"), "copy me\n");

    await fileTools.writeFile("new.md", "fresh\n");
    const edit = await editTools.editFile({
      file_path: "keep.md",
      old_string: "alpha",
      new_string: "beta",
    });
    expect(edit.success).toBe(true);
    await fileTools.renameFile("src.md", "moved.md");
    await fileTools.copyFile("moved.md", "copy.md");
    await fileTools.deleteFile("gone.md");

    expect(await listed()).toEqual([
      ["copy.md", "created"],
      ["gone.md", "deleted"],
      ["keep.md", "modified"],
      ["moved.md", "created"],
      ["new.md", "created"],
      ["src.md", "deleted"],
    ]);

    const result = await journal.undo("task-1", FIRST_TURN_KEY, [], workspaceDir);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(at("keep.md"), "utf8")).toBe("alpha\n");
    expect(fs.readFileSync(at("gone.md"), "utf8")).toBe("bye\n");
    expect(fs.readFileSync(at("src.md"), "utf8")).toBe("copy me\n");
    for (const name of ["new.md", "moved.md", "copy.md"]) {
      expect(fs.existsSync(at(name))).toBe(false);
    }
  });

  it("records nothing for a write that changes nothing", async () => {
    fs.writeFileSync(at("same.md"), "same\n");
    await fileTools.writeFile("same.md", "same\n");
    expect(await listed()).toEqual([]);
  });
});
