import { describe, expect, it } from "vitest";

import {
  BUILTIN_ACCESS_PROFILE_IDS,
  isAccessProfileAtMostPrivileged,
  resolveAccessProfileDefinition,
  validateAccessProfileInheritance,
  type AccessProfileDefinition,
} from "../access-profiles";

const parent: AccessProfileDefinition = {
  id: "parent",
  label: "Parent",
  description: "Parent profile",
  sandbox: "workspace-write",
  approval: "on-request",
  reviewer: "user",
  network: "on-request",
  shellAccess: false,
  workspaceRoots: ["../shared"],
  filesystemRules: [
    { path: "../shared", access: "read" },
    { path: "../shared/private", access: "deny" },
  ],
  domainRules: [
    { pattern: "*.example.com", access: "allow" },
    { pattern: "blocked.example.com", access: "deny" },
  ],
};

function child(patch: Partial<AccessProfileDefinition>): AccessProfileDefinition {
  return {
    ...parent,
    id: "child",
    label: "Child",
    ...patch,
    extends: "parent",
  };
}

describe("access profile inheritance", () => {
  it("keeps inherited deny rules and narrows positive filesystem/domain scopes", () => {
    const profile = child({
      workspaceRoots: ["../shared/docs"],
      filesystemRules: [{ path: "../shared/docs", access: "read" }],
      domainRules: [{ pattern: "api.example.com", access: "allow" }],
    });
    const resolved = resolveAccessProfileDefinition(profile.id, [parent, profile]);

    expect(resolved.workspaceRoots).toEqual(["../shared/docs"]);
    expect(resolved.filesystemRules).toEqual([
      { path: "../shared/private", access: "deny" },
      { path: "../shared/docs", access: "read" },
    ]);
    expect(resolved.domainRules).toEqual([
      { pattern: "blocked.example.com", access: "deny" },
      { pattern: "api.example.com", access: "allow" },
    ]);
    expect(validateAccessProfileInheritance([parent, profile])).toEqual([]);
  });

  it("rejects a child that widens an inherited root, write scope, domain, shell, or reviewer", () => {
    expect(
      validateAccessProfileInheritance([parent, child({ workspaceRoots: ["../other"] })]),
    ).not.toEqual([]);
    const readOnlyParent: AccessProfileDefinition = {
      ...parent,
      id: "read_only_parent",
      workspaceRoots: undefined,
      filesystemRules: [{ path: "../shared", access: "read" }],
    };
    expect(
      validateAccessProfileInheritance([
        readOnlyParent,
        child({
          extends: readOnlyParent.id,
          filesystemRules: [{ path: "../shared/other", access: "write" }],
        }),
      ]),
    ).not.toEqual([]);
    expect(
      validateAccessProfileInheritance([
        parent,
        child({ domainRules: [{ pattern: "**.example.com", access: "allow" }] }),
      ]),
    ).not.toEqual([]);
    expect(validateAccessProfileInheritance([parent, child({ shellAccess: true })])).not.toEqual(
      [],
    );
    expect(
      validateAccessProfileInheritance([parent, child({ reviewer: "auto-review" })]),
    ).not.toEqual([]);
  });

  it("does not permit a child to override a parent deny with an allow", () => {
    const profile = child({
      filesystemRules: [
        { path: "../shared/private", access: "write" },
        { path: "../shared/docs", access: "read" },
      ],
      domainRules: [
        { pattern: "blocked.example.com", access: "allow" },
        { pattern: "api.example.com", access: "allow" },
      ],
    });
    expect(validateAccessProfileInheritance([parent, profile])).toEqual([]);
    const resolved = resolveAccessProfileDefinition(profile.id, [parent, profile]);
    expect(resolved.filesystemRules).toContainEqual({
      path: "../shared/private",
      access: "deny",
    });
    expect(resolved.domainRules).toContainEqual({
      pattern: "blocked.example.com",
      access: "deny",
    });
  });

  it("rejects inherited built-in widening and accepts a strictly narrower child", () => {
    const unsafe: AccessProfileDefinition = {
      id: "unsafe",
      label: "Unsafe",
      description: "Unsafe",
      sandbox: "danger-full-access",
      approval: "never",
      reviewer: "none",
      network: "enabled",
      shellAccess: true,
      extends: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    };
    expect(validateAccessProfileInheritance([unsafe])).not.toEqual([]);

    const safe: AccessProfileDefinition = {
      id: "safe",
      label: "Safe",
      description: "Safe",
      sandbox: "read-only",
      approval: "untrusted",
      reviewer: "user",
      network: "disabled",
      shellAccess: false,
      extends: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    };
    expect(validateAccessProfileInheritance([safe])).toEqual([]);
    expect(
      isAccessProfileAtMostPrivileged(safe, resolveAccessProfileDefinition(safe.extends)),
    ).toBe(true);
  });

  it("normalizes profile ids before checking reserved names and duplicates", () => {
    expect(
      validateAccessProfileInheritance([
        { ...child({ id: " custom-safe " }), id: " custom-safe " },
        { ...child({ id: "custom-safe" }), id: "custom-safe" },
        { ...child({ id: " full_access " }), id: " full_access " },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: "custom-safe" }),
        expect.objectContaining({ profileId: "full_access" }),
      ]),
    );
  });

  it("rejects empty profile ids without throwing", () => {
    expect(validateAccessProfileInheritance([{ ...child({ id: "   " }), id: "   " }])).toEqual([
      { profileId: "", message: "Profile id must be a non-empty string." },
    ]);
  });

  it("treats an explicit empty child rule list as a narrowing override", () => {
    const parentProfile: AccessProfileDefinition = {
      ...parent,
      id: "rule_parent",
      workspaceRoots: undefined,
      filesystemRules: [{ path: "../shared", access: "read" }],
      domainRules: [{ pattern: "docs.example.com", access: "allow" }],
    };
    const childProfile: AccessProfileDefinition = {
      ...parentProfile,
      id: "rule_child",
      filesystemRules: [],
      domainRules: [],
      extends: parentProfile.id,
    };

    const resolved = resolveAccessProfileDefinition(childProfile.id, [parentProfile, childProfile]);
    expect(resolved.filesystemRules).toBeUndefined();
    expect(resolved.domainRules).toBeUndefined();
  });

  it("allows a scoped child to narrow a full-access parent", () => {
    const childProfile: AccessProfileDefinition = {
      id: "full_child",
      label: "Child",
      description: "Child",
      sandbox: "workspace-write",
      approval: "on-request",
      reviewer: "user",
      network: "disabled",
      workspaceRoots: ["/tmp/project"],
      extends: BUILTIN_ACCESS_PROFILE_IDS.fullAccess,
    };

    expect(validateAccessProfileInheritance([childProfile])).toEqual([]);
  });

  it("treats a built-in workspace root as covering safe relative child rules", () => {
    const childProfile: AccessProfileDefinition = {
      id: "workspace_docs",
      label: "Workspace docs",
      description: "Read a workspace subtree.",
      sandbox: "read-only",
      approval: "on-request",
      reviewer: "user",
      network: "disabled",
      filesystemRules: [{ path: "src", access: "read" }],
      extends: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    };

    expect(validateAccessProfileInheritance([childProfile])).toEqual([]);
  });
});
