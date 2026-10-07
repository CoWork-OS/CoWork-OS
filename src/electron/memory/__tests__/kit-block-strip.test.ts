import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
  clearKitRenderState: vi.fn(async () => 2),
}));

// The workspace's own permissions stand in for the resolved access profile.
vi.mock("../../security/effective-workspace", () => ({
  withEffectiveAccessProfile: (workspace: unknown) => workspace,
}));
vi.mock("../MemoryWriter", () => ({
  MemoryWriter: {
    get: () => ({ repository: { clearKitRenderState: mocks.clearKitRenderState } }),
  },
}));

import { resetKitBlockStripForTests, stripCuratedKitBlocksOnce } from "../kit-block-strip";
import { removeGeneratedMemoryBlocks } from "../generated-kit-blocks";

const USER_START = "<!-- cowork:auto:curated-user:start -->";
const USER_END = "<!-- cowork:auto:curated-user:end -->";
const WS_START = "<!-- cowork:auto:curated-workspace:start -->";
const WS_END = "<!-- cowork:auto:curated-workspace:end -->";
const LORE_START = "<!-- cowork:auto:lore:start -->";
const LORE_END = "<!-- cowork:auto:lore:end -->";
const MISTAKES_START = "<!-- cowork:auto:mistakes:start -->";
const MISTAKES_END = "<!-- cowork:auto:mistakes:end -->";

let tmpDir: string;
let workspacePath: string;

function workspace(permissions: Partial<Workspace["permissions"]> = {}): Workspace {
  return {
    id: "ws-1",
    name: "Workspace",
    path: workspacePath,
    createdAt: 0,
    permissions: {
      read: true,
      write: true,
      delete: true,
      network: false,
      shell: false,
      ...permissions,
    },
  } as Workspace;
}

const kitPath = (name: string) => path.join(workspacePath, ".cowork", name);
const read = (name: string) => fs.readFileSync(kitPath(name), "utf8");
const write = (name: string, content: string) => fs.writeFileSync(kitPath(name), content);
const historyOf = (name: string) => path.join(workspacePath, ".cowork", ".history", name);

beforeEach(() => {
  resetKitBlockStripForTests();
  mocks.clearKitRenderState.mockClear();
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-kit-strip-")));
  workspacePath = path.join(tmpDir, "workspace");
  fs.mkdirSync(path.join(workspacePath, ".cowork"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("removeGeneratedMemoryBlocks", () => {
  it("removes complete blocks with one trailing newline and a dangling start to the end", () => {
    expect(removeGeneratedMemoryBlocks(`a\n${USER_START}\n- x\n${USER_END}\nb\n`)).toBe("a\nb\n");
    expect(removeGeneratedMemoryBlocks(`a\n${WS_START}\n- cut off`)).toBe("a\n");
    expect(removeGeneratedMemoryBlocks("no markers\n")).toBe("no markers\n");
  });

  it("removes the lore and feedback-pattern blocks unless feedback patterns are kept", () => {
    const text = `a\n${LORE_START}\n- m\n${LORE_END}\nb\n${MISTAKES_START}\n- p\n${MISTAKES_END}\nc\n`;
    expect(removeGeneratedMemoryBlocks(text)).toBe("a\nb\nc\n");
    expect(removeGeneratedMemoryBlocks(text, { keepFeedbackPatterns: true })).toBe(
      `a\nb\n${MISTAKES_START}\n- p\n${MISTAKES_END}\nc\n`,
    );
  });
});

describe("stripCuratedKitBlocksOnce", () => {
  it("removes the blocks, keeps the user's text and snapshots the old file", async () => {
    write(
      "USER.md",
      `# User Profile\n\nMy own note.\n\n${USER_START}\n- preference: tea\n${USER_END}\n`,
    );
    write(
      "MEMORY.md",
      `# Long-Term Memory\n\n${WS_START}\n- Rule: lint\n${WS_END}\n\n## Hand-written\n- keep me\n`,
    );

    const outcome = await stripCuratedKitBlocksOnce(workspace());

    expect(outcome).toEqual({
      status: "done",
      changedFiles: [path.join(".cowork", "USER.md"), path.join(".cowork", "MEMORY.md")],
    });
    expect(read("USER.md")).toBe("# User Profile\n\nMy own note.\n");
    expect(read("MEMORY.md")).toBe("# Long-Term Memory\n\n\n## Hand-written\n- keep me\n");
    const snapshots = fs.readdirSync(historyOf("USER.md")).filter((name) => name.endsWith(".md"));
    expect(snapshots).toHaveLength(1);
    expect(fs.readFileSync(path.join(historyOf("USER.md"), snapshots[0]), "utf8")).toContain(
      USER_START,
    );
    expect(mocks.clearKitRenderState).toHaveBeenCalledWith("ws-1");
  });

  it("removes the LORE.md block always and the MISTAKES.md block only with a writable folder", async () => {
    const lore = `# Shared Lore\n\n## Milestones\n- [2026-10-01] by hand\n${LORE_START}\n- [2026-10-02] task\n${LORE_END}\n\n## Notes\n- n\n`;
    const mistakes = `# Mistakes\n\n## Patterns\n${MISTAKES_START}\n- Main: too long\n${MISTAKES_END}\n\n## Notes\n- mine\n`;
    write("LORE.md", lore);
    write("MISTAKES.md", mistakes);

    // Folder off: MISTAKES.md keeps its live fallback block.
    expect(await stripCuratedKitBlocksOnce(workspace(), () => false)).toEqual({
      status: "done",
      changedFiles: [path.join(".cowork", "LORE.md")],
    });
    expect(read("LORE.md")).toBe(
      "# Shared Lore\n\n## Milestones\n- [2026-10-01] by hand\n\n## Notes\n- n\n",
    );
    expect(read("MISTAKES.md")).toBe(mistakes);

    // Folder writable (a later process): the block goes, the hand-written text stays.
    resetKitBlockStripForTests();
    expect(await stripCuratedKitBlocksOnce(workspace(), () => true)).toEqual({
      status: "done",
      changedFiles: [path.join(".cowork", "MISTAKES.md")],
    });
    expect(read("MISTAKES.md")).toBe("# Mistakes\n\n## Patterns\n\n## Notes\n- mine\n");
  });

  it("refuses a MISTAKES.md that is a symlink", async () => {
    const outside = path.join(tmpDir, "outside-mistakes.md");
    const content = `# Mistakes\n${MISTAKES_START}\n- a\n${MISTAKES_END}\n`;
    fs.writeFileSync(outside, content);
    fs.symlinkSync(outside, kitPath("MISTAKES.md"));

    expect(await stripCuratedKitBlocksOnce(workspace(), () => true)).toEqual({
      status: "skipped",
      reason: "outside_workspace",
    });
    expect(fs.readFileSync(outside, "utf8")).toBe(content);
  });

  it("removes a truncated block (no end marker) through the end of the file", async () => {
    write("MEMORY.md", `# Long-Term Memory\n\nKeep this.\n\n${WS_START}\n- Rule: half`);
    await stripCuratedKitBlocksOnce(workspace());
    expect(read("MEMORY.md")).toBe("# Long-Term Memory\n\nKeep this.\n");
  });

  it("does not write files without markers", async () => {
    write("USER.md", "# User Profile\n\nNothing generated.\n");
    const before = fs.statSync(kitPath("USER.md")).mtimeMs;

    const outcome = await stripCuratedKitBlocksOnce(workspace());

    expect(outcome).toEqual({ status: "done", changedFiles: [] });
    expect(read("USER.md")).toBe("# User Profile\n\nNothing generated.\n");
    expect(fs.statSync(kitPath("USER.md")).mtimeMs).toBe(before);
    expect(fs.existsSync(historyOf("USER.md"))).toBe(false);
    // Missing files are not created.
    expect(fs.existsSync(kitPath("MEMORY.md"))).toBe(false);
  });

  it("runs once per workspace", async () => {
    write("USER.md", `# User\n${USER_START}\n- a\n${USER_END}\n`);
    expect((await stripCuratedKitBlocksOnce(workspace())).status).toBe("done");
    // A block written later is not touched again in this process.
    write("USER.md", `# User\n${USER_START}\n- b\n${USER_END}\n`);
    expect(await stripCuratedKitBlocksOnce(workspace())).toEqual({ status: "already_done" });
    expect(read("USER.md")).toContain(USER_START);
    expect(mocks.clearKitRenderState).toHaveBeenCalledTimes(1);
  });

  it("is content-idempotent", async () => {
    write("USER.md", `# User\n\nText.\n\n${USER_START}\n- a\n${USER_END}\n`);
    await stripCuratedKitBlocksOnce(workspace());
    const once = read("USER.md");
    resetKitBlockStripForTests();
    const again = await stripCuratedKitBlocksOnce(workspace());
    expect(again).toEqual({ status: "done", changedFiles: [] });
    expect(read("USER.md")).toBe(once);
  });

  it("skips a denied access profile without marking the workspace handled", async () => {
    const content = `# User\n${USER_START}\n- a\n${USER_END}\n`;
    write("USER.md", content);

    expect(await stripCuratedKitBlocksOnce(workspace({ write: false }))).toEqual({
      status: "skipped",
      reason: "access_denied",
    });
    expect(read("USER.md")).toBe(content);
    expect(mocks.clearKitRenderState).not.toHaveBeenCalled();

    // Once the profile allows it, a later call does the work.
    expect((await stripCuratedKitBlocksOnce(workspace())).status).toBe("done");
    expect(read("USER.md")).toBe("# User\n");
  });

  it("refuses a .cowork directory symlinked outside the workspace", async () => {
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside);
    const content = `# User\n${USER_START}\n- a\n${USER_END}\n`;
    fs.writeFileSync(path.join(outside, "USER.md"), content);
    fs.rmSync(path.join(workspacePath, ".cowork"), { recursive: true });
    fs.symlinkSync(outside, path.join(workspacePath, ".cowork"));

    expect(await stripCuratedKitBlocksOnce(workspace())).toEqual({
      status: "skipped",
      reason: "outside_workspace",
    });
    expect(fs.readFileSync(path.join(outside, "USER.md"), "utf8")).toBe(content);
  });

  it("refuses a kit file that is a symlink", async () => {
    const outside = path.join(tmpDir, "outside.md");
    const content = `# User\n${USER_START}\n- a\n${USER_END}\n`;
    fs.writeFileSync(outside, content);
    fs.symlinkSync(outside, kitPath("USER.md"));

    expect((await stripCuratedKitBlocksOnce(workspace())).status).toBe("skipped");
    expect(fs.readFileSync(outside, "utf8")).toBe(content);
  });
});
