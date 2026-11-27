import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RevisionSnapshotStore } from "../../annotations/revision-snapshots";
import { FIRST_TURN_KEY } from "../../../shared/turn-changes";
import {
  TurnChangeJournal,
  countLineChanges,
  recordFileBytesChange,
  setActiveTurnChangeJournal,
  watchFileChanges,
  type TurnStart,
} from "../turn-change-journal";

describe("countLineChanges", () => {
  it("counts added and removed lines regardless of order", () => {
    expect(countLineChanges("a\nb\nc", "a\nc\nd\ne")).toEqual({ added: 2, removed: 1 });
    expect(countLineChanges("", "one\ntwo")).toEqual({ added: 2, removed: 0 });
    expect(countLineChanges("", "one\n")).toEqual({ added: 1, removed: 0 });
    expect(countLineChanges("one\r\ntwo", "one\ntwo")).toEqual({ added: 0, removed: 0 });
  });
});

describe("TurnChangeJournal", () => {
  let tmp: string;
  let workspace: string;
  let clock: number;
  let trashed: string[];
  let journal: TurnChangeJournal;
  const taskId = "task-1";

  const file = (name: string) => path.join(workspace, name);
  const write = (name: string, text: string) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), text);
  };
  const read = (name: string) => fs.readFileSync(file(name), "utf8");
  /** Change a file the way a file tool does: watch, write, commit. */
  const toolWrite = async (name: string, text: string | null) => {
    const watch = await watchFileChanges(taskId, [file(name)]);
    if (text === null) fs.rmSync(file(name));
    else write(name, text);
    await watch.commit();
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turn-changes-"));
    workspace = path.join(tmp, "work");
    fs.mkdirSync(workspace);
    clock = 1_000;
    trashed = [];
    journal = new TurnChangeJournal({
      root: path.join(tmp, "journal"),
      snapshots: new RevisionSnapshotStore(path.join(tmp, "blobs")),
      trash: async (filePath) => {
        trashed.push(filePath);
        fs.rmSync(filePath);
      },
      now: () => clock,
    });
    setActiveTurnChangeJournal(journal);
  });

  afterEach(() => {
    setActiveTurnChangeJournal(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("lists each turn's net change per file, cut at user messages", async () => {
    write("notes.md", "one\ntwo\n");
    write("old.txt", "bye\n");
    await toolWrite("notes.md", "one\ntwo\nthree\n");
    clock = 1_100;
    await toolWrite("notes.md", "one\nTWO\nthree\n");
    await toolWrite("new.md", "fresh\n");
    await toolWrite("old.txt", null);
    clock = 3_000;
    await toolWrite("notes.md", "final\n");
    const starts: TurnStart[] = [{ key: "msg-2", at: 2_000 }];

    const sets = await journal.list(taskId, starts, workspace);
    expect(sets.map((set) => set.turnKey)).toEqual([FIRST_TURN_KEY, "msg-2"]);
    const first = sets[0];
    expect(first.files.map((f) => [f.displayPath, f.kind, f.added, f.removed])).toEqual([
      ["new.md", "created", 1, 0],
      ["notes.md", "modified", 2, 1],
      ["old.txt", "deleted", 0, 1],
    ]);
    // A later turn changed notes.md, so the first turn can no longer be put back.
    expect(first.files.find((f) => f.displayPath === "notes.md")?.blocked).toBe("changed_since");
    expect(first.canUndo).toBe(false);
    expect(sets[1].canUndo).toBe(true);
  });

  it("undoes the latest turn, then the one before it", async () => {
    write("a.txt", "v1");
    await toolWrite("a.txt", "v2");
    clock = 3_000;
    await toolWrite("a.txt", "v3");
    await toolWrite("made.txt", "new");
    const starts = [{ key: "msg-2", at: 2_000 }];

    const second = await journal.undo(taskId, "msg-2", starts, workspace);
    expect(second.ok).toBe(true);
    expect(read("a.txt")).toBe("v2");
    expect(trashed).toEqual([path.join(fs.realpathSync(workspace), "made.txt")]);
    expect(second.changeSet?.undoneAt).toBeDefined();
    expect(second.changeSet?.canUndo).toBe(false);

    const again = await journal.undo(taskId, "msg-2", starts, workspace);
    expect(again).toMatchObject({ ok: false, error: "These changes were already undone." });

    const first = await journal.undo(taskId, FIRST_TURN_KEY, starts, workspace);
    expect(first.ok).toBe(true);
    expect(read("a.txt")).toBe("v1");
  });

  it("restores a deleted file, recreating its folder", async () => {
    write("docs/keep.md", "keep me");
    await toolWrite("docs/keep.md", null);
    fs.rmdirSync(file("docs"));
    const result = await journal.undo(taskId, FIRST_TURN_KEY, [], workspace);
    expect(result.ok).toBe(true);
    expect(read("docs/keep.md")).toBe("keep me");
  });

  it("refuses when a file changed after the turn, and changes nothing", async () => {
    write("a.txt", "v1");
    write("b.txt", "b1");
    await toolWrite("a.txt", "v2");
    await toolWrite("b.txt", "b2");
    write("b.txt", "edited by hand");
    const result = await journal.undo(taskId, FIRST_TURN_KEY, [], workspace);
    expect(result.ok).toBe(false);
    expect(result.restored).toEqual([]);
    expect(result.changeSet?.files.find((f) => f.displayPath === "b.txt")?.blocked).toBe(
      "changed_since",
    );
    expect(read("a.txt")).toBe("v2");
  });

  it("blocks files outside the workspace or in protected folders, and skips scratch files", async () => {
    // Files in temp folders are scratch, so a path elsewhere stands in for one outside.
    const outside = "/Users/someone-else/outside.txt";
    await journal.record(
      taskId,
      outside,
      { exists: false },
      { exists: true, sha256: "a".repeat(64), size: 1, kept: true },
    );
    await toolWrite(".git/config", "[core]");
    await toolWrite(".cowork/tmp/scratch.txt", "scratch");
    await toolWrite("node_modules/pkg/index.js", "x");

    const [set] = await journal.list(taskId, [], workspace);
    expect(set.files.map((f) => [f.displayPath, f.blocked])).toEqual([
      [outside, "outside_workspace"],
    ]);
    expect(set.canUndo).toBe(false);
  });

  it("does not record unchanged files, and records bytes it is given", async () => {
    write("same.txt", "same");
    await toolWrite("same.txt", "same");
    await recordFileBytesChange(
      taskId,
      file("edited.ts"),
      Buffer.from("let a = 1;\n"),
      Buffer.from("let a = 2;\n"),
    );
    write("edited.ts", "let a = 2;\n");
    const [set] = await journal.list(taskId, [], workspace);
    expect(set.files.map((f) => [f.displayPath, f.kind, f.added, f.removed])).toEqual([
      ["edited.ts", "modified", 1, 1],
    ]);
  });

  it("tells the agent about each undo once it is marked as told", async () => {
    write("a.txt", "v1");
    await toolWrite("a.txt", "v2");
    await journal.undo(taskId, FIRST_TURN_KEY, [], workspace);
    const untold = await journal.untoldUndos(taskId);
    expect(untold).toEqual([{ turnKey: FIRST_TURN_KEY, paths: [file("a.txt")] }]);
    // Not told until the message carrying the note is accepted.
    expect(await journal.untoldUndos(taskId)).toEqual(untold);
    await journal.markUndosTold(taskId, [FIRST_TURN_KEY]);
    expect(await journal.untoldUndos(taskId)).toEqual([]);
  });

  it("never copies secret-like files, so their changes can't be undone", async () => {
    write(".env", "TOKEN=old");
    await toolWrite(".env", "TOKEN=new");
    const [set] = await journal.list(taskId, [], workspace);
    expect(set.files).toMatchObject([{ displayPath: ".env", blocked: "secret" }]);
    const blobs = path.join(tmp, "blobs");
    expect(fs.existsSync(blobs) ? fs.readdirSync(blobs, { recursive: true }) : []).toEqual([]);
  });

  it("brings a deleted file back with its permissions", async () => {
    if (process.platform === "win32") return;
    write("run.sh", "#!/bin/sh\n");
    fs.chmodSync(file("run.sh"), 0o750);
    await toolWrite("run.sh", null);
    expect((await journal.undo(taskId, FIRST_TURN_KEY, [], workspace)).ok).toBe(true);
    expect(fs.statSync(file("run.sh")).mode & 0o777).toBe(0o750);
  });

  it("stops before writing when a folder became a symlink out of the workspace", async () => {
    if (process.platform === "win32") return;
    write("docs/a.md", "v1");
    await toolWrite("docs/a.md", "v2");
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "a.md"), "v2");
    fs.rmSync(file("docs"), { recursive: true });
    fs.symlinkSync(outside, file("docs"));
    const result = await journal.undo(taskId, FIRST_TURN_KEY, [], workspace);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(outside, "a.md"), "utf8")).toBe("v2");
  });

  it("records nothing without an active journal or with an unsafe task id", async () => {
    setActiveTurnChangeJournal(null);
    const watch = await watchFileChanges(taskId, [file("a.txt")]);
    write("a.txt", "x");
    await watch.commit();
    setActiveTurnChangeJournal(journal);
    const unsafe = await watchFileChanges("../escape", [file("b.txt")]);
    write("b.txt", "y");
    await unsafe.commit();
    expect(await journal.list(taskId, [], workspace)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, "escape.jsonl"))).toBe(false);
  });
});
