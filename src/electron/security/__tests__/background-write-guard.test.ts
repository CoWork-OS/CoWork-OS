import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBackgroundKitPathGuard,
  evaluateConfinedInternalWrite,
  type BackgroundWriteWorkspace,
} from "../background-write-guard";

let tmpDir: string;
let workspaceDir: string;
let outsideDir: string;

function workspace(overrides: Partial<BackgroundWriteWorkspace["permissions"]> = {}) {
  return {
    path: workspaceDir,
    permissions: {
      read: true,
      write: true,
      delete: true,
      network: false,
      shell: false,
      ...overrides,
    },
  } as BackgroundWriteWorkspace;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-bg-guard-"));
  workspaceDir = path.join(tmpDir, "workspace");
  outsideDir = path.join(tmpDir, "outside");
  fs.mkdirSync(path.join(workspaceDir, ".cowork"), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createBackgroundKitPathGuard", () => {
  it("allows kit files inside the workspace", () => {
    const guard = createBackgroundKitPathGuard(workspace());
    expect(() => guard(path.join(workspaceDir, ".cowork", "LORE.md"), "write")).not.toThrow();
    expect(() => guard(path.join(workspaceDir, ".cowork", "LORE.md"), "read")).not.toThrow();
  });

  it("denies protected workspace paths", () => {
    const guard = createBackgroundKitPathGuard(workspace({ unrestrictedFileAccess: true }));
    expect(() =>
      guard(path.join(workspaceDir, ".cowork", "policy", "tools.monty"), "write"),
    ).toThrow(/protected_path/);
    expect(() => guard(path.join(workspaceDir, ".git", "hooks", "pre-commit"), "write")).toThrow(
      /protected_path/,
    );
  });

  it("denies paths outside the workspace even with unrestricted access", () => {
    const guard = createBackgroundKitPathGuard(workspace({ unrestrictedFileAccess: true }));
    expect(() => guard(path.join(outsideDir, "LORE.md"), "write")).toThrow(
      /outside_workspace_root/,
    );
  });

  it("denies a symlinked kit directory that escapes the workspace", () => {
    fs.rmSync(path.join(workspaceDir, ".cowork"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(workspaceDir, ".cowork"));
    const guard = createBackgroundKitPathGuard(workspace({ unrestrictedFileAccess: true }));
    expect(() => guard(path.join(workspaceDir, ".cowork", "LORE.md"), "write")).toThrow(
      /outside_workspace_root/,
    );
  });

  it("denies writes when the workspace write capability is off", () => {
    const guard = createBackgroundKitPathGuard(workspace({ write: false }));
    expect(() => guard(path.join(workspaceDir, ".cowork", "LORE.md"), "write")).toThrow(
      /Access denied/,
    );
  });
});

describe("evaluateConfinedInternalWrite", () => {
  const confineTo = path.join(".cowork", "subconscious");

  it("allows writes under the confined directory", () => {
    const dir = path.join(workspaceDir, confineTo, "brain");
    expect(
      evaluateConfinedInternalWrite({
        root: workspaceDir,
        confineTo,
        targets: [dir, path.join(dir, "state.json")],
        workspace: workspace(),
      }),
    ).toEqual({ allowed: true });
  });

  it("denies targets outside the confined directory", () => {
    expect(
      evaluateConfinedInternalWrite({
        root: workspaceDir,
        confineTo,
        targets: [path.join(workspaceDir, ".cowork", "policy", "tools.monty")],
        workspace: workspace(),
      }),
    ).toEqual({ allowed: false, reason: "outside_confined_dir" });
  });

  it("denies a symlink anywhere between the root and the target", () => {
    fs.symlinkSync(outsideDir, path.join(workspaceDir, ".cowork", "subconscious"));
    expect(
      evaluateConfinedInternalWrite({
        root: workspaceDir,
        confineTo,
        targets: [path.join(workspaceDir, confineTo, "brain", "state.json")],
      }),
    ).toEqual({ allowed: false, reason: "symlink_escape" });
  });

  it("denies a missing root instead of recreating it", () => {
    const missing = path.join(tmpDir, "deleted");
    expect(
      evaluateConfinedInternalWrite({
        root: missing,
        confineTo,
        targets: [path.join(missing, confineTo, "brain")],
      }),
    ).toEqual({ allowed: false, reason: "root_missing" });
  });

  it("applies the workspace access profile", () => {
    expect(
      evaluateConfinedInternalWrite({
        root: workspaceDir,
        confineTo,
        targets: [path.join(workspaceDir, confineTo, "brain")],
        workspace: workspace({ write: false }),
      }).allowed,
    ).toBe(false);
  });
});
