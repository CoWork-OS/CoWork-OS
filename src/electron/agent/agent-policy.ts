import * as fs from "fs";
import * as path from "path";

import type { TaskDomain } from "../../shared/types";
import type { LoopGuardrailConfig } from "./completion-checks";
import type { StepContractMode } from "./step-contract";

export type AgentPolicyHookName = "on_pre_tool_use" | "on_stop_attempt" | "on_recovery_plan";
export type AgentPolicyHookAction = "allow" | "block_with_feedback" | "force_action";

export interface AgentPolicyHookRule {
  whenTool?: string;
  whenMode?: StepContractMode;
  whenDomain?: TaskDomain;
  whenContains?: string;
  action: AgentPolicyHookAction;
  feedback?: string;
  forceTool?: string;
  forceInputTemplate?: Record<string, unknown>;
}

export interface AgentPolicyHookDecision {
  action: AgentPolicyHookAction;
  feedback?: string;
  forceTool?: string;
  forceInputTemplate?: Record<string, unknown>;
}

type LoopThresholdOverrides = Partial<LoopGuardrailConfig>;

export interface AgentPolicyConfig {
  requiredToolFamilies: Partial<Record<StepContractMode, string[]>>;
  disallowedFallbackTexts: string[];
  toolAllowlist: string[] | null;
  toolDenylist: string[];
  loopThresholds: {
    default: LoopThresholdOverrides;
    byMode: Partial<Record<StepContractMode, LoopThresholdOverrides>>;
    byDomain: Partial<Record<TaskDomain, LoopThresholdOverrides>>;
  };
  hooks: Partial<Record<AgentPolicyHookName, AgentPolicyHookRule[]>>;
}

export interface AgentPolicyLoadResult {
  filePath: string;
  policy: AgentPolicyConfig | null;
  parseError?: string;
}

const POLICY_FILE_NAME = "agent-policy.toml";

const DEFAULT_POLICY: AgentPolicyConfig = {
  requiredToolFamilies: {},
  disallowedFallbackTexts: [],
  toolAllowlist: null,
  toolDenylist: [],
  loopThresholds: {
    default: {},
    byMode: {},
    byDomain: {},
  },
  hooks: {},
};

const MODE_KEYS = new Set<StepContractMode>([
  "analysis_only",
  "artifact_presence_required",
  "mutation_required",
]);

const DOMAIN_KEYS = new Set<TaskDomain>([
  "auto",
  "code",
  "operations",
  "research",
  "writing",
  "general",
]);

const LOOP_THRESHOLD_KEYS: Array<keyof LoopGuardrailConfig> = [
  "stopReasonToolUseStreak",
  "stopReasonMaxTokenStreak",
  "lowProgressWindowSize",
  "lowProgressSameTargetMinCalls",
  "followUpLockMinStreak",
  "followUpLockMinToolCalls",
  "skippedToolOnlyTurnThreshold",
];

const LOOP_THRESHOLD_ALIAS_MAP: Record<string, keyof LoopGuardrailConfig> = {
  stop_reason_tool_use_streak: "stopReasonToolUseStreak",
  stop_reason_max_token_streak: "stopReasonMaxTokenStreak",
  low_progress_window_size: "lowProgressWindowSize",
  low_progress_same_target_min_calls: "lowProgressSameTargetMinCalls",
  follow_up_lock_min_streak: "followUpLockMinStreak",
  follow_up_lock_min_tool_calls: "followUpLockMinToolCalls",
  skipped_tool_only_turn_threshold: "skippedToolOnlyTurnThreshold",
};

const policyCache = new Map<string, { mtimeMs: number; result: AgentPolicyLoadResult }>();

function normalizeToolName(name: string): string {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function parseTomlScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";

  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    const elements: string[] = [];
    let current = "";
    let inQuote = false;
    let quoteChar = "";
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if ((ch === '"' || ch === "'") && (!inQuote || quoteChar === ch)) {
        if (inQuote && quoteChar === ch) {
          inQuote = false;
          quoteChar = "";
        } else if (!inQuote) {
          inQuote = true;
          quoteChar = ch;
        }
        current += ch;
        continue;
      }
      if (ch === "," && !inQuote) {
        elements.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) elements.push(current.trim());
    return elements
      .map((token) => parseTomlScalar(token))
      .filter((token): token is string => typeof token === "string")
      .map((token) => token.trim())
      .filter(Boolean);
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (/^(true|false)$/i.test(value)) {
    return value.toLowerCase() === "true";
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }
  return value;
}

function stripInlineComment(line: string): string {
  let inQuote = false;
  let quoteChar = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && (!inQuote || quoteChar === ch)) {
      if (inQuote && quoteChar === ch) {
        inQuote = false;
        quoteChar = "";
      } else if (!inQuote) {
        inQuote = true;
        quoteChar = ch;
      }
      continue;
    }
    if (ch === "#" && !inQuote) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function maybeParseForceInputTemplate(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function parseAgentPolicyToml(rawToml: string): AgentPolicyConfig {
  const parsed: AgentPolicyConfig = {
    ...DEFAULT_POLICY,
    requiredToolFamilies: {},
    disallowedFallbackTexts: [],
    toolAllowlist: null,
    toolDenylist: [],
    loopThresholds: {
      default: {},
      byMode: {},
      byDomain: {},
    },
    hooks: {},
  };

  const lines = String(rawToml || "").split(/\r?\n/);
  let section = "";
  let activeHook: AgentPolicyHookRule | null = null;

  for (const originalLine of lines) {
    const line = stripInlineComment(originalLine).trim();
    if (!line) continue;

    if (line.startsWith("[[") && line.endsWith("]]")) {
      section = line.slice(2, -2).trim();
      activeHook = null;
      if (section.startsWith("hooks.")) {
        const hookName = section.slice("hooks.".length).trim() as AgentPolicyHookName;
        if (
          hookName === "on_pre_tool_use" ||
          hookName === "on_stop_attempt" ||
          hookName === "on_recovery_plan"
        ) {
          const rules = parsed.hooks[hookName] || [];
          activeHook = { action: "allow" };
          rules.push(activeHook);
          parsed.hooks[hookName] = rules;
        }
      }
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim();
      activeHook = null;
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    const value = parseTomlScalar(line.slice(equalsIndex + 1));

    if (section === "required_tool_families") {
      if (MODE_KEYS.has(key as StepContractMode)) {
        parsed.requiredToolFamilies[key as StepContractMode] = toStringArray(value).map((tool) =>
          normalizeToolName(tool),
        );
      }
      continue;
    }

    if (section === "tool_filters") {
      if (key === "allow") {
        const allow = toStringArray(value).map((tool) => normalizeToolName(tool));
        parsed.toolAllowlist = allow.length > 0 ? allow : null;
      } else if (key === "deny") {
        parsed.toolDenylist = toStringArray(value).map((tool) => normalizeToolName(tool));
      }
      continue;
    }

    if (section === "fallback") {
      if (key === "disallowed_texts") {
        parsed.disallowedFallbackTexts = toStringArray(value);
      }
      continue;
    }

    if (section.startsWith("loop_thresholds")) {
      const canonicalKey = LOOP_THRESHOLD_ALIAS_MAP[key] || (key as keyof LoopGuardrailConfig);
      if (!LOOP_THRESHOLD_KEYS.includes(canonicalKey)) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 1) continue;
      const numericValue = Math.floor(value);

      if (section === "loop_thresholds.default") {
        parsed.loopThresholds.default[canonicalKey] = numericValue;
        continue;
      }

      if (section.startsWith("loop_thresholds.mode.")) {
        const modeKey = section.slice("loop_thresholds.mode.".length).trim() as StepContractMode;
        if (MODE_KEYS.has(modeKey)) {
          const modeOverrides = parsed.loopThresholds.byMode[modeKey] || {};
          modeOverrides[canonicalKey] = numericValue;
          parsed.loopThresholds.byMode[modeKey] = modeOverrides;
        }
        continue;
      }

      if (section.startsWith("loop_thresholds.domain.")) {
        const domainKey = section.slice("loop_thresholds.domain.".length).trim() as TaskDomain;
        if (DOMAIN_KEYS.has(domainKey)) {
          const domainOverrides = parsed.loopThresholds.byDomain[domainKey] || {};
          domainOverrides[canonicalKey] = numericValue;
          parsed.loopThresholds.byDomain[domainKey] = domainOverrides;
        }
        continue;
      }

      if (section.startsWith("loop_thresholds.")) {
        const suffix = section.slice("loop_thresholds.".length).trim();
        if (MODE_KEYS.has(suffix as StepContractMode)) {
          const modeKey = suffix as StepContractMode;
          const modeOverrides = parsed.loopThresholds.byMode[modeKey] || {};
          modeOverrides[canonicalKey] = numericValue;
          parsed.loopThresholds.byMode[modeKey] = modeOverrides;
          continue;
        }
        if (DOMAIN_KEYS.has(suffix as TaskDomain)) {
          const domainKey = suffix as TaskDomain;
          const domainOverrides = parsed.loopThresholds.byDomain[domainKey] || {};
          domainOverrides[canonicalKey] = numericValue;
          parsed.loopThresholds.byDomain[domainKey] = domainOverrides;
          continue;
        }
      }
      continue;
    }

    if (section.startsWith("hooks.") && activeHook) {
      switch (key) {
        case "when_tool":
          activeHook.whenTool = normalizeToolName(String(value || ""));
          break;
        case "when_mode":
          if (MODE_KEYS.has(String(value || "") as StepContractMode)) {
            activeHook.whenMode = String(value || "") as StepContractMode;
          }
          break;
        case "when_domain":
          if (DOMAIN_KEYS.has(String(value || "") as TaskDomain)) {
            activeHook.whenDomain = String(value || "") as TaskDomain;
          }
          break;
        case "when_contains":
          activeHook.whenContains = String(value || "");
          break;
        case "action":
          if (value === "allow" || value === "block_with_feedback" || value === "force_action") {
            activeHook.action = value;
          }
          break;
        case "feedback":
          activeHook.feedback = String(value || "");
          break;
        case "force_tool":
          activeHook.forceTool = normalizeToolName(String(value || ""));
          break;
        case "force_input_template":
        case "force_input_template_json":
          activeHook.forceInputTemplate = maybeParseForceInputTemplate(value);
          break;
      }
    }
  }

  parsed.toolDenylist = Array.from(new Set(parsed.toolDenylist));
  if (Array.isArray(parsed.toolAllowlist)) {
    parsed.toolAllowlist = Array.from(new Set(parsed.toolAllowlist));
  }
  parsed.disallowedFallbackTexts = Array.from(new Set(parsed.disallowedFallbackTexts));
  return parsed;
}

export function loadAgentPolicyFromWorkspace(
  workspacePath: string,
  readGuard?: (candidatePath: string) => boolean,
): AgentPolicyLoadResult {
  const filePath = path.join(String(workspacePath || ""), POLICY_FILE_NAME);
  if (readGuard && !readGuard(filePath)) {
    return { filePath, policy: null, parseError: "access_denied" };
  }
  try {
    const stat = fs.statSync(filePath);
    const cached = policyCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.result;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const policy = parseAgentPolicyToml(raw);
    const result: AgentPolicyLoadResult = { filePath, policy };
    policyCache.set(filePath, { mtimeMs: stat.mtimeMs, result });
    return result;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { filePath, policy: null };
    }
    const parseError = (error as Error)?.message || "failed_to_load_agent_policy";
    return { filePath, policy: null, parseError };
  }
}

export function getPolicyRequiredToolsForMode(
  policy: AgentPolicyConfig | null | undefined,
  mode: StepContractMode,
): string[] {
  if (!policy) return [];
  const raw = policy.requiredToolFamilies[mode] || [];
  const normalized = raw.map((entry) => normalizeToolName(entry)).filter(Boolean);
  return Array.from(new Set(normalized));
}

export function filterToolsByAgentPolicy<T extends { name: string }>(opts: {
  tools: T[];
  policy: AgentPolicyConfig | null | undefined;
}): { tools: T[]; blocked: Array<{ name: string; reason: string }> } {
  if (!opts.policy) {
    return { tools: opts.tools, blocked: [] };
  }

  const allowlist = opts.policy.toolAllowlist;
  const denylist = new Set(opts.policy.toolDenylist.map((name) => normalizeToolName(name)));
  const blocked: Array<{ name: string; reason: string }> = [];
  const filtered = opts.tools.filter((tool) => {
    const toolName = normalizeToolName(tool.name);
    if (denylist.has(toolName)) {
      blocked.push({ name: tool.name, reason: "agent_policy_denylist" });
      return false;
    }
    if (allowlist && allowlist.length > 0 && !allowlist.includes(toolName)) {
      blocked.push({ name: tool.name, reason: "agent_policy_allowlist" });
      return false;
    }
    return true;
  });

  return { tools: filtered, blocked };
}

function mergeLoopThresholdOverride(
  base: LoopGuardrailConfig,
  override: LoopThresholdOverrides | undefined,
): LoopGuardrailConfig {
  if (!override) return base;
  const merged: LoopGuardrailConfig = { ...base };
  for (const key of LOOP_THRESHOLD_KEYS) {
    const value = override[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      merged[key] = Math.floor(value);
    }
  }
  return merged;
}

export function applyAgentPolicyLoopThresholds(opts: {
  base: LoopGuardrailConfig;
  policy: AgentPolicyConfig | null | undefined;
  mode?: StepContractMode;
  domain?: TaskDomain;
}): LoopGuardrailConfig {
  const policy = opts.policy;
  if (!policy) return opts.base;

  let merged = mergeLoopThresholdOverride(opts.base, policy.loopThresholds.default);
  if (opts.mode) {
    merged = mergeLoopThresholdOverride(merged, policy.loopThresholds.byMode[opts.mode]);
  }
  if (opts.domain) {
    merged = mergeLoopThresholdOverride(merged, policy.loopThresholds.byDomain[opts.domain]);
  }
  return merged;
}

export function sanitizeFallbackTextWithPolicy(opts: {
  text: string;
  policy: AgentPolicyConfig | null | undefined;
}): { text: string; sanitized: boolean } {
  const policy = opts.policy;
  if (!policy || policy.disallowedFallbackTexts.length === 0) {
    return { text: opts.text, sanitized: false };
  }

  let sanitizedText = String(opts.text || "");
  let sanitized = false;
  for (const disallowedPhrase of policy.disallowedFallbackTexts) {
    const phrase = String(disallowedPhrase || "").trim();
    if (!phrase) continue;
    const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    if (regex.test(sanitizedText)) {
      sanitized = true;
      sanitizedText = sanitizedText.replace(
        regex,
        "stop repetitive probing and perform the required contract action",
      );
    }
  }

  return { text: sanitizedText, sanitized };
}

export function evaluateAgentPolicyHook(opts: {
  policy: AgentPolicyConfig | null | undefined;
  hook: AgentPolicyHookName;
  toolName?: string;
  mode?: StepContractMode;
  domain?: TaskDomain;
  reasonText?: string;
}): AgentPolicyHookDecision | null {
  const policy = opts.policy;
  if (!policy) return null;
  const rules = policy.hooks[opts.hook] || [];
  if (!Array.isArray(rules) || rules.length === 0) return null;

  const toolName = normalizeToolName(opts.toolName || "");
  const reasonText = String(opts.reasonText || "").toLowerCase();

  for (const rule of rules) {
    if (rule.whenTool && normalizeToolName(rule.whenTool) !== toolName) continue;
    if (rule.whenMode && rule.whenMode !== opts.mode) continue;
    if (rule.whenDomain && rule.whenDomain !== opts.domain) continue;
    if (rule.whenContains && !reasonText.includes(String(rule.whenContains).toLowerCase()))
      continue;

    if (rule.action === "allow") {
      return { action: "allow", feedback: rule.feedback };
    }
    if (rule.action === "block_with_feedback") {
      return {
        action: "block_with_feedback",
        feedback:
          rule.feedback ||
          `Blocked by agent-policy hook "${opts.hook}" for tool "${opts.toolName || "unknown"}".`,
      };
    }
    if (rule.action === "force_action") {
      return {
        action: "force_action",
        feedback: rule.feedback,
        forceTool: normalizeToolName(rule.forceTool || ""),
        forceInputTemplate: rule.forceInputTemplate || {},
      };
    }
  }

  return null;
}
