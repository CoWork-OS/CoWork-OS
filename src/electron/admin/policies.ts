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
import { type PermissionMode } from "../../shared/types";
import {
  DEFAULT_AGENT_SECURITY_POLICY,
  type AgentSecurityFailurePolicy,
  type AgentSecurityMode,
  type AgentSecurityPolicy,
  type AgentSecurityRuleProfile,
} from "../../shared/agent-security";

export type AdminSandboxType = "macos" | "docker" | "none";
export type AdminNetworkDefault = "allow" | "deny";
/** "user" leaves Settings > Browser > Developer mode to the user; "on"/"off" lock it. */
export type AdminBrowserDeveloperMode = "user" | "on" | "off";

/** Site permission keys the in-app browser can be told to deny without asking. */
export const ADMIN_BROWSER_SITE_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "notifications",
  "clipboard-read",
  "midi",
  "midiSysex",
  "hid",
  "serial",
  "usb",
  "pointerLock",
  "keyboardLock",
  "openExternal",
  "fileSystem",
  "display-capture",
] as const;

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

  /** PACT business-agent protocol (docs/pact.md) */
  pact: {
    /** Whether the outbound PACT adapter may be used at all. */
    enabled: boolean;
    /** Whether eligible business interactions may be routed to PACT automatically. */
    autoRoute: boolean;
    /** Provider origins (or host patterns) CoWork must never contact over PACT. */
    blockedProviders: string[];
  };

  /** In-app browser (Browser Workbench) */
  browser?: {
    /** Lock Settings > Browser > Developer mode (full DevTools access for CoWork). */
    developerMode: AdminBrowserDeveloperMode;
    /** Site permissions denied in the in-app browser without a prompt (see ADMIN_BROWSER_SITE_PERMISSIONS). */
    blockedSitePermissions: string[];
  };

  /** Agent policies */
  agents: {
    /** Maximum heartbeat frequency in seconds (minimum 60) */
    maxHeartbeatFrequencySec: number;
    /** Maximum concurrent agents per workspace */
    maxConcurrentAgents: number;
  };

  /** Runtime safety requirements */
  runtime: {
    /** Permission modes users/tasks may select. Empty = all modes allowed. */
    allowedPermissionModes: PermissionMode[];
    /** Sandbox backends permitted for shell/code execution. */
    allowedSandboxTypes: AdminSandboxType[];
    /** Require OS-level sandboxing for shell commands. */
    requireSandboxForShell: boolean;
    /**
     * Whether a shell command may run without an OS sandbox: per command with the user's
     * explicit approval when no sandbox exists (and requireSandboxForShell is off), or via
     * the env-gated development fallback.
     */
    allowUnsandboxedShell: boolean;
    /** Network policy applied before legacy guardrail domain checks. */
    network: {
      defaultAction: AdminNetworkDefault;
      allowedDomains: string[];
      blockedDomains: string[];
      /**
       * Internal hosts an administrator has deliberately re-opened.
       *
       * Private/link-local/CGNAT addresses and `*.internal` names are denied
       * before any allow rule, because an agent-supplied URL must not be able
       * to reach cloud metadata or the LAN. That boundary breaks legitimate
       * self-hosted deployments (a LAN SearXNG or Ollama box, an intranet
       * webhook target), so this list is the only way back in. It is matched
       * with `domainMatches`, is never populated by the agent or the renderer,
       * and `*` is rejected — entries must name specific hosts.
       */
      allowedInternalHosts: string[];
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
  pact: {
    enabled: true,
    autoRoute: true,
    blockedProviders: [],
  },
  browser: {
    developerMode: "user",
    blockedSitePermissions: [],
  },
  agents: {
    maxHeartbeatFrequencySec: 60,
    maxConcurrentAgents: 10,
  },
  runtime: {
    allowedPermissionModes: [],
    allowedSandboxTypes: ["macos", "docker"],
    requireSandboxForShell: false,
    // On by default so Windows and Linux-without-Docker users can run shell commands at all:
    // with no OS sandbox, each command then needs the user's explicit approval, which can
    // never be auto-approved. It has no effect while requireSandboxForShell is on.
    allowUnsandboxedShell: true,
    network: {
      defaultAction: "allow",
      allowedDomains: [],
      blockedDomains: [],
      allowedInternalHosts: [],
      // On by default so coding tasks can install dependencies and use git remotes from the
      // shell. Shell egress still needs a network-enabled profile with no domain rules, an
      // unrestricted network policy (default allow, no allow/block lists), and approval in
      // on-request network mode; administrators can turn it off here.
      allowShellNetwork: true,
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
    pact: {
      enabled: parsed.pact?.enabled !== false,
      autoRoute: parsed.pact?.autoRoute !== false,
      blockedProviders: normalizeStringList(parsed.pact?.blockedProviders),
    },
    browser: {
      developerMode:
        parsed.browser?.developerMode === "on" || parsed.browser?.developerMode === "off"
          ? parsed.browser.developerMode
          : "user",
      blockedSitePermissions: normalizeStringList(parsed.browser?.blockedSitePermissions).filter(
        (key) => (ADMIN_BROWSER_SITE_PERMISSIONS as readonly string[]).includes(key),
      ),
    },
    agents: {
      maxHeartbeatFrequencySec: Math.max(60, parsed.agents?.maxHeartbeatFrequencySec || 60),
      maxConcurrentAgents: Math.max(1, parsed.agents?.maxConcurrentAgents || 10),
    },
    runtime: {
      allowedPermissionModes: normalizePermissionModes(parsed.runtime?.allowedPermissionModes),
      allowedSandboxTypes: normalizeSandboxTypes(parsed.runtime?.allowedSandboxTypes),
      requireSandboxForShell:
        typeof parsed.runtime?.requireSandboxForShell === "boolean"
          ? parsed.runtime.requireSandboxForShell
          : DEFAULT_POLICIES.runtime.requireSandboxForShell,
      // A policy that requires a sandbox but predates this field keeps it off, so the
      // permissive default cannot open the environment-gated unsandboxed fallback there.
      allowUnsandboxedShell:
        typeof parsed.runtime?.allowUnsandboxedShell === "boolean"
          ? parsed.runtime.allowUnsandboxedShell
          : parsed.runtime?.requireSandboxForShell === true
            ? false
            : DEFAULT_POLICIES.runtime.allowUnsandboxedShell,
      network: {
        defaultAction: parsed.runtime?.network?.defaultAction === "deny" ? "deny" : "allow",
        allowedDomains: normalizeStringList(parsed.runtime?.network?.allowedDomains),
        blockedDomains: normalizeStringList(parsed.runtime?.network?.blockedDomains),
        // `*` and `**.` wildcards would re-open the whole internal boundary
        // (including 169.254.169.254) with one character, so they are dropped.
        allowedInternalHosts: normalizeStringList(
          parsed.runtime?.network?.allowedInternalHosts,
        ).filter((pattern) => pattern !== "*" && !pattern.startsWith("**.")),
        allowShellNetwork:
          typeof parsed.runtime?.network?.allowShellNetwork === "boolean"
            ? parsed.runtime.network.allowShellNetwork
            : DEFAULT_POLICIES.runtime.network.allowShellNetwork,
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
 * Check whether a connector is blocked by policy. IDs are typed by administrators, so the
 * match ignores surrounding whitespace and letter case.
 */
export function isConnectorBlocked(connectorId: string, policies?: AdminPolicies): boolean {
  const normalize = (id: unknown) =>
    String(id ?? "")
      .trim()
      .toLowerCase();
  const target = normalize(connectorId);
  if (!target) return false;
  const p = policies || loadPolicies();
  return p.connectors.blocked.some((blocked) => normalize(blocked) === target);
}

export function getBrowserPolicy(policies?: AdminPolicies): NonNullable<AdminPolicies["browser"]> {
  return (policies || loadPolicies()).browser ?? DEFAULT_POLICIES.browser!;
}

export function getPactPolicy(policies?: AdminPolicies): AdminPolicies["pact"] {
  return (policies || loadPolicies()).pact ?? DEFAULT_POLICIES.pact;
}

/**
 * Whether a PACT provider is blocked. Entries are origins (`https://provider.example`) or host
 * patterns (`provider.example`, `*.provider.example`), matched case-insensitively.
 */
export function isPactProviderBlocked(providerOrigin: string, policies?: AdminPolicies): boolean {
  let host: string;
  let origin: string;
  try {
    const url = new URL(providerOrigin);
    host = url.hostname.toLowerCase();
    origin = url.origin.toLowerCase();
  } catch {
    return true;
  }
  return getPactPolicy(policies).blockedProviders.some((entry) => {
    const pattern = entry.trim().toLowerCase().replace(/\/+$/, "");
    if (!pattern) return false;
    if (pattern.includes("://")) return pattern === origin;
    if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
    return host === pattern;
  });
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
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

  if (p.connectors !== undefined) {
    // A non-array would hide an unblock from the relaxation check and then load as [].
    const blocked =
      p.connectors && typeof p.connectors === "object"
        ? (p.connectors as Record<string, unknown>).blocked
        : null;
    if (
      blocked !== undefined &&
      (!Array.isArray(blocked) || blocked.some((id) => typeof id !== "string"))
    ) {
      return "connectors.blocked must be an array of strings";
    }
  }

  if (p.pact !== undefined) {
    if (!p.pact || typeof p.pact !== "object") return "pact must be an object";
    const pact = p.pact as Record<string, unknown>;
    for (const key of ["enabled", "autoRoute"] as const) {
      if (pact[key] !== undefined && typeof pact[key] !== "boolean") {
        return `pact.${key} must be a boolean`;
      }
    }
    if (
      pact.blockedProviders !== undefined &&
      (!Array.isArray(pact.blockedProviders) ||
        pact.blockedProviders.some((entry) => typeof entry !== "string"))
    ) {
      return "pact.blockedProviders must be an array of strings";
    }
  }

  if (p.browser !== undefined) {
    if (!p.browser || typeof p.browser !== "object") return "browser must be an object";
    const browser = p.browser as Record<string, unknown>;
    if (
      browser.developerMode !== undefined &&
      !["user", "on", "off"].includes(browser.developerMode as string)
    ) {
      return 'browser.developerMode must be "user", "on" or "off"';
    }
    if (
      browser.blockedSitePermissions !== undefined &&
      (!Array.isArray(browser.blockedSitePermissions) ||
        browser.blockedSitePermissions.some(
          (entry) =>
            typeof entry !== "string" ||
            !(ADMIN_BROWSER_SITE_PERMISSIONS as readonly string[]).includes(entry),
        ))
    ) {
      return `browser.blockedSitePermissions may only contain: ${ADMIN_BROWSER_SITE_PERMISSIONS.join(", ")}`;
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
        network.allowedInternalHosts !== undefined &&
        !Array.isArray(network.allowedInternalHosts)
      ) {
        return "runtime.network.allowedInternalHosts must be an array";
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
