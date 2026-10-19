/**
 * An applied directory-backed skill may read its own plugin pack (references, scripts,
 * assets next to its SKILL.md) under a named access profile: read-only, only inside the
 * task's tool-call scope, only for packs the PluginRegistry loaded, and never past a
 * profile deny rule or a symlink out of the pack.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/mock/user/data") },
}));

import { BUILTIN_ACCESS_PROFILE_IDS } from "../../../shared/access-profiles";
import type { CustomSkill, PermissionSettingsData, Workspace } from "../../../shared/types";
import { evaluateWorkspaceFilesystemAccess } from "../access-profile-paths";
import {
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
} from "../access-profile-resolver";
import {
  getSkillPackReadRoots,
  registerSkillPackRoot,
  resolveSkillPackReadGrant,
  runWithSkillPackReadAccess,
  unregisterSkillPackRoot,
  type SkillPackReadGrant,
} from "../skill-pack-read-access";
import { FileTools } from "../../agent/tools/file-tools";
import { GlobTools } from "../../agent/tools/glob-tools";

const cleanup: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

const settings: PermissionSettingsData = {
  version: 1,
  defaultMode: "default",
  defaultShellEnabled: false,
  defaultPermissionAccess: "default",
  defaultAccessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
  accessProfiles: [],
  rules: [],
};

/** A workspace as an app task sees it under a built-in named profile. */
function profiledWorkspace(
  workspacePath: string,
  profileId: string = BUILTIN_ACCESS_PROFILE_IDS.approveForMe,
  overrides: Partial<Workspace["permissions"]> = {},
): Workspace {
  const workspace: Workspace = {
    id: "ws-1",
    name: "Workspace",
    path: workspacePath,
    permissions: {
      read: true,
      write: true,
      delete: true,
      shell: false,
      network: false,
      unrestrictedFileAccess: false,
      allowedPaths: [],
    },
    createdAt: Date.now(),
  } as Workspace;
  const profile = resolveEffectiveAccessProfile({
    task: { agentConfig: { accessProfileId: profileId } },
    workspace,
    settings,
  });
  const applied = applyAccessProfileToWorkspace(workspace, profile);
  return { ...applied, permissions: { ...applied.permissions, ...overrides } };
}

function writeFile(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function packSkill(skillFile: string, pluginName = "unity"): CustomSkill {
  return {
    id: `${pluginName}:implement-in-app-purchases`,
    name: "Implement In-App Purchases",
    description: "IAP",
    icon: "🧩",
    prompt: "Read references/pre-check.md",
    enabled: true,
    source: "managed",
    filePath: skillFile,
    metadata: { version: "1.0.0", pluginSource: pluginName },
  } as CustomSkill;
}

describe("applied skill pack read access", () => {
  let extensions: string;
  let unityRoot: string;
  let skillFile: string;
  let preCheck: string;
  let sharedReference: string;
  let siblingRoot: string;
  let siblingFile: string;
  let outsideDir: string;
  let workspace: Workspace;
  let grant: SkillPackReadGrant;

  const granted = <T>(fn: () => T): T => runWithSkillPackReadAccess([grant], fn);
  const ungranted = <T>(fn: () => T): T => runWithSkillPackReadAccess([], fn);

  beforeEach(() => {
    extensions = tempDir("cowork-skill-pack-ext-");
    unityRoot = path.join(extensions, "unity");
    skillFile = path.join(unityRoot, "skills", "implement-in-app-purchases", "SKILL.md");
    preCheck = path.join(path.dirname(skillFile), "references", "pre-check.md");
    sharedReference = path.join(unityRoot, "references", "unity-version.md");
    writeFile(path.join(unityRoot, "cowork.plugin.json"), '{"name":"unity"}');
    writeFile(skillFile, "---\nname: iap\n---\nRead references/pre-check.md first.\n");
    writeFile(preCheck, "# Pre-check\n\n- Unity IAP package installed\n");
    writeFile(sharedReference, "# Unity 6\n");

    siblingRoot = path.join(extensions, "other-pack");
    siblingFile = path.join(siblingRoot, "skills", "x", "SKILL.md");
    writeFile(siblingFile, "Sibling pack skill\n");

    outsideDir = tempDir("cowork-skill-pack-outside-");
    writeFile(path.join(outsideDir, "secret.txt"), "do not read\n");

    workspace = profiledWorkspace(tempDir("cowork-skill-pack-ws-"));
    expect(registerSkillPackRoot("unity", unityRoot, [skillFile])).toBe(true);
    expect(registerSkillPackRoot("other-pack", siblingRoot, [siblingFile])).toBe(true);
    const resolved = resolveSkillPackReadGrant(packSkill(skillFile));
    expect(resolved).not.toBeNull();
    grant = resolved as SkillPackReadGrant;
  });

  afterEach(() => {
    unregisterSkillPackRoot("unity");
    unregisterSkillPackRoot("other-pack");
    while (cleanup.length > 0) {
      const target = cleanup.pop();
      if (target) fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("starts from a named profile that stops at the workspace boundary", () => {
    expect(workspace.permissions.accessProfileId).toBe(BUILTIN_ACCESS_PROFILE_IDS.approveForMe);
    expect(workspace.permissions.unrestrictedFileAccess).toBe(false);
    expect(evaluateWorkspaceFilesystemAccess(workspace, preCheck, "read")).toMatchObject({
      decision: "deny",
      reason: "outside_workspace",
    });
  });

  it("allows reads inside the applied skill's pack, next to SKILL.md and at the pack root", () => {
    for (const target of [preCheck, sharedReference, skillFile, unityRoot]) {
      expect(granted(() => evaluateWorkspaceFilesystemAccess(workspace, target, "read"))).toEqual({
        decision: "allow",
        path: target,
        reason: "applied_skill_pack_read",
      });
    }
    // Relative traversal from the workspace still resolves into the pack.
    const relative = path.relative(workspace.path, preCheck);
    expect(
      granted(() => evaluateWorkspaceFilesystemAccess(workspace, relative, "read")).decision,
    ).toBe("allow");
    expect(granted(() => getSkillPackReadRoots())).toEqual([fs.realpathSync.native(unityRoot)]);
  });

  it("works under Ask for approval too", () => {
    const ask = profiledWorkspace(workspace.path, BUILTIN_ACCESS_PROFILE_IDS.askForApproval);
    expect(granted(() => evaluateWorkspaceFilesystemAccess(ask, preCheck, "read"))).toMatchObject({
      decision: "allow",
      reason: "applied_skill_pack_read",
    });
  });

  it("never grants writes or deletes inside the pack", () => {
    for (const operation of ["write", "delete"] as const) {
      for (const target of [preCheck, skillFile, path.join(unityRoot, "new.md")]) {
        expect(
          granted(() => evaluateWorkspaceFilesystemAccess(workspace, target, operation)),
        ).toMatchObject({ decision: "deny", reason: "outside_workspace" });
      }
    }
  });

  it("denies sibling packs, the extensions folder, and other paths", () => {
    for (const target of [
      siblingFile,
      siblingRoot,
      extensions,
      path.join(outsideDir, "secret.txt"),
      path.join(unityRoot, "..", "other-pack", "skills", "x", "SKILL.md"),
      os.homedir(),
    ]) {
      expect(
        granted(() => evaluateWorkspaceFilesystemAccess(workspace, target, "read")),
      ).toMatchObject({ decision: "deny" });
    }
  });

  it("denies a symlink out of the pack", () => {
    const escape = path.join(path.dirname(preCheck), "escape");
    fs.symlinkSync(outsideDir, escape, "dir");
    const fileLink = path.join(unityRoot, "references", "secret-link.txt");
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), fileLink);

    for (const target of [path.join(escape, "secret.txt"), escape, fileLink]) {
      expect(
        granted(() => evaluateWorkspaceFilesystemAccess(workspace, target, "read")),
      ).toMatchObject({ decision: "deny" });
    }
  });

  it("ignores a symlink that points into the pack from elsewhere", () => {
    const link = path.join(outsideDir, "pack-link");
    fs.symlinkSync(unityRoot, link, "dir");
    expect(
      granted(() =>
        evaluateWorkspaceFilesystemAccess(workspace, path.join(link, "references"), "read"),
      ),
    ).toMatchObject({ decision: "deny" });
  });

  it("grants nothing when no skill was applied or outside a task scope", () => {
    expect(evaluateWorkspaceFilesystemAccess(workspace, preCheck, "read")).toMatchObject({
      decision: "deny",
      reason: "outside_workspace",
    });
    expect(
      ungranted(() => evaluateWorkspaceFilesystemAccess(workspace, preCheck, "read")),
    ).toMatchObject({ decision: "deny", reason: "outside_workspace" });
    expect(ungranted(() => getSkillPackReadRoots())).toEqual([]);
  });

  it("does not let one pack's grant read another pack", () => {
    const siblingGrant = resolveSkillPackReadGrant(packSkill(siblingFile, "other-pack"));
    expect(siblingGrant).not.toBeNull();
    expect(
      runWithSkillPackReadAccess([siblingGrant], () =>
        evaluateWorkspaceFilesystemAccess(workspace, preCheck, "read"),
      ),
    ).toMatchObject({ decision: "deny" });
  });

  it("keeps profile deny rules, a disabled read capability, and an unavailable profile", () => {
    const denied = profiledWorkspace(workspace.path, BUILTIN_ACCESS_PROFILE_IDS.approveForMe, {
      accessFilesystemRules: [{ path: unityRoot, access: "deny" }],
    });
    expect(
      granted(() => evaluateWorkspaceFilesystemAccess(denied, preCheck, "read")),
    ).toMatchObject({ decision: "deny", reason: "profile_filesystem_denied" });

    const noRead = profiledWorkspace(workspace.path, BUILTIN_ACCESS_PROFILE_IDS.approveForMe, {
      read: false,
    });
    expect(
      granted(() => evaluateWorkspaceFilesystemAccess(noRead, preCheck, "read")),
    ).toMatchObject({ decision: "deny", reason: "workspace_read_disabled" });

    const unavailable = profiledWorkspace(workspace.path, BUILTIN_ACCESS_PROFILE_IDS.approveForMe, {
      accessProfileUnavailable: true,
    });
    expect(
      granted(() => evaluateWorkspaceFilesystemAccess(unavailable, preCheck, "read")),
    ).toMatchObject({ decision: "deny", reason: "access_profile_unavailable" });
  });

  it("revokes the grant as soon as the pack is unregistered or its root moves", () => {
    unregisterSkillPackRoot("unity");
    expect(
      granted(() => evaluateWorkspaceFilesystemAccess(workspace, preCheck, "read")),
    ).toMatchObject({ decision: "deny", reason: "outside_workspace" });
    expect(resolveSkillPackReadGrant(packSkill(skillFile))).toBeNull();

    // Re-registered at another location: the old grant's root no longer matches.
    const moved = path.join(extensions, "unity-moved");
    fs.cpSync(unityRoot, moved, { recursive: true });
    const movedSkill = path.join(moved, "skills", "implement-in-app-purchases", "SKILL.md");
    expect(registerSkillPackRoot("unity", moved, [movedSkill])).toBe(true);
    expect(
      granted(() =>
        evaluateWorkspaceFilesystemAccess(
          workspace,
          path.join(moved, "skills", "implement-in-app-purchases", "references", "pre-check.md"),
          "read",
        ),
      ),
    ).toMatchObject({ decision: "deny" });
  });

  it("only grants the exact directory-backed skill the registry built", () => {
    expect(resolveSkillPackReadGrant(undefined)).toBeNull();
    // A workspace skill that shadows the id gets nothing, even with the same file path.
    expect(resolveSkillPackReadGrant({ ...packSkill(skillFile), source: "workspace" })).toBeNull();
    // A skill that only names the pack in its metadata gets nothing.
    expect(resolveSkillPackReadGrant(packSkill(path.join(outsideDir, "SKILL.md")))).toBeNull();
    // An inline pack skill has no directory.
    expect(resolveSkillPackReadGrant({ ...packSkill(skillFile), filePath: undefined })).toBeNull();
    // A pack the registry never loaded.
    expect(resolveSkillPackReadGrant(packSkill(skillFile, "not-loaded"))).toBeNull();
  });

  it("refuses unsafe or empty pack roots", () => {
    expect(registerSkillPackRoot("home", os.homedir(), [path.join(os.homedir(), "SKILL.md")])).toBe(
      false,
    );
    expect(registerSkillPackRoot("root", path.parse(os.tmpdir()).root, [skillFile])).toBe(false);
    expect(registerSkillPackRoot("unity", unityRoot, [])).toBe(false);
    // A refused re-registration also drops the earlier grant.
    expect(resolveSkillPackReadGrant(packSkill(skillFile))).toBeNull();
    expect(registerSkillPackRoot("unity", unityRoot, [path.join(outsideDir, "SKILL.md")])).toBe(
      false,
    );
    expect(registerSkillPackRoot("missing", path.join(extensions, "missing"), [skillFile])).toBe(
      false,
    );
  });

  it("lets read_file and glob read the pack but never write it", async () => {
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(false),
      captureTaskMutationBaseline: vi.fn(),
      recordSensitiveSourceRead: vi.fn(),
    } as Any;
    const files = new FileTools(workspace, daemon, "task-1");

    const read = await granted(() => files.readFile(preCheck));
    expect(read.content).toContain("Unity IAP package installed");
    const listing = await granted(() => files.listDirectory(path.dirname(preCheck)));
    expect(JSON.stringify(listing)).toContain("pre-check.md");
    const glob = new GlobTools(workspace, daemon, "task-1");
    const matches = await granted(() => glob.glob({ pattern: "**/*.md", path: unityRoot }));
    expect(JSON.stringify(matches)).toContain("pre-check.md");
    // Reading needed no approval.
    expect(daemon.requestApproval).not.toHaveBeenCalled();

    await expect(ungranted(() => files.readFile(preCheck))).rejects.toThrow(
      /outside workspace boundary/i,
    );
    await expect(
      granted(() => files.readFile(path.join(outsideDir, "secret.txt"))),
    ).rejects.toThrow();

    await expect(granted(() => files.writeFile(preCheck, "- planted"))).rejects.toThrow();
    expect(fs.readFileSync(preCheck, "utf8")).toContain("Unity IAP package installed");
  });
});
