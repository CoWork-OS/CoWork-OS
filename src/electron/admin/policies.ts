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

/**
 * Admin policy configuration schema
 */
export interface AdminPolicies {
  /** Policy format version */
  version: 1;

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
  version: 1,
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
  general: {
    allowCustomPacks: true,
    allowGitInstall: true,
    allowUrlInstall: true,
  },
};

/**
 * Get the path to the admin policies file
 */
function getPoliciesPath(): string {
  const userDataPath = getUserDataDir();
  return path.join(userDataPath, "policies.json");
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
 * Load admin policies from disk
 */
export function loadPolicies(): AdminPolicies {
  const policiesPath = getPoliciesPath();

  if (!fs.existsSync(policiesPath)) {
    return { ...DEFAULT_POLICIES };
  }

  try {
    const raw = fs.readFileSync(policiesPath, "utf-8");
    const parsed = JSON.parse(raw);

    // Merge with defaults to ensure all fields exist
    return {
      version: parsed.version || 1,
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
      general: {
        allowCustomPacks: parsed.general?.allowCustomPacks !== false,
        allowGitInstall: parsed.general?.allowGitInstall !== false,
        allowUrlInstall: parsed.general?.allowUrlInstall !== false,
        orgName: parsed.general?.orgName,
        orgPluginDir: parsed.general?.orgPluginDir,
      },
    };
  } catch (error) {
    console.error("[AdminPolicies] Failed to load policies:", error);
    return { ...DEFAULT_POLICIES };
  }
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

  return null;
}
