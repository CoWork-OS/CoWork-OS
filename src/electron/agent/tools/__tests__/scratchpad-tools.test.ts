import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { ScratchpadTools } from "../scratchpad-tools";

const cleanupRoots: string[] = [];

function makeWorkspace(
  root: string,
  permissions: Partial<Workspace["permissions"]> = {},
): Workspace {
  return {
    id: path.basename(root),
    name: "Scratchpad test",
    path: root,
    createdAt: Date.now(),
    permissions: {
      read: true,
      write: true,
      delete: true,
      network: false,
      shell: false,
      ...permissions,
    },
  };
}

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ScratchpadTools workspace boundaries", () => {
  it("does not carry checkpoint notes across workspaces and restores the original workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-scratchpad-"));
    cleanupRoots.push(root);
    const workspaceA = path.join(root, "a");
    const workspaceB = path.join(root, "b");
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });

    const scratchpad = new ScratchpadTools("task-1", makeWorkspace(workspaceA));
    scratchpad.write({ key: "note", content: "workspace A" });
    scratchpad.setWorkspace(makeWorkspace(workspaceB));

    expect(scratchpad.read({}).notes).toEqual([]);

    scratchpad.setWorkspace(makeWorkspace(workspaceA));
    expect(scratchpad.read({}).notes.map((note) => note.content)).toEqual(["workspace A"]);
  });

  it("clears in-memory checkpoint notes when the active profile is revoked", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-scratchpad-"));
    cleanupRoots.push(root);
    const workspace = makeWorkspace(root);
    const scratchpad = new ScratchpadTools("task-2", workspace);
    scratchpad.write({ key: "secret", content: "stale" });

    scratchpad.setWorkspace(
      makeWorkspace(root, {
        accessProfileUnavailable: true,
      }),
    );

    expect(scratchpad.read({}).notes).toEqual([]);
  });
});
