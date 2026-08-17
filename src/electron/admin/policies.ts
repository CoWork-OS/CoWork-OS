/**
 * Admin Policy System
 *
 * Controls plugin pack availability and enforcement at the organization level.
 * Policies are stored in a JSON file and can be managed via IPC or manual editing.
 *
 * Policy capabilities:
 * - Allow/block specific plugin packs by ID
 * - Mark packs as required (auto-activated, cannot be disabled)
 * - Set organization-level connector restrictions
 * - Control heartbeat frequency limits
 */

import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "../utils/user-data-dir";
import {
  EVERYDAY_AGENT_CAPABILITY_BUNDLES,
  type EverydayCapabilityBundle,
  type PermissionMode,
} from "../../shared/types";
import {
  DEFAULT_AGENT_SECURITY_POLICY,
  type AgentSecurityFailurePolicy,
  type AgentSecurityMode,
  type AgentSecurityPolicy,
  type AgentSecurityRuleProfile,
} from "../../shared/agent-security";

export type AdminSandboxType = "macos" | "docker" | "none";
export type AdminNetworkDefault = "allow" | "deny";

/**
 * Admin policy configuration schema
 */
export interface AdminPolicies {
  /** Policy format version */
  version: 1 | 2;

  /** Timestamp of last policy update */
  updatedAt: string;

  /** Plugin pack policies */
  packs: {
    /** Explicitly allowed pack IDs (empty = allow all) */
    allowed: string[];
    /** Explicitly blocked pack IDs (takes precedence over allowed) */
    blocked: string[];
    /** Required pack IDs (auto-activated, users cannot disable) */
    required: string[];
  };

  /** Connector policies */
  connectors: {
    /** Blocked connector IDs */
    blocked: string[];
  };

  /** Agent policies */
  agents: {
    /** Maximum heartbeat frequency in seconds (minimum 60) */
    maxHeartbeatFrequencySec: number;
    /** Maximum concurrent agents per workspace */
    maxConcurrentAgents: number;
  };

  /** Everyday Agent policy gates */
  everydayAgent: {
    /** Block the Everyday Agent product surface and background work entirely. */
    blocked: boolean;
    /** Specific capability bundle IDs blocked by policy. */
    blockedBundles: EverydayCapabilityBundle[];
    /** Force all Everyday Agent actions into explicit review mode. */
    forceReviewOnly: boolean;
    /** Maximum heartbeat cadence in minutes. Profile values are clamped to this. */
    maxHeartbeatCadenceMinutes: number;
    /** Maximum concurrent Everyday Agent background jobs. */
    maxConcurrentBackgroundWork: number;
    /** Optional active-hours ceiling. Empty windows means no org override. */
    activeHours: {
      enabled: boolean;
      timezone?: string;
      windows: Array<{
        days: number[];
        start: string;
        end: string;
      }>;
    };
  };

  /** Runtime safety requirements */
  runtime: {
    /** Permission modes users/tasks may select. Empty = all modes allowed. */
    allowedPermissionModes: PermissionMode[];
    /** Sandbox backends permitted for shell/code execution. */
    allowedSandboxTypes: AdminSandboxType[];
    /** Require OS-level sandboxing for shell commands. */
    requireSandboxForShell: boolean;
    /** Whether explicit env-gated unsandboxed shell fallback is allowed. */
    allowUnsandboxedShell: boolean;
    /** Network policy applied before legacy guardrail domain checks. */
    network: {
      defaultAction: AdminNetworkDefault;
      allowedDomains: string[];
      blockedDomains: string[];
      /** Coarse shell egress switch. Shell network cannot yet be domain-scoped. */
      allowShellNetwork: boolean;
    };
    /** Narrow automatic review of low-risk permission prompts. */
    autoReview: {
      enabled: boolean;
    };
    /** Optional task-event telemetry export. */
    telemetry: {
      enabled: boolean;
      otlpEndpoint?: string;
    };
    /** Local agent activity detection and optional pre-action enforcement. */
    agentSecurity: AgentSecurityPolicy;
  };

  /** General policies */
  general: {
    /** Whether users can install custom plugin packs */
    allowCustomPacks: boolean;
    /** Whether users can install packs from git repos */
    allowGitInstall: boolean;
    /** Whether users can install packs from URLs */
    allowUrlInstall: boolean;
    /** Organization name (shown in UI) */
    orgName?: string;
    /** Path to organization plugin packs directory */
    orgPluginDir?: string;
  };
}

/** Default policies (permissive) */
const DEFAULT_POLICIES: AdminPolicies = {
  version: 2,
  updatedAt: new Date().toISOString(),
  packs: {
    allowed: [],
    blocked: [],
    required: [],
  },
  connectors: {
    blocked: [],
  },
  agents: {
    maxHeartbeatFrequencySec: 60,
    maxConcurrentAgents: 10,
  },
  everydayAgent: {
    blocked: false,
    blockedBundles: [],
    forceReviewOnly: false,
    maxHeartbeatCadenceMinutes: 60,
    maxConcurrentBackgroundWork: 1,
    activeHours: {
      enabled: false,
      windows: [],
    },
  },
  runtime: {
    allowedPermissionModes: [],
    allowedSandboxTypes: ["macos", "docker"],
    requireSandboxForShell: false,
    allowUnsandboxedShell: false,
    network: {
      defaultAction: "allow",
      allowedDomains: [],
      blockedDomains: [],
      allowShellNetwork: false,
    },
    autoReview: {
      enabled: true,
    },
    telemetry: {
      enabled: false,
    },
    agentSecurity: { ...DEFAULT_AGENT_SECURITY_POLICY },
  },
  general: {
    allowCustomPacks: true,
    allowGitInstall: true,
    allowUrlInstall: true,
  },
};

let lastValidPolicies: AdminPolicies | null = null;
const policyChangeSubscribers = new Set<() => void>();

/**
 * Get the path to the admin policies file
 */
function getPoliciesPath(): string {
  const userDataPath = getUserDataDir();
  return path.join(userDataPath, "policies.json");
}

export function getPoliciesFileVersion(): string {
  try {
    const stat = fs.statSync(getPoliciesPath());
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function clonePolicies(policies: AdminPolicies): AdminPolicies {
  return JSON.parse(JSON.stringify(policies)) as AdminPolicies;
}

function normalizePolicies(parsed: any): AdminPolicies {
  return {
    version: 2,
    updatedAt: parsed.updatedAt || new Date().toISOString(),
    packs: {
      allowed: Array.isArray(parsed.packs?.allowed) ? parsed.packs.allowed : [],
      blocked: Array.isArray(parsed.packs?.blocked) ? parsed.packs.blocked : [],
      required: Array.isArray(parsed.packs?.required) ? parsed.packs.required : [],
    },
    connectors: {
      blocked: Array.isArray(parsed.connectors?.blocked) ? parsed.connectors.blocked : [],
    },
    agents: {
      maxHeartbeatFrequencySec: Math.max(60, parsed.agents?.maxHeartbeatFrequencySec || 60),
      maxConcurrentAgents: Math.max(1, parsed.agents?.maxConcurrentAgents || 10),
    },
    everydayAgent: {
      blocked: parsed.everydayAgent?.blocked === true,
      blockedBundles: normalizeEverydayBundles(parsed.everydayAgent?.blockedBundles),
      forceReviewOnly: parsed.everydayAgent?.forceReviewOnly === true,
      maxHeartbeatCadenceMinutes: Math.max(
        5,
        Number(parsed.everydayAgent?.maxHeartbeatCadenceMinutes) ||
          DEFAULT_POLICIES.everydayAgent.maxHeartbeatCadenceMinutes,
      ),
      maxConcurrentBackgroundWork: Math.max(
        1,
        Number(parsed.everydayAgent?.maxConcurrentBackgroundWork) ||
          DEFAULT_POLICIES.everydayAgent.maxConcurrentBackgroundWork,
      ),
      activeHours: {
        enabled: parsed.everydayAgent?.activeHours?.enabled === true,
        timezone:
          typeof parsed.everydayAgent?.activeHours?.timezone === "string"
            ? parsed.everydayAgent.activeHours.timezone
            : undefined,
        windows: normalizeActiveHourWindows(parsed.everydayAgent?.activeHours?.windows),
      },
    },
    runtime: {
      allowedPermissionModes: normalizePermissionModes(parsed.runtime?.allowedPermissionModes),
      allowedSandboxTypes: normalizeSandboxTypes(parsed.runtime?.allowedSandboxTypes),
      requireSandboxForShell:
        typeof parsed.runtime?.requireSandboxForShell === "boolean"
          ? parsed.runtime.requireSandboxForShell
          : DEFAULT_POLICIES.runtime.requireSandboxForShell,
      allowUnsandboxedShell:
        typeof parsed.runtime?.allowUnsandboxedShell === "boolean"
          ? parsed.runtime.allowUnsandboxedShell
          : DEFAULT_POLICIES.runtime.allowUnsandboxedShell,
      network: {
        defaultAction: parsed.runtime?.network?.defaultAction === "deny" ? "deny" : "allow",
        allowedDomains: normalizeStringList(parsed.runtime?.network?.allowedDomains),
        blockedDomains: normalizeStringList(parsed.runtime?.network?.blockedDomains),
        allowShellNetwork: parsed.runtime?.network?.allowShellNetwork === true,
      },
      autoReview: {
        enabled: parsed.runtime?.autoReview?.enabled !== false,
      },
      telemetry: {
        enabled: parsed.runtime?.telemetry?.enabled === true,
        otlpEndpoint:
          typeof parsed.runtime?.telemetry?.otlpEndpoint === "string"
            ? parsed.runtime.telemetry.otlpEndpoint
            : undefined,
      },
      agentSecurity: normalizeAgentSecurityPolicy(parsed.runtime?.agentSecurity),
    },
    general: {
      allowCustomPacks: parsed.general?.allowCustomPacks !== false,
      allowGitInstall: parsed.general?.allowGitInstall !== false,
      allowUrlInstall: parsed.general?.allowUrlInstall !== false,
      orgName: parsed.general?.orgName,
      orgPluginDir: parsed.general?.orgPluginDir,
    },
  };
}

/**
 * Watch policies.json for manual edits and invoke a debounced callback.
 */
export function watchPolicies(onChange: () => void, debounceMs = 250): () => void {
  const policiesPath = getPoliciesPath();
  const policiesDir = path.dirname(policiesPath);
  const policiesFile = path.basename(policiesPath);
  if (!fs.existsSync(policiesDir)) {
    fs.mkdirSync(policiesDir, { recursive: true });
  }

  let timer: NodeJS.Timeout | null = null;
  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
    timer.unref?.();
  };

  let watcher: fs.FSWatcher | null = null;
  policyChangeSubscribers.add(onChange);
  try {
    watcher = fs.watch(policiesDir, (_event, filename) => {
      if (!filename || filename.toString() === policiesFile) {
        schedule();
      }
    });
    watcher.on("error", (error) => {
      console.warn("[AdminPolicies] Policy watcher failed:", error);
      schedule();
    });
  } catch (error) {
    console.warn("[AdminPolicies] Failed to watch policies file:", error);
  }

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    watcher?.close();
    policyChangeSubscribers.delete(onChange);
  };
}

/**
 * Get the organization plugin packs directory from policies
 */
export function getOrgPluginDir(policies?: AdminPolicies): string | null {
  const p = policies || loadPolicies();
  if (p.general.orgPluginDir && fs.existsSync(p.general.orgPluginDir)) {
    return p.general.orgPluginDir;
  }
  const userDataPath = getUserDataDir();
  const defaultOrgDir = path.join(userDataPath, "org-plugins");
  if (fs.existsSync(defaultOrgDir)) {
    return defaultOrgDir;
  }
  return null;
}

/**
 * Load admin policies from disk without falling back to permissive defaults for an invalid file.
 * Missing file is still treated as first-run default policy.
 */
export function loadPoliciesStrict(): AdminPolicies | null {
  const policiesPath = getPoliciesPath();

  if (!fs.existsSync(policiesPath)) {
    const defaults = clonePolicies(DEFAULT_POLICIES);
    lastValidPolicies = defaults;
    return clonePolicies(defaults);
  }

  try {
    const raw = fs.readFileSync(policiesPath, "utf-8");
    const parsed = JSON.parse(raw);
    const rawValidationError = validatePolicies(parsed);
    if (rawValidationError) {
      throw new Error(rawValidationError);
    }
    const normalized = normalizePolicies(parsed);
    const validationError = validatePolicies(normalized);
    if (validationError) {
      throw new Error(validationError);
    }
    lastValidPolicies = normalized;
    return clonePolicies(normalized);
  } catch (error) {
    console.error("[AdminPolicies] Failed to load policies:", error);
    return lastValidPolicies ? clonePolicies(lastValidPolicies) : null;
  }
}

/**
 * Load admin policies from disk.
 */
export function loadPolicies(): AdminPolicies {
  return loadPoliciesStrict() || clonePolicies(DEFAULT_POLICIES);
}

/**
 * Save admin policies to disk
 */
export function savePolicies(policies: AdminPolicies): void {
  const policiesPath = getPoliciesPath();

  // Ensure directory exists
  const dir = path.dirname(policiesPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  policies.updatedAt = new Date().toISOString();
  fs.writeFileSync(policiesPath, JSON.stringify(policies, null, 2), "utf-8");
  lastValidPolicies = clonePolicies(policies);
  for (const subscriber of [...policyChangeSubscribers]) {
    try {
      subscriber();
    } catch (error) {
      console.warn("[AdminPolicies] Policy change subscriber failed:", error);
    }
  }
}

/**
 * Check whether a plugin pack is allowed by policy
 */
export function isPackAllowed(packId: string, policies?: AdminPolicies): boolean {
  const p = policies || loadPolicies();

  // Blocked list always takes precedence
  if (p.packs.blocked.includes(packId)) {
    return false;
  }

  // If allowed list is non-empty, only those packs are permitted
  if (p.packs.allowed.length > 0) {
    return p.packs.allowed.includes(packId);
  }

  // No restrictions
  return true;
}

/**
 * Check whether a plugin pack is required (cannot be disabled)
 */
export function isPackRequired(packId: string, policies?: AdminPolicies): boolean {
  const p = policies || loadPolicies();
  return p.packs.required.includes(packId);
}

/**
 * Check whether a connector is blocked by policy
 */
export function isConnectorBlocked(connectorId: string, policies?: AdminPolicies): boolean {
  const p = policies || loadPolicies();
  return p.connectors.blocked.includes(connectorId);
}

export function getEverydayAgentPolicy(policies?: AdminPolicies): AdminPolicies["everydayAgent"] {
  return (policies || loadPolicies()).everydayAgent;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

const VALID_EVERYDAY_BUNDLES = new Set<EverydayCapabilityBundle>(
  EVERYDAY_AGENT_CAPABILITY_BUNDLES.map((bundle) => bundle.id),
);

function normalizeEverydayBundles(value: unknown): EverydayCapabilityBundle[] {
  return normalizeStringList(value).filter((bundle): bundle is EverydayCapabilityBundle =>
    VALID_EVERYDAY_BUNDLES.has(bundle as EverydayCapabilityBundle),
  );
}

function normalizeActiveHourWindows(
  value: unknown,
): AdminPolicies["everydayAgent"]["activeHours"]["windows"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((window) => {
      if (!window || typeof window !== "object") return null;
      const record = window as Record<string, unknown>;
      const days = Array.isArray(record.days)
        ? record.days
            .map((day) => Number(day))
            .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        : [];
      const start = typeof record.start === "string" ? record.start : "";
      const end = typeof record.end === "string" ? record.end : "";
      if (!days.length || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
        return null;
      }
      return { days, start, end };
    })
    .filter(Boolean) as AdminPolicies["everydayAgent"]["activeHours"]["windows"];
}

const VALID_PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "plan",
  "dangerous_only",
  "accept_edits",
  "dont_ask",
  "bypass_permissions",
]);

function normalizePermissionModes(value: unknown): PermissionMode[] {
  return normalizeStringList(value).filter((mode): mode is PermissionMode =>
    VALID_PERMISSION_MODES.has(mode as PermissionMode),
  );
}

const VALID_SANDBOX_TYPES = new Set<AdminSandboxType>(["macos", "docker", "none"]);

function normalizeSandboxTypes(value: unknown): AdminSandboxType[] {
  const normalized = normalizeStringList(value).filter((mode): mode is AdminSandboxType =>
    VALID_SANDBOX_TYPES.has(mode as AdminSandboxType),
  );
  return normalized.length > 0 ? normalized : [...DEFAULT_POLICIES.runtime.allowedSandboxTypes];
}

const VALID_AGENT_SECURITY_MODES = new Set<AgentSecurityMode>(["monitor", "enforce"]);
const VALID_AGENT_SECURITY_FAILURE_POLICIES = new Set<AgentSecurityFailurePolicy>([
  "open",
  "deny_high_risk",
]);
const VALID_AGENT_SECURITY_RULE_PROFILES = new Set<AgentSecurityRuleProfile>([
  "builtin",
  "recommended",
  "custom",
]);

function normalizeAgentSecurityPolicy(value: unknown): AgentSecurityPolicy {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const scheduled =
    input.scheduledScan &&
    typeof input.scheduledScan === "object" &&
    !Array.isArray(input.scheduledScan)
      ? (input.scheduledScan as Record<string, unknown>)
      : {};
  const mode = VALID_AGENT_SECURITY_MODES.has(input.mode as AgentSecurityMode)
    ? (input.mode as AgentSecurityMode)
    : DEFAULT_AGENT_SECURITY_POLICY.mode;
  const failurePolicy = VALID_AGENT_SECURITY_FAILURE_POLICIES.has(
    input.failurePolicy as AgentSecurityFailurePolicy,
  )
    ? (input.failurePolicy as AgentSecurityFailurePolicy)
    : DEFAULT_AGENT_SECURITY_POLICY.failurePolicy;
  const ruleProfile = VALID_AGENT_SECURITY_RULE_PROFILES.has(
    input.ruleProfile as AgentSecurityRuleProfile,
  )
    ? (input.ruleProfile as AgentSecurityRuleProfile)
    : DEFAULT_AGENT_SECURITY_POLICY.ruleProfile;

  return {
    enabled: input.enabled === true,
    mode,
    ruleProfile,
    customRuleDirs: normalizeStringList(input.customRuleDirs),
    failurePolicy,
    timeoutMs: Math.min(
      5_000,
      Math.max(250, Number(input.timeoutMs) || DEFAULT_AGENT_SECURITY_POLICY.timeoutMs),
    ),
    retentionDays: Math.min(
      365,
      Math.max(1, Number(input.retentionDays) || DEFAULT_AGENT_SECURITY_POLICY.retentionDays),
    ),
    scheduledScan: {
      enabled: scheduled.enabled === true,
      intervalHours: Math.min(
        168,
        Math.max(
          1,
          Number(scheduled.intervalHours) ||
            DEFAULT_AGENT_SECURITY_POLICY.scheduledScan.intervalHours,
        ),
      ),
    },
    externalHooks: {
      management: "manual",
    },
  };
}

/**
 * Validate that a policy change is well-formed
 */
export function validatePolicies(policies: unknown): string | null {
  if (!policies || typeof policies !== "object") {
    return "Policies must be an object";
  }

  const p = policies as Record<string, unknown>;

  if (p.packs && typeof p.packs === "object") {
    const packs = p.packs as Record<string, unknown>;
    const allowed = Array.isArray(packs.allowed) ? packs.allowed : null;
    const blocked = Array.isArray(packs.blocked) ? packs.blocked : null;
    const required = Array.isArray(packs.required) ? packs.required : null;

    if (packs.allowed && !Array.isArray(packs.allowed)) {
      return "packs.allowed must be an array";
    }
    if (packs.blocked && !Array.isArray(packs.blocked)) {
      return "packs.blocked must be an array";
    }
    if (packs.required && !Array.isArray(packs.required)) {
      return "packs.required must be an array";
    }

    if (required && blocked && required.some((id) => blocked.includes(id))) {
      return "A pack ID cannot be both required and blocked";
    }

    if (required && allowed && allowed.length > 0 && required.some((id) => !allowed.includes(id))) {
      return "All required packs must also be in allowed list when allowlist is set";
    }
  }

  if (p.agents && typeof p.agents === "object") {
    const agents = p.agents as Record<string, unknown>;
    if (
      agents.maxHeartbeatFrequencySec !== undefined &&
      (typeof agents.maxHeartbeatFrequencySec !== "number" || agents.maxHeartbeatFrequencySec < 60)
    ) {
      return "agents.maxHeartbeatFrequencySec must be a number >= 60";
    }
    if (
      agents.maxConcurrentAgents !== undefined &&
      (typeof agents.maxConcurrentAgents !== "number" || agents.maxConcurrentAgents < 1)
    ) {
      return "agents.maxConcurrentAgents must be a number >= 1";
    }
  }

  if (p.everydayAgent && typeof p.everydayAgent === "object") {
    const everyday = p.everydayAgent as Record<string, unknown>;
    if (everyday.blocked !== undefined && typeof everyday.blocked !== "boolean") {
      return "everydayAgent.blocked must be a boolean";
    }
    if (
      everyday.blockedBundles !== undefined &&
      (!Array.isArray(everyday.blockedBundles) ||
        everyday.blockedBundles.some(
          (bundle) => !VALID_EVERYDAY_BUNDLES.has(bundle as EverydayCapabilityBundle),
        ))
    ) {
      return "everydayAgent.blockedBundles contains an invalid bundle";
    }
    if (everyday.forceReviewOnly !== undefined && typeof everyday.forceReviewOnly !== "boolean") {
      return "everydayAgent.forceReviewOnly must be a boolean";
    }
    if (
      everyday.maxHeartbeatCadenceMinutes !== undefined &&
      (typeof everyday.maxHeartbeatCadenceMinutes !== "number" ||
        everyday.maxHeartbeatCadenceMinutes < 5)
    ) {
      return "everydayAgent.maxHeartbeatCadenceMinutes must be a number >= 5";
    }
    if (
      everyday.maxConcurrentBackgroundWork !== undefined &&
      (typeof everyday.maxConcurrentBackgroundWork !== "number" ||
        everyday.maxConcurrentBackgroundWork < 1)
    ) {
      return "everydayAgent.maxConcurrentBackgroundWork must be a number >= 1";
    }
    const activeHours = everyday.activeHours as Record<string, unknown> | undefined;
    if (activeHours) {
      if (activeHours.enabled !== undefined && typeof activeHours.enabled !== "boolean") {
        return "everydayAgent.activeHours.enabled must be a boolean";
      }
      if (activeHours.timezone !== undefined && typeof activeHours.timezone !== "string") {
        return "everydayAgent.activeHours.timezone must be a string";
      }
      if (activeHours.windows !== undefined && !Array.isArray(activeHours.windows)) {
        return "everydayAgent.activeHours.windows must be an array";
      }
    }
  }

  if (p.runtime && typeof p.runtime === "object") {
    const runtime = p.runtime as Record<string, unknown>;
    const allowedPermissionModes = runtime.allowedPermissionModes;
    if (
      allowedPermissionModes !== undefined &&
      (!Array.isArray(allowedPermissionModes) ||
        allowedPermissionModes.some((mode) => !VALID_PERMISSION_MODES.has(mode as PermissionMode)))
    ) {
      return "runtime.allowedPermissionModes contains an invalid permission mode";
    }
    const allowedSandboxTypes = runtime.allowedSandboxTypes;
    if (
      allowedSandboxTypes !== undefined &&
      (!Array.isArray(allowedSandboxTypes) ||
        allowedSandboxTypes.some((mode) => !VALID_SANDBOX_TYPES.has(mode as AdminSandboxType)))
    ) {
      return "runtime.allowedSandboxTypes contains an invalid sandbox type";
    }
    if (
      runtime.requireSandboxForShell !== undefined &&
      typeof runtime.requireSandboxForShell !== "boolean"
    ) {
      return "runtime.requireSandboxForShell must be a boolean";
    }
    if (
      runtime.allowUnsandboxedShell !== undefined &&
      typeof runtime.allowUnsandboxedShell !== "boolean"
    ) {
      return "runtime.allowUnsandboxedShell must be a boolean";
    }
    const network = runtime.network as Record<string, unknown> | undefined;
    if (network) {
      if (
        network.defaultAction !== undefined &&
        network.defaultAction !== "allow" &&
        network.defaultAction !== "deny"
      ) {
        return "runtime.network.defaultAction must be allow or deny";
      }
      if (network.allowedDomains !== undefined && !Array.isArray(network.allowedDomains)) {
        return "runtime.network.allowedDomains must be an array";
      }
      if (network.blockedDomains !== undefined && !Array.isArray(network.blockedDomains)) {
        return "runtime.network.blockedDomains must be an array";
      }
      if (
        network.allowShellNetwork !== undefined &&
        typeof network.allowShellNetwork !== "boolean"
      ) {
        return "runtime.network.allowShellNetwork must be a boolean";
      }
    }
    const telemetry = runtime.telemetry as Record<string, unknown> | undefined;
    if (telemetry) {
      if (telemetry.enabled !== undefined && typeof telemetry.enabled !== "boolean") {
        return "runtime.telemetry.enabled must be a boolean";
      }
      if (telemetry.otlpEndpoint !== undefined && typeof telemetry.otlpEndpoint !== "string") {
        return "runtime.telemetry.otlpEndpoint must be a string";
      }
    }
    const agentSecurity = runtime.agentSecurity as Record<string, unknown> | undefined;
    if (agentSecurity) {
      if (agentSecurity.enabled !== undefined && typeof agentSecurity.enabled !== "boolean") {
        return "runtime.agentSecurity.enabled must be a boolean";
      }
      if (
        agentSecurity.mode !== undefined &&
        !VALID_AGENT_SECURITY_MODES.has(agentSecurity.mode as AgentSecurityMode)
      ) {
        return "runtime.agentSecurity.mode must be monitor or enforce";
      }
      if (
        agentSecurity.ruleProfile !== undefined &&
        !VALID_AGENT_SECURITY_RULE_PROFILES.has(
          agentSecurity.ruleProfile as AgentSecurityRuleProfile,
        )
      ) {
        return "runtime.agentSecurity.ruleProfile contains an invalid profile";
      }
      if (
        agentSecurity.customRuleDirs !== undefined &&
        (!Array.isArray(agentSecurity.customRuleDirs) ||
          agentSecurity.customRuleDirs.some((item) => typeof item !== "string"))
      ) {
        return "runtime.agentSecurity.customRuleDirs must be an array of strings";
      }
      if (
        agentSecurity.failurePolicy !== undefined &&
        !VALID_AGENT_SECURITY_FAILURE_POLICIES.has(
          agentSecurity.failurePolicy as AgentSecurityFailurePolicy,
        )
      ) {
        return "runtime.agentSecurity.failurePolicy contains an invalid policy";
      }
      if (
        agentSecurity.timeoutMs !== undefined &&
        (typeof agentSecurity.timeoutMs !== "number" ||
          agentSecurity.timeoutMs < 250 ||
          agentSecurity.timeoutMs > 5_000)
      ) {
        return "runtime.agentSecurity.timeoutMs must be between 250 and 5000";
      }
      if (
        agentSecurity.retentionDays !== undefined &&
        (typeof agentSecurity.retentionDays !== "number" ||
          agentSecurity.retentionDays < 1 ||
          agentSecurity.retentionDays > 365)
      ) {
        return "runtime.agentSecurity.retentionDays must be between 1 and 365";
      }
      const scheduledScan = agentSecurity.scheduledScan as Record<string, unknown> | undefined;
      if (scheduledScan) {
        if (scheduledScan.enabled !== undefined && typeof scheduledScan.enabled !== "boolean") {
          return "runtime.agentSecurity.scheduledScan.enabled must be a boolean";
        }
        if (
          scheduledScan.intervalHours !== undefined &&
          (typeof scheduledScan.intervalHours !== "number" ||
            scheduledScan.intervalHours < 1 ||
            scheduledScan.intervalHours > 168)
        ) {
          return "runtime.agentSecurity.scheduledScan.intervalHours must be between 1 and 168";
        }
      }
    }
  }

  return null;
}
