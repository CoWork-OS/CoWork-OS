import type { AccessProfileDefinition, AccessProfileId } from "../../shared/access-profiles";
import {
  BUILTIN_ACCESS_PROFILE_IDS,
  validateAccessProfileInheritance,
} from "../../shared/access-profiles";
import type {
  PermissionMode,
  PermissionRule,
  PermissionSettingsData,
  PermissionSettingsMigration,
  PermissionSettingsMigrationSnapshot,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { normalizePermissionScope, permissionRuleFingerprint } from "./permission-utils";

export interface PermissionSettings {
  /** v1 is accepted for test/IPC compatibility; loadSettings returns v2. */
  version: 1 | 2;
  defaultMode: PermissionMode;
  defaultShellEnabled: boolean;
  defaultPermissionAccess: "default" | "full";
  defaultAccessProfileId?: AccessProfileId;
  accessProfiles?: AccessProfileDefinition[];
  rules: PermissionRule[];
  migration?: PermissionSettingsMigration;
}

const DEFAULT_SETTINGS: PermissionSettings = {
  version: 2,
  defaultMode: "dangerous_only",
  defaultShellEnabled: false,
  defaultPermissionAccess: "default",
  defaultAccessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
  accessProfiles: [],
  rules: [],
};

type PermissionSettingsInput = Omit<
  Partial<PermissionSettingsData>,
  "accessProfiles" | "rules" | "migration"
> & {
  version?: unknown;
  migration?: unknown;
  // Inputs can come from the permissive recoverable migration envelope. The
  // active normalizer validates and narrows these arrays before use.
  accessProfiles?: readonly unknown[];
  rules?: readonly unknown[];
};

const PERMISSION_SETTINGS_VERSION = 2 as const;
const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "plan",
  "dangerous_only",
  "accept_edits",
  "dont_ask",
  "bypass_permissions",
];

export class PermissionSettingsManager {
  private static cachedSettings: PermissionSettings | null = null;

  static loadSettings(): PermissionSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<PermissionSettingsInput>("permissions");
        if (stored) {
          const normalized = this.normalizeSettings(stored);
          this.cachedSettings = normalized;
          // Persist the migration once, after a fully normalized snapshot is
          // available. A failed write leaves the in-memory result usable and
          // will be retried after the cache is cleared on the next startup.
          if (this.requiresMigrationWrite(stored)) {
            try {
              repository.save("permissions", normalized);
            } catch (error) {
              console.warn(
                "[PermissionSettingsManager] Failed to persist settings migration; retaining in-memory fail-closed result:",
                error,
              );
            }
          }
          return this.cachedSettings;
        }
      }
    } catch (error) {
      console.error("[PermissionSettingsManager] Failed to load settings:", error);
    }

    this.cachedSettings = this.normalizeSettings(DEFAULT_SETTINGS);
    return this.cachedSettings;
  }

  static saveSettings(settings: PermissionSettingsInput): void {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("SecureSettingsRepository not initialized");
    }
    const existingMigration = this.cachedSettings?.migration;
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
    const normalized = this.normalizeSettings({
      ...settings,
      // Renderer validation intentionally need not expose the migration
      // backup. Keep the durable prior representation across ordinary edits.
      ...(existingMigration && !settings?.migration ? { migration: existingMigration } : {}),
    });
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

  private static requiresMigrationWrite(source: PermissionSettingsInput): boolean {
    const sourceVersion = this.sourceVersion(source);
    if (sourceVersion !== PERMISSION_SETTINGS_VERSION) return true;

    // A v2 record that already names a built-in or persisted custom profile is
    // complete even when it predates the optional diagnostic backup. Avoid
    // writing it on every cache clear; the migration itself remains needed for
    // v2 records with no usable named default.
    const configuredDefaultProfileId =
      typeof source.defaultAccessProfileId === "string" && source.defaultAccessProfileId.trim()
        ? source.defaultAccessProfileId.trim()
        : undefined;
    const builtinIds = new Set<string>(Object.values(BUILTIN_ACCESS_PROFILE_IDS));
    const customDefaultExists =
      !!configuredDefaultProfileId &&
      Array.isArray(source.accessProfiles) &&
      source.accessProfiles.some(
        (profile) =>
          !!profile &&
          typeof profile === "object" &&
          typeof (profile as { id?: unknown }).id === "string" &&
          (profile as { id: string }).id.trim() === configuredDefaultProfileId,
      );
    const knownDefault =
      !!configuredDefaultProfileId &&
      (builtinIds.has(configuredDefaultProfileId) || customDefaultExists);
    if (!knownDefault) return true;

    if (source.migration === undefined || source.migration === null) return false;
    const migrationVersion =
      typeof source.migration === "object" && "version" in source.migration
        ? source.migration.version
        : undefined;
    return migrationVersion !== PERMISSION_SETTINGS_VERSION;
  }

  private static sourceVersion(settings: PermissionSettingsInput): number {
    const value = Number(settings?.version);
    return Number.isInteger(value) && value > 0 ? value : 1;
  }

  private static normalizeSettings(settings: PermissionSettingsInput): PermissionSettings {
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
    let safeProfiles = normalizedProfiles.filter((profile) => !invalidProfileIds.has(profile.id));

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
    const sourceVersion = this.sourceVersion(settings);
    const sourceMode = this.normalizePermissionMode(settings?.defaultMode);
    const sourceShellEnabled = settings?.defaultShellEnabled === true;
    const sourcePermissionAccess =
      settings?.defaultPermissionAccess === "full" ? "full" : "default";
    const priorMigration = this.normalizeMigration(settings?.migration);
    let defaultAccessProfileId: AccessProfileId | undefined;
    let defaultProvenance: PermissionSettingsMigration["defaultProvenance"] = "legacy_mode";

    if (configuredDefaultIsUnknown) {
      // Keep the missing id so the resolver can surface an unavailable,
      // read-only profile. Falling back to Ask here would make deleting a
      // custom default silently widen new tasks (especially shell access).
      defaultAccessProfileId = configuredDefaultProfileId as AccessProfileId;
      defaultProvenance = "fail_closed_unknown_profile";
    } else if (configuredDefaultProfileId) {
      defaultAccessProfileId = configuredDefaultProfileId as AccessProfileId;
      defaultProvenance = "existing_profile";
    } else {
      const migratedDefault = this.buildLegacyDefaultProfile(
        sourceMode,
        sourceShellEnabled,
        sourcePermissionAccess,
        safeProfiles,
      );
      defaultAccessProfileId = migratedDefault.id;
      defaultProvenance = migratedDefault.provenance;
      if (migratedDefault.profile && safeProfiles.length < 50) {
        safeProfiles = [...safeProfiles, migratedDefault.profile];
      }
    }

    const migration =
      priorMigration ||
      (sourceVersion < PERMISSION_SETTINGS_VERSION ||
      !configuredDefaultProfileId ||
      configuredDefaultIsUnknown
        ? {
            version: PERMISSION_SETTINGS_VERSION,
            sourceVersion,
            migratedAt: Date.now(),
            previous: this.snapshotSettings(settings),
            defaultProvenance,
          }
        : undefined);

    return {
      version: PERMISSION_SETTINGS_VERSION,
      // Preserve the legacy mode for profile-less historical tasks. New task
      // roots receive the named default through the shared entrypoint helper.
      //
      // A deleted or otherwise unknown named default must not fall back to an
      // old bypass setting: profile-less legacy tasks inherit this mode
      // directly, so preserving `bypass_permissions` here resolves them to the
      // full-access profile (shell on, unrestricted filesystem, no sandbox).
      // Fail closed to the built-in approval profile instead, matching the
      // clamp already applied to defaultPermissionAccess below.
      defaultMode: configuredDefaultIsUnknown ? "dangerous_only" : sourceMode,
      defaultShellEnabled: sourceShellEnabled,
      defaultPermissionAccess: configuredDefaultIsUnknown ? "default" : sourcePermissionAccess,
      ...(defaultAccessProfileId ? { defaultAccessProfileId } : {}),
      accessProfiles: safeProfiles,
      rules: Array.isArray(settings?.rules)
        ? settings.rules
            .filter(
              (rule): rule is PermissionRule =>
                !!rule &&
                typeof rule === "object" &&
                (rule.effect === "allow" || rule.effect === "deny" || rule.effect === "ask") &&
                !!rule.scope &&
                typeof rule.scope === "object" &&
                typeof rule.scope.kind === "string",
            )
            .map((rule) => ({
              ...rule,
              source: "profile",
              scope: normalizePermissionScope(rule.scope),
              createdAt: rule.createdAt || Date.now(),
            }))
        : [],
      ...(migration ? { migration } : {}),
    };
  }

  private static normalizePermissionMode(value: unknown): PermissionMode {
    return typeof value === "string" && PERMISSION_MODES.includes(value as PermissionMode)
      ? (value as PermissionMode)
      : "dangerous_only";
  }

  private static snapshotSettings(
    settings: PermissionSettingsInput,
  ): PermissionSettingsMigrationSnapshot {
    const snapshot: PermissionSettingsMigrationSnapshot = {
      version: this.sourceVersion(settings),
      defaultMode: this.normalizePermissionMode(settings?.defaultMode),
      defaultShellEnabled: settings?.defaultShellEnabled === true,
      defaultPermissionAccess: settings?.defaultPermissionAccess === "full" ? "full" : "default",
    };
    if (
      typeof settings?.defaultAccessProfileId === "string" &&
      settings.defaultAccessProfileId.trim()
    ) {
      snapshot.defaultAccessProfileId = settings.defaultAccessProfileId.trim() as AccessProfileId;
    }
    if (Array.isArray(settings?.accessProfiles)) {
      snapshot.accessProfiles = settings.accessProfiles
        .filter(
          (profile): profile is AccessProfileDefinition => !!profile && typeof profile === "object",
        )
        .slice(0, 50);
    }
    if (Array.isArray(settings?.rules)) {
      snapshot.rules = settings.rules
        .filter((rule): rule is PermissionRule => !!rule && typeof rule === "object")
        .slice(0, 100);
    }
    return snapshot;
  }

  private static normalizeMigration(value: unknown): PermissionSettingsMigration | undefined {
    if (!value || typeof value !== "object") return undefined;
    const migration = value as Partial<PermissionSettingsMigration>;
    const sourceVersion =
      typeof migration.sourceVersion === "number" && Number.isInteger(migration.sourceVersion)
        ? migration.sourceVersion
        : undefined;
    const migratedAt =
      typeof migration.migratedAt === "number" && Number.isFinite(migration.migratedAt)
        ? migration.migratedAt
        : undefined;
    if (
      migration.version !== PERMISSION_SETTINGS_VERSION ||
      sourceVersion === undefined ||
      migratedAt === undefined ||
      !migration.previous ||
      typeof migration.previous !== "object"
    ) {
      return undefined;
    }
    // Keep explicit narrowed locals for older TypeScript control-flow
    // analysis; these values are used in the durable migration envelope below.
    const normalizedSourceVersion = sourceVersion;
    const normalizedMigratedAt = migratedAt;
    const provenance = migration.defaultProvenance;
    if (
      provenance !== "existing_profile" &&
      provenance !== "legacy_mode" &&
      provenance !== "legacy_full_access" &&
      provenance !== "fail_closed_unknown_profile"
    ) {
      return undefined;
    }
    return {
      version: PERMISSION_SETTINGS_VERSION,
      sourceVersion: Math.max(1, Math.floor(normalizedSourceVersion)),
      migratedAt: Math.max(0, Math.floor(normalizedMigratedAt)),
      previous: this.snapshotSettings(migration.previous as PermissionSettingsInput),
      defaultProvenance: provenance,
    };
  }

  private static buildLegacyDefaultProfile(
    mode: PermissionMode,
    shellEnabled: boolean,
    permissionAccess: "default" | "full",
    existingProfiles: readonly AccessProfileDefinition[],
  ): {
    id: AccessProfileId;
    profile?: AccessProfileDefinition;
    provenance: PermissionSettingsMigration["defaultProvenance"];
  } {
    // `dont_ask` was a legacy prompt mode layered over the normal bounded
    // profile. Only an explicit Full setting or bypass_permissions represents
    // an unsandboxed authority; treating dont_ask as Full would widen roots
    // and network access during migration.
    const full = permissionAccess === "full" || mode === "bypass_permissions";
    if (full && shellEnabled) {
      return {
        id: BUILTIN_ACCESS_PROFILE_IDS.fullAccess,
        provenance: "legacy_full_access",
      };
    }
    const boundedNoPrompt = !full && mode === "dont_ask";
    if (!full && !boundedNoPrompt && shellEnabled && mode !== "plan") {
      return {
        id: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
        provenance: "legacy_mode",
      };
    }

    const baseId = full
      ? "legacy_default_full_access"
      : mode === "plan"
        ? "legacy_default_plan"
        : mode === "dont_ask"
          ? "legacy_default_dont_ask"
          : "legacy_default_workspace";
    const shellSuffix = shellEnabled ? "_shell" : "_shell_disabled";
    const used = new Set(existingProfiles.map((profile) => profile.id));
    let id = `${baseId}${shellSuffix}`;
    let suffix = 2;
    while (
      used.has(id) ||
      Object.values(BUILTIN_ACCESS_PROFILE_IDS).some((builtinProfileId) => builtinProfileId === id)
    ) {
      id = `${baseId}${shellSuffix}_${suffix}`;
      suffix += 1;
    }
    const profile: AccessProfileDefinition = full
      ? {
          id,
          label: "Migrated full access",
          description: "Compatibility profile migrated from the previous full-access setting.",
          sandbox: "danger-full-access",
          approval: "never",
          reviewer: "none",
          network: "enabled",
          shellAccess: shellEnabled,
        }
      : mode === "plan"
        ? {
            id,
            label: "Migrated read-only access",
            description: "Compatibility profile migrated from the previous plan mode.",
            sandbox: "read-only",
            approval: "on-request",
            reviewer: "user",
            network: "disabled",
            shellAccess: false,
          }
        : mode === "dont_ask"
          ? {
              id,
              label: "Migrated bounded no-prompt access",
              description:
                "Compatibility profile migrated from the previous dont_ask mode while retaining the workspace sandbox.",
              sandbox: "workspace-write",
              approval: "never",
              reviewer: "none",
              network: "on-request",
              shellAccess: shellEnabled,
            }
          : {
              id,
              label: "Migrated workspace access",
              description:
                "Compatibility profile migrated from the previous workspace permission mode.",
              sandbox: "workspace-write",
              approval: "on-request",
              reviewer: "user",
              network: "on-request",
              shellAccess: shellEnabled,
            };
    return {
      id,
      profile,
      provenance: full ? "legacy_full_access" : "legacy_mode",
    };
  }
}
