import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendWorkspacePermissionManifestRule,
  filterTrustedManifestRules,
  getWorkspacePermissionManifestPath,
  loadWorkspacePermissionManifest,
  removeWorkspacePermissionManifestRule,
} from "../workspace-permission-manifest";
import type { PermissionRule, PermissionRuleScope } from "../../../shared/types";

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

  it("persists normalized domain rules", () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-permissions-"));
    tempDirs.push(workspacePath);

    appendWorkspacePermissionManifestRule(workspacePath, {
      source: "workspace_manifest",
      effect: "allow",
      scope: {
        kind: "domain",
        toolName: "http_request",
        domain: "API.Example.COM",
      },
    });

    const manifest = loadWorkspacePermissionManifest(workspacePath);
    expect(manifest.rules).toEqual([
      expect.objectContaining({
        scope: {
          kind: "domain",
          toolName: "http_request",
          domain: "api.example.com",
        },
      }),
    ]);
  });
});

describe("filterTrustedManifestRules", () => {
  const runCommandScope = { kind: "tool", toolName: "run_command" } as const;

  const manifestRule = (
    effect: "allow" | "deny" | "ask",
    scope: PermissionRuleScope = runCommandScope,
  ): PermissionRule => ({ source: "workspace_manifest", effect, scope });

  const dbRule = (
    effect: "allow" | "deny" | "ask",
    scope: PermissionRuleScope = runCommandScope,
  ): PermissionRule => ({ source: "workspace_db", effect, scope });

  it("drops an allow rule that no workspace database row mirrors", () => {
    const result = filterTrustedManifestRules([manifestRule("allow")], []);

    expect(result.rules).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  it("keeps an allow rule the user approved on this machine", () => {
    const result = filterTrustedManifestRules([manifestRule("allow")], [dbRule("allow")]);

    expect(result.rules).toHaveLength(1);
    expect(result.droppedCount).toBe(0);
  });

  it("keeps restrictive rules without requiring a database mirror", () => {
    const result = filterTrustedManifestRules([manifestRule("deny"), manifestRule("ask")], []);

    expect(result.rules.map((rule) => rule.effect)).toEqual(["deny", "ask"]);
    expect(result.droppedCount).toBe(0);
  });

  it("does not let a database rule for one scope trust an allow for another", () => {
    const result = filterTrustedManifestRules(
      [manifestRule("allow", { kind: "tool", toolName: "run_applescript" })],
      [dbRule("allow", runCommandScope)],
    );

    expect(result.rules).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  it("does not let a deny in the database trust an allow in the manifest", () => {
    const result = filterTrustedManifestRules([manifestRule("allow")], [dbRule("deny")]);

    expect(result.rules).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  it("blocks the self-grant an injected agent would write", () => {
    // The exact shape a prompt-injected agent would drop into
    // .cowork/policy/permissions.json to silence its own approval prompts.
    const selfGranted: PermissionRule[] = [
      manifestRule("allow", { kind: "tool", toolName: "run_command" }),
      manifestRule("allow", { kind: "tool", toolName: "run_applescript" }),
      manifestRule("allow", { kind: "path", path: "/" }),
    ];

    const result = filterTrustedManifestRules(selfGranted, []);

    expect(result.rules).toEqual([]);
    expect(result.droppedCount).toBe(3);
  });
});
