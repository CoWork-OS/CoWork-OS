import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendWorkspacePermissionManifestRule,
  getWorkspacePermissionManifestPath,
  loadWorkspacePermissionManifest,
  removeWorkspacePermissionManifestRule,
} from "../workspace-permission-manifest";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("workspace-permission-manifest", () => {
  it("round-trips workspace rules and avoids duplicates", () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-permissions-"));
    tempDirs.push(workspacePath);

    const first = appendWorkspacePermissionManifestRule(workspacePath, {
      source: "workspace_manifest",
      effect: "allow",
      scope: {
        kind: "path",
        toolName: "edit_file",
        path: path.join(workspacePath, "src"),
      },
    });

    const second = appendWorkspacePermissionManifestRule(workspacePath, {
      source: "workspace_manifest",
      effect: "allow",
      scope: {
        kind: "path",
        toolName: "edit_file",
        path: path.join(workspacePath, "src"),
      },
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const manifest = loadWorkspacePermissionManifest(workspacePath);
    expect(manifest.rules).toHaveLength(1);
    expect(manifest.rules[0]).toEqual(
      expect.objectContaining({
        source: "workspace_manifest",
        effect: "allow",
        scope: {
          kind: "path",
          toolName: "edit_file",
          path: path.resolve(workspacePath, "src"),
        },
      }),
    );
    expect(fs.existsSync(getWorkspacePermissionManifestPath(workspacePath))).toBe(true);
  });

  it("removes matching workspace rules from the manifest", () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-permissions-"));
    tempDirs.push(workspacePath);

    const rule = {
      source: "workspace_manifest" as const,
      effect: "allow" as const,
      scope: {
        kind: "command_prefix" as const,
        prefix: "git status",
      },
    };

    appendWorkspacePermissionManifestRule(workspacePath, rule);
    const removed = removeWorkspacePermissionManifestRule(workspacePath, rule);

    expect(removed).toEqual(
      expect.objectContaining({
        success: true,
        removed: true,
      }),
    );
    expect(loadWorkspacePermissionManifest(workspacePath).rules).toHaveLength(0);
  });
});
