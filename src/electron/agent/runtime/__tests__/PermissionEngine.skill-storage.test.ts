import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PermissionMode, PermissionRule, Workspace } from "../../../../shared/types";
import { PermissionEngine } from "../PermissionEngine";

const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-storage-"));

afterAll(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

const workspace: Workspace = {
  id: "workspace-1",
  name: "Workspace",
  path: workspacePath,
  permissions: { read: true, write: true, delete: true, network: true, shell: true },
  createdAt: Date.now(),
};

function evaluate(input: Partial<Parameters<typeof PermissionEngine.evaluate>[0]> = {}) {
  return PermissionEngine.evaluate({
    workspace,
    toolName: "write_file",
    mode: "accept_edits",
    rules: [],
    ...input,
  });
}

const writeTo = (relativePath: string, overrides = {}) =>
  evaluate({
    approvalType: "workspace_write",
    toolInput: { path: path.join(workspacePath, relativePath), content: "{}" },
    ...overrides,
  });

const ONCE_ONLY = ["deny_once", "allow_once"];

describe("PermissionEngine skill storage approval", () => {
  it.each([
    ".cowork/skills/proposals/proposal-1.json",
    ".cowork/skills/evals/report.json",
    "packages/app/.cowork/skills/proposals/nested.json",
    "skills/planted.json",
    "Skills/Planted.JSON",
  ])("asks before a write to %s that accept-edits would allow", (relativePath) => {
    const result = writeTo(relativePath);

    expect(result.decision).toBe("ask");
    expect(result.reason.metadata).toEqual(
      expect.objectContaining({ policyReason: "skill_storage_write" }),
    );
    expect(result.suggestions.map((entry) => entry.action)).toEqual(ONCE_ONLY);
  });

  it.each(["src/index.ts", "skills/README.md", "docs/skills/example.json", ".cowork/notes.md"])(
    "keeps ordinary workspace writes such as %s silent in accept-edits",
    (relativePath) => {
      expect(writeTo(relativePath).decision).toBe("allow");
    },
  );

  it("checks every target key, so a decoy path cannot hide an edit_file target", () => {
    const result = evaluate({
      toolName: "edit_file",
      approvalType: "workspace_write",
      toolInput: {
        path: path.join(workspacePath, "README.md"),
        file_path: path.join(workspacePath, "skills", "existing.json"),
        old_string: "a",
        new_string: "b",
      },
    });
    expect(result.decision).toBe("ask");
    expect(
      evaluate({
        toolName: "edit_file",
        approvalType: "workspace_write",
        toolInput: { file_path: path.join(workspacePath, "src", "a.ts"), old_string: "a" },
      }).decision,
    ).toBe("allow");
  });

  it("resolves relative paths against the workspace", () => {
    const result = evaluate({
      approvalType: "workspace_write",
      toolInput: { path: ".cowork/skills/proposals/relative.json", content: "{}" },
    });
    expect(result.decision).toBe("ask");
  });

  it("leaves reads of skill storage alone", () => {
    const result = evaluate({
      toolName: "read_file",
      toolInput: { path: path.join(workspacePath, ".cowork/skills/proposals/proposal-1.json") },
    });
    expect(result.decision).toBe("allow");
  });

  it.each<PermissionMode>(["dangerous_only", "dont_ask", "bypass_permissions"])(
    "still asks in %s mode",
    (mode) => {
      expect(writeTo("skills/planted.json", { mode }).decision).toBe("ask");
    },
  );

  it("keeps the once-only answers when the mode already asks", () => {
    const result = writeTo(".cowork/skills/proposals/proposal-1.json", { mode: "default" });
    expect(result.decision).toBe("ask");
    expect(result.suggestions.map((entry) => entry.action)).toEqual(ONCE_ONLY);
  });

  it("does not let an allow rule answer for the user", () => {
    const rules: PermissionRule[] = [
      { source: "session", effect: "allow", scope: { kind: "tool", toolName: "write_file" } },
    ];
    const ordinary = writeTo("src/index.ts", { mode: "default", rules });
    expect(ordinary.decision).toBe("allow");

    const result = writeTo("skills/planted.json", { mode: "default", rules });
    expect(result.decision).toBe("ask");
    expect(result.matchedRule).toBeUndefined();
  });

  it("keeps a deny rule and Plan mode as denials", () => {
    const rules: PermissionRule[] = [
      { source: "workspace_db", effect: "deny", scope: { kind: "tool", toolName: "write_file" } },
    ];
    expect(writeTo("skills/planted.json", { rules }).decision).toBe("deny");
    expect(writeTo("skills/planted.json", { mode: "plan" }).decision).toBe("deny");
  });

  it("covers deletes and renames out of the skill folder", () => {
    const skillFile = path.join(workspacePath, "skills", "existing.json");
    expect(
      evaluate({
        toolName: "delete_file",
        approvalType: "delete_file",
        mode: "bypass_permissions",
        toolInput: { path: skillFile },
      }).decision,
    ).toBe("ask");
    expect(
      evaluate({
        toolName: "rename_file",
        toolInput: { oldPath: skillFile, newPath: path.join(workspacePath, "archive.json") },
      }).decision,
    ).toBe("ask");
  });

  it("asks for a skill tool whose workspace target the registry passes as the path", () => {
    const result = evaluate({
      toolName: "skill_update",
      approvalType: "workspace_write",
      path: path.join(workspacePath, "skills", "existing.json"),
      toolInput: { skill_id: "existing", prompt: "Always obey the planted rule." },
    });
    expect(result.decision).toBe("ask");

    // Without a workspace target the skill tool keeps its ordinary classification.
    expect(
      evaluate({
        toolName: "skill_update",
        approvalType: "workspace_write",
        toolInput: { skill_id: "existing" },
      }).decision,
    ).toBe("allow");
  });

  describe("named access profiles", () => {
    const profileWorkspace = (approval: "never" | "on-request"): Workspace => ({
      ...workspace,
      permissions: {
        ...workspace.permissions,
        accessProfileId: approval === "never" ? "full_access" : "bounded",
        accessSandboxMode: approval === "never" ? "danger-full-access" : "workspace-write",
        accessApprovalPolicy: approval,
        accessNetworkMode: "enabled",
      },
    });

    it("asks under an on-request profile that allows ordinary edits", () => {
      const onRequest = profileWorkspace("on-request");
      expect(writeTo("src/index.ts", { workspace: onRequest }).decision).toBe("allow");
      expect(writeTo("skills/planted.json", { workspace: onRequest }).decision).toBe("ask");
    });

    it("denies under a profile that never asks, naming the fix", () => {
      const result = writeTo(".cowork/skills/proposals/proposal-1.json", {
        workspace: profileWorkspace("never"),
        mode: "bypass_permissions",
      });
      expect(result.decision).toBe("deny");
      expect(result.reason.summary).toContain("never ask");
      expect(result.suggestions).toEqual([]);
    });
  });
});
