import type { AccessProfileDefinition, AccessProfileId } from "../../shared/access-profiles";
import {
  BUILTIN_ACCESS_PROFILE_IDS,
  validateAccessProfileInheritance,
} from "../../shared/access-profiles";
import type { PermissionMode, PermissionRule } from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { normalizePermissionScope, permissionRuleFingerprint } from "./permission-utils";

export interface PermissionSettings {
  version: 1;
  defaultMode: PermissionMode;
  defaultShellEnabled: boolean;
  defaultPermissionAccess: "default" | "full";
  defaultAccessProfileId?: AccessProfileId;
  accessProfiles?: AccessProfileDefinition[];
  rules: PermissionRule[];
}

const DEFAULT_SETTINGS: PermissionSettings = {
  version: 1,
  defaultMode: "dangerous_only",
  defaultShellEnabled: false,
  defaultPermissionAccess: "default",
  defaultAccessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
  accessProfiles: [],
  rules: [],
};

export class PermissionSettingsManager {
  private static cachedSettings: PermissionSettings | null = null;

  static loadSettings(): PermissionSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<PermissionSettings>("permissions");
        if (stored) {
          this.cachedSettings = this.normalizeSettings(stored);
          return this.cachedSettings;
        }
      }
    } catch (error) {
      console.error("[PermissionSettingsManager] Failed to load settings:", error);
    }

    this.cachedSettings = this.normalizeSettings(DEFAULT_SETTINGS);
    return this.cachedSettings;
  }

  static saveSettings(settings: PermissionSettings): void {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("SecureSettingsRepository not initialized");
    }
    const requestedProfiles = Array.isArray(settings?.accessProfiles)
      ? settings.accessProfiles.filter(
          (profile): profile is AccessProfileDefinition =>
            !!profile && typeof profile === "object" && typeof profile.id === "string",
        )
      : [];
    const requestedInheritanceIssues = validateAccessProfileInheritance(requestedProfiles);
    if (requestedInheritanceIssues.length > 0) {
      throw new Error(
        `Invalid access profile inheritance: ${requestedInheritanceIssues
          .map((issue) => issue.message)
          .join(" ")}`,
      );
    }
    const normalized = this.normalizeSettings(settings);
    const repository = SecureSettingsRepository.getInstance();
    repository.save("permissions", normalized);
    this.cachedSettings = normalized;
  }

  static appendRule(rule: PermissionRule): PermissionSettings {
    const current = this.loadSettings();
    const nextRules = [...current.rules];
    const fingerprint = permissionRuleFingerprint(rule);
    if (!nextRules.some((existing) => permissionRuleFingerprint(existing) === fingerprint)) {
      nextRules.push({
        ...rule,
        source: "profile",
        scope: normalizePermissionScope(rule.scope),
        createdAt: rule.createdAt || Date.now(),
      });
    }
    const next = {
      ...current,
      rules: nextRules,
    };
    this.saveSettings(next);
    return next;
  }

  static clearCache(): void {
    this.cachedSettings = null;
  }

  private static normalizeSettings(settings: PermissionSettings): PermissionSettings {
    const builtinProfileIds = new Set<string>(Object.values(BUILTIN_ACCESS_PROFILE_IDS));
    const seenProfileIds = new Set<string>();
    const normalizedProfiles = Array.isArray(settings?.accessProfiles)
      ? settings.accessProfiles
          .filter(
            (profile): profile is AccessProfileDefinition =>
              !!profile &&
              typeof profile === "object" &&
              typeof profile.id === "string" &&
              profile.id.trim().length > 0 &&
              profile.id.trim().length <= 100 &&
              !builtinProfileIds.has(profile.id.trim()) &&
              !seenProfileIds.has(profile.id.trim()) &&
              typeof profile.label === "string" &&
              profile.label.trim().length > 0 &&
              profile.label.trim().length <= 120 &&
              typeof profile.description === "string" &&
              profile.description.trim().length <= 1000 &&
              (profile.sandbox === "read-only" ||
                profile.sandbox === "workspace-write" ||
                profile.sandbox === "danger-full-access") &&
              (profile.approval === "untrusted" ||
                profile.approval === "on-request" ||
                profile.approval === "never") &&
              (profile.reviewer === "user" ||
                profile.reviewer === "auto-review" ||
                profile.reviewer === "none") &&
              (profile.network === "disabled" ||
                profile.network === "on-request" ||
                profile.network === "enabled"),
          )
          .map((profile) => {
            const id = profile.id.trim();
            seenProfileIds.add(id);
            const workspaceRoots = Array.isArray(profile.workspaceRoots)
              ? profile.workspaceRoots
                  .filter((value) => typeof value === "string")
                  .map((value) => value.trim())
                  .filter((value) => value.length > 0 && value.length <= 4096)
                  .slice(0, 100)
              : [];
            const hasWorkspaceRoots = Array.isArray(profile.workspaceRoots);
            const filesystemRules = Array.isArray(profile.filesystemRules)
              ? profile.filesystemRules
                  .filter(
                    (rule) =>
                      !!rule &&
                      typeof rule === "object" &&
                      typeof rule.path === "string" &&
                      rule.path.trim().length > 0 &&
                      rule.path.trim().length <= 4096 &&
                      (rule.access === "read" || rule.access === "write" || rule.access === "deny"),
                  )
                  .map((rule) => ({
                    path: rule.path.trim(),
                    access: rule.access,
                  }))
                  .slice(0, 100)
              : [];
            const hasFilesystemRules = Array.isArray(profile.filesystemRules);
            const domainRules = Array.isArray(profile.domainRules)
              ? profile.domainRules
                  .filter(
                    (rule) =>
                      !!rule &&
                      typeof rule === "object" &&
                      typeof rule.pattern === "string" &&
                      rule.pattern.trim().length > 0 &&
                      rule.pattern.trim().length <= 253 &&
                      (rule.access === "allow" || rule.access === "deny"),
                  )
                  .map((rule) => ({
                    pattern: rule.pattern.trim().toLowerCase(),
                    access: rule.access,
                  }))
                  .slice(0, 100)
              : [];
            const hasDomainRules = Array.isArray(profile.domainRules);
            const extendsId =
              typeof profile.extends === "string" &&
              profile.extends.trim().length > 0 &&
              profile.extends.trim().length <= 100
                ? profile.extends.trim()
                : undefined;

            return {
              id,
              label: profile.label.trim(),
              description: profile.description.trim(),
              sandbox: profile.sandbox,
              approval: profile.approval,
              reviewer: profile.reviewer,
              network: profile.network,
              ...(typeof profile.shellAccess === "boolean"
                ? { shellAccess: profile.shellAccess }
                : {}),
              ...(hasWorkspaceRoots ? { workspaceRoots } : {}),
              ...(hasFilesystemRules ? { filesystemRules } : {}),
              ...(hasDomainRules ? { domainRules } : {}),
              ...(extendsId ? { extends: extendsId } : {}),
            } satisfies AccessProfileDefinition;
          })
          .slice(0, 50)
      : [];

    const inheritanceIssues = validateAccessProfileInheritance(normalizedProfiles);
    const invalidProfileIds = new Set(inheritanceIssues.map((issue) => issue.profileId));
    const safeProfiles = normalizedProfiles.filter((profile) => !invalidProfileIds.has(profile.id));

    const configuredDefaultProfileId =
      typeof settings?.defaultAccessProfileId === "string" &&
      settings.defaultAccessProfileId.trim().length <= 100 &&
      settings.defaultAccessProfileId.trim()
        ? settings.defaultAccessProfileId.trim()
        : undefined;
    const knownProfileIds = new Set<string>([
      ...Object.values(BUILTIN_ACCESS_PROFILE_IDS),
      ...safeProfiles.map((profile) => profile.id),
    ]);
    const hasConfiguredDefault = Boolean(configuredDefaultProfileId);
    const configuredDefaultIsUnknown =
      hasConfiguredDefault && !knownProfileIds.has(configuredDefaultProfileId || "");
    const defaultAccessProfileId = knownProfileIds.has(configuredDefaultProfileId || "")
      ? configuredDefaultProfileId
      : configuredDefaultIsUnknown
        ? BUILTIN_ACCESS_PROFILE_IDS.askForApproval
        : settings?.defaultPermissionAccess === "full"
          ? BUILTIN_ACCESS_PROFILE_IDS.fullAccess
          : undefined;

    return {
      version: 1,
      // A deleted/invalid named default must not fall back to an old bypass
      // setting. Fail closed to the built-in approval profile instead.
      defaultMode: configuredDefaultIsUnknown
        ? "dangerous_only"
        : settings?.defaultMode || "dangerous_only",
      defaultShellEnabled: settings?.defaultShellEnabled === true,
      defaultPermissionAccess:
        configuredDefaultIsUnknown || settings?.defaultPermissionAccess !== "full"
          ? "default"
          : "full",
      // Keep this optional for older settings. The resolver uses defaultMode
      // when no named profile was stored, so migrating an existing
      // dangerous_only/accept_edits/bypass_permissions setting cannot silently
      // change its behavior to the Ask profile.
      ...(defaultAccessProfileId ? { defaultAccessProfileId } : {}),
      accessProfiles: safeProfiles,
      rules: Array.isArray(settings?.rules)
        ? settings.rules
            .filter((rule): rule is PermissionRule => !!rule && typeof rule === "object")
            .map((rule) => ({
              ...rule,
              source: "profile",
              scope: normalizePermissionScope(rule.scope),
              createdAt: rule.createdAt || Date.now(),
            }))
        : [],
    };
  }
}
