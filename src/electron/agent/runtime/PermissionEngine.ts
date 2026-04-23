import path from "node:path";
import type {
  ApprovalType,
  PermissionDecisionReason,
  PermissionEffect,
  PermissionEvaluationResult,
  PermissionMode,
  PermissionPromptActionOption,
  PermissionRule,
  PermissionRuleScope,
  Workspace,
} from "../../../shared/types";
import { isComputerUseToolName } from "../../../shared/computer-use-contract";
import { GuardrailManager } from "../../guardrails/guardrail-manager";
import {
  getPermissionScopeSpecificity,
  normalizeCommandPrefix,
  normalizePermissionPath,
  normalizePermissionScope,
  normalizeServerName,
  summarizePermissionScope,
} from "../../security/permission-utils";
import {
  canonicalizeToolName,
  isArtifactGenerationToolName,
  isFileMutationToolName,
} from "../tool-semantics";
import { extractDomainFromUrl, extractUrlFromToolInput } from "../security/export-permission-context";

const SOURCE_PRECEDENCE: Record<string, number> = {
  session: 600,
  workspace_db: 500,
  workspace_manifest: 400,
  profile: 300,
  legacy_guardrails: 200,
  legacy_builtin_settings: 100,
};

const EFFECT_PRECEDENCE: Record<PermissionEffect, number> = {
  deny: 30,
  ask: 20,
  allow: 10,
};

export interface PermissionEngineRequest {
  workspace: Workspace;
  toolName: string;
  toolInput?: unknown;
  mode: PermissionMode;
  rules: PermissionRule[];
  approvalType?: ApprovalType;
  command?: string | null;
  path?: string | null;
  serverName?: string | null;
  allowPersistence?: boolean;
  denyState?: {
    consecutiveDenials: number;
    totalDenials: number;
  };
}

type PermissionFacts = {
  toolName: string;
  normalizedPath: string;
  normalizedCommand: string;
  normalizedServerName: string;
  normalizedDomain: string;
  isReadOnly: boolean;
  isWriteLike: boolean;
  isWorkspaceWriteLike: boolean;
  isDeleteLike: boolean;
  isShell: boolean;
  isDataExport: boolean;
  isExternalSideEffect: boolean;
  isNetworkAccess: boolean;
  isNonWorkspaceInteraction: boolean;
  isMcp: boolean;
};

const NETWORK_READ_TOOLS = new Set(["web_search", "web_fetch"]);
const READ_ONLY_BROWSER_TOOLS = new Set([
  "browser_get_content",
  "browser_get_text",
  "browser_screenshot",
  "browser_wait",
]);
const READ_ONLY_CANVAS_TOOLS = new Set(["canvas_list", "canvas_snapshot", "canvas_checkpoints"]);
const NON_WORKSPACE_SYSTEM_TOOLS = new Set([
  "read_clipboard",
  "write_clipboard",
  "take_screenshot",
  "open_application",
  "open_url",
  "open_path",
  "show_in_folder",
  "get_env",
  "get_app_paths",
  "run_applescript",
]);
const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b.*(?:^|\s)-f/i,
  /\bgit\s+checkout\s+--\b/i,
  /\bmkfs(?:\.[a-z0-9_+-]+)?\b/i,
  /\bdd\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bdiskutil\s+erase/i,
  /\bformat\b/i,
  /\bdel\b.*(?:^|\s)\/f\b/i,
];
const SAFE_DANGEROUS_ONLY_COMMAND_PREFIXES = [
  "pwd",
  "ls",
  "tree",
  "dir",
  "cat ",
  "head ",
  "tail ",
  "sed -n",
  "grep ",
  "rg ",
  "find ",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "npm test",
  "npm run test",
  "npm run lint",
  "npm run type-check",
  "pnpm test",
  "pnpm run test",
  "pnpm run lint",
  "pnpm run type-check",
  "yarn test",
  "yarn lint",
  "yarn type-check",
  "bun test",
  "pytest",
  "cargo test",
  "go test",
  "vitest ",
  "jest ",
  "eslint ",
  "oxlint ",
  "prettier --check",
  "tsc --noemit",
  "tsc --noemit ",
  "node -v",
  "python --version",
  "python3 --version",
].map((prefix) => prefix.toLowerCase());

export class PermissionEngine {
  static evaluate(request: PermissionEngineRequest): PermissionEvaluationResult {
    const facts = this.buildFacts(request);
    const hardDecision = this.evaluateHardPolicies(request, facts);
    if (hardDecision) {
      return {
        ...hardDecision,
        suggestions: this.buildSuggestions(request.allowPersistence !== false, facts),
        scopePreview: this.buildScopePreview(request, facts),
      };
    }

    const matchedRule = this.findBestRule(request.rules, facts);
    if (matchedRule) {
      return {
        decision: matchedRule.effect,
        reason: {
          type: "rule",
          rule: matchedRule,
          summary: `${matchedRule.effect} via ${matchedRule.source} rule`,
          metadata: {
            scope: summarizePermissionScope(matchedRule.scope),
          },
        },
        matchedRule,
        suggestions: this.buildSuggestions(request.allowPersistence !== false, facts),
        scopePreview: this.buildScopePreview(request, facts),
      };
    }

    const modeDecision = this.evaluateModeDefaults(request.mode, facts);
    const shouldFallback =
      modeDecision.decision === "deny" &&
      request.denyState &&
      (request.denyState.consecutiveDenials >= 3 || request.denyState.totalDenials >= 20);

    if (shouldFallback) {
      return {
        decision: "ask",
        reason: {
          type: "denial_fallback",
          summary: "Repeated denials switched this request back to an explicit prompt.",
          metadata: {
            ...request.denyState,
            originalDecision: modeDecision.decision,
            originalReason: modeDecision.reason.summary,
          },
        },
        suggestions: this.buildSuggestions(request.allowPersistence !== false, facts),
        scopePreview: this.buildScopePreview(request, facts),
      };
    }

    return {
      decision: modeDecision.decision,
      reason: modeDecision.reason,
      suggestions: this.buildSuggestions(request.allowPersistence !== false, facts),
      scopePreview: this.buildScopePreview(request, facts),
    };
  }

  private static evaluateHardPolicies(
    request: PermissionEngineRequest,
    facts: PermissionFacts,
  ): { decision: PermissionEffect; reason: PermissionDecisionReason } | null {
    const permissions = request.workspace.permissions || {};

    if (facts.isShell) {
      const blocked = GuardrailManager.isCommandBlocked(facts.normalizedCommand);
      if (blocked.blocked) {
        return {
          decision: "deny",
          reason: {
            type: "guardrail",
            summary: `Command blocked by guardrail pattern "${blocked.pattern}"`,
            metadata: { pattern: blocked.pattern, command: facts.normalizedCommand },
          },
        };
      }
      if (permissions.shell !== true) {
        return {
          decision: "deny",
          reason: {
            type: "workspace_capability",
            capability: "shell",
            summary: "Workspace shell capability is disabled.",
          },
        };
      }
    }

    if (facts.isDeleteLike && permissions.delete !== true) {
      return {
        decision: "deny",
        reason: {
          type: "workspace_capability",
          capability: "delete",
          summary: "Workspace delete capability is disabled.",
        },
      };
    }

    if (facts.isReadOnly && permissions.read === false) {
      return {
        decision: "deny",
        reason: {
          type: "workspace_capability",
          capability: "read",
          summary: "Workspace read capability is disabled.",
        },
      };
    }

    if (facts.isWorkspaceWriteLike && permissions.write === false) {
      return {
        decision: "deny",
        reason: {
          type: "workspace_capability",
          capability: "write",
          summary: "Workspace write capability is disabled.",
        },
      };
    }

    if ((facts.isExternalSideEffect || facts.isNetworkAccess || facts.isMcp) && permissions.network === false) {
      return {
        decision: "deny",
        reason: {
          type: "workspace_capability",
          capability: "network",
          summary: "Workspace network capability is disabled.",
        },
      };
    }

    return null;
  }

  private static evaluateModeDefaults(
    mode: PermissionMode,
    facts: PermissionFacts,
  ): { decision: PermissionEffect; reason: PermissionDecisionReason } {
    switch (mode) {
      case "plan":
        if (facts.isReadOnly && !facts.isExternalSideEffect && !facts.isMcp) {
          return {
            decision: "allow",
            reason: {
              type: "mode",
              mode,
              summary: "Plan mode allows read-only tools.",
            },
          };
        }
        return {
          decision: "deny",
          reason: {
            type: "mode",
            mode,
            summary: "Plan mode blocks mutating and external tools.",
          },
        };
      case "accept_edits":
        if (
          facts.isShell ||
          facts.isDeleteLike ||
          facts.isExternalSideEffect ||
          facts.isNonWorkspaceInteraction ||
          facts.isMcp
        ) {
          return {
            decision: "ask",
            reason: {
              type: "mode",
              mode,
              summary:
                "Accept-edits mode still prompts for shell, delete, browser/system, and external actions.",
            },
          };
        }
        return {
          decision: "allow",
          reason: {
            type: "mode",
            mode,
            summary: "Accept-edits mode allows in-workspace reads and edits.",
          },
        };
      case "dangerous_only":
        if (this.isDangerousOnlyPromptWorthy(facts)) {
          return {
            decision: "ask",
            reason: {
              type: "mode",
              mode,
              summary:
                "Dangerous-only mode prompts only for destructive, high-risk, or ambiguous external actions.",
            },
          };
        }
        return {
          decision: "allow",
          reason: {
            type: "mode",
            mode,
            summary:
              "Dangerous-only mode allows safe reads, edits, and non-destructive commands automatically.",
          },
        };
      case "dont_ask":
      case "bypass_permissions":
        if (facts.isDataExport) {
          return {
            decision: "ask",
            reason: {
              type: "mode",
              mode,
              summary: "Data export always requires an explicit prompt, even in bypass modes.",
            },
          };
        }
        return {
          decision: "allow",
          reason: {
            type: "mode",
            mode,
            summary: "Mode allows the action unless a higher-precedence hard policy blocks it.",
          },
        };
      case "default":
      default:
        if (
          facts.isReadOnly &&
          !facts.isExternalSideEffect &&
          !facts.isNonWorkspaceInteraction &&
          !facts.isMcp
        ) {
          return {
            decision: "allow",
            reason: {
              type: "mode",
              mode: "default",
              summary: "Default mode allows safe read-only actions.",
            },
          };
        }
        return {
          decision: "ask",
          reason: {
            type: "mode",
            mode: "default",
            summary: "Default mode prompts for writes, deletes, shell, and external effects.",
          },
        };
    }
  }

  private static buildFacts(request: PermissionEngineRequest): PermissionFacts {
    const toolName = canonicalizeToolName(String(request.toolName || "").trim());
    const approvalType = request.approvalType;
    const normalizedCommand = normalizeCommandPrefix(request.command || this.extractCommand(request.toolInput));
    const normalizedPath = this.normalizePathAgainstWorkspace(
      request.workspace.path,
      request.path || this.extractPath(request.toolInput),
    );
    const normalizedServerName = normalizeServerName(request.serverName || "");
    const normalizedDomain = extractDomainFromUrl(extractUrlFromToolInput(request.toolInput)) || "";
    const isHttpRequestReadOnly = this.isReadOnlyHttpRequest(request.toolInput, toolName);
    const isShell = approvalType === "run_command" || toolName === "run_command";
    const isDeleteLike =
      approvalType === "delete_file" ||
      approvalType === "delete_multiple" ||
      toolName === "delete_file";
    const isDataExport =
      approvalType === "data_export" ||
      toolName === "analyze_image" ||
      toolName === "read_pdf_visual" ||
      (toolName === "http_request" && !isHttpRequestReadOnly);
    const isExternalSideEffect =
      approvalType === "external_service" ||
      isDataExport ||
      toolName.endsWith("_action") ||
      toolName === "voice_call";
    const isNetworkAccess =
      approvalType === "network_access" ||
      NETWORK_READ_TOOLS.has(toolName) ||
      (toolName === "http_request" && isHttpRequestReadOnly);
    const isNonWorkspaceInteraction = this.isNonWorkspaceInteractionTool(toolName, approvalType);
    const isMcp = toolName.startsWith("mcp_");
    const isWorkspaceWriteLike = this.isWorkspaceWriteTool(toolName);
    const isMutatingTool = this.isMutatingTool(toolName);
    const isWriteLike = isDeleteLike || isShell || isExternalSideEffect || isMutatingTool;
    const isReadOnly = !isWriteLike;

    return {
      toolName,
      normalizedPath,
      normalizedCommand,
      normalizedServerName,
      normalizedDomain,
      isReadOnly,
      isWriteLike,
      isWorkspaceWriteLike,
      isDeleteLike,
      isShell,
      isDataExport,
      isExternalSideEffect,
      isNetworkAccess,
      isNonWorkspaceInteraction,
      isMcp,
    };
  }

  private static isWorkspaceWriteTool(toolName: string): boolean {
    const canonicalToolName = canonicalizeToolName(toolName);
    if (isArtifactGenerationToolName(canonicalToolName) || isFileMutationToolName(canonicalToolName)) {
      return true;
    }
    return canonicalToolName === "take_screenshot";
  }

  private static isMutatingTool(toolName: string): boolean {
    const canonicalToolName = canonicalizeToolName(toolName);
    if (this.isWorkspaceWriteTool(canonicalToolName)) {
      return true;
    }
    if (canonicalToolName.startsWith("browser_")) {
      return !READ_ONLY_BROWSER_TOOLS.has(canonicalToolName);
    }
    if (canonicalToolName.startsWith("canvas_")) {
      return !READ_ONLY_CANVAS_TOOLS.has(canonicalToolName);
    }
    return [
      "open_url",
      "open_application",
      "open_path",
      "show_in_folder",
      "write_clipboard",
      "click",
      "double_click",
      "move_mouse",
      "drag",
      "scroll",
      "type_text",
      "keypress",
      "wait",
    ].includes(canonicalToolName);
  }

  private static isNonWorkspaceInteractionTool(toolName: string, approvalType?: ApprovalType): boolean {
    const canonicalToolName = canonicalizeToolName(toolName);
    if (approvalType === "computer_use") return true;
    if (canonicalToolName.startsWith("browser_")) return true;
    if (canonicalToolName.startsWith("canvas_")) return true;
    if (isComputerUseToolName(canonicalToolName)) return true;
    return NON_WORKSPACE_SYSTEM_TOOLS.has(canonicalToolName);
  }

  private static isReadOnlyHttpRequest(toolInput: unknown, toolName: string): boolean {
    if (canonicalizeToolName(toolName) !== "http_request") {
      return false;
    }
    const method = this.extractHttpMethod(toolInput);
    return method === "GET" || method === "HEAD";
  }

  private static extractHttpMethod(toolInput: unknown): string {
    const obj = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : null;
    const rawMethod = typeof obj?.method === "string" ? obj.method.trim() : "";
    return rawMethod ? rawMethod.toUpperCase() : "GET";
  }

  private static isDangerousOnlySafeCommand(command: string): boolean {
    const normalized = String(command || "").trim();
    if (!normalized) {
      return false;
    }

    const lowered = normalized.toLowerCase();
    if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return false;
    }

    // Composite shell expressions can hide side effects that are hard to classify safely.
    if (
      /&&|\|\||;|`|\$\(|>>?|<<?|\bchmod\b|\bchown\b|\bsudo\b|\btee\b/i.test(normalized)
    ) {
      return false;
    }

    // Keep dangerous_only conservative for shell: allow only an explicit read/test subset.
    if (
      lowered.startsWith("find ") &&
      /-delete|-exec|-ok|-okdir|-execdir|-fprint|-fprintf/i.test(normalized)
    ) {
      return false;
    }

    return SAFE_DANGEROUS_ONLY_COMMAND_PREFIXES.some(
      (prefix) => lowered === prefix || lowered.startsWith(`${prefix} `),
    );
  }

  private static isDangerousOnlyPromptWorthy(facts: PermissionFacts): boolean {
    if (facts.isDeleteLike) {
      return true;
    }
    if (facts.isShell) {
      return !this.isDangerousOnlySafeCommand(facts.normalizedCommand);
    }
    if (facts.toolName === "run_applescript") {
      return true;
    }
    if (facts.isExternalSideEffect || facts.isMcp) {
      return true;
    }
    if (facts.isNonWorkspaceInteraction) {
      return true;
    }
    return false;
  }

  private static extractCommand(toolInput: unknown): string {
    const obj = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : null;
    return typeof obj?.command === "string" ? obj.command : "";
  }

  private static extractPath(toolInput: unknown): string {
    const obj = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : null;
    if (typeof obj?.path === "string") return obj.path;
    if (typeof obj?.filePath === "string") return obj.filePath;
    if (typeof obj?.targetPath === "string") return obj.targetPath;
    return "";
  }

  private static normalizePathAgainstWorkspace(workspacePath: string, rawPath: string): string {
    const trimmed = String(rawPath || "").trim();
    if (!trimmed) return "";
    return normalizePermissionPath(path.isAbsolute(trimmed) ? trimmed : path.join(workspacePath, trimmed));
  }

  private static findBestRule(rules: PermissionRule[], facts: PermissionFacts): PermissionRule | undefined {
    const candidates = rules
      .filter((rule) => this.ruleMatches(rule, facts))
      .map((rule) => ({
        rule: {
          ...rule,
          scope: normalizePermissionScope(rule.scope),
        },
      }))
      .sort((a, b) => {
        const specificityDelta =
          getPermissionScopeSpecificity(b.rule.scope) - getPermissionScopeSpecificity(a.rule.scope);
        if (specificityDelta !== 0) {
          return specificityDelta;
        }

        const sourceDelta =
          (SOURCE_PRECEDENCE[b.rule.source] || 0) - (SOURCE_PRECEDENCE[a.rule.source] || 0);
        if (sourceDelta !== 0) {
          return sourceDelta;
        }

        return (EFFECT_PRECEDENCE[b.rule.effect] || 0) - (EFFECT_PRECEDENCE[a.rule.effect] || 0);
      });
    return candidates[0]?.rule;
  }

  private static ruleMatches(rule: PermissionRule, facts: PermissionFacts): boolean {
    const scope = normalizePermissionScope(rule.scope);
    switch (scope.kind) {
      case "tool":
        return scope.toolName === facts.toolName;
      case "domain":
        if (!facts.normalizedDomain || !scope.domain) return false;
        if (scope.toolName && scope.toolName !== facts.toolName) return false;
        return facts.normalizedDomain === scope.domain;
      case "path":
        if (!facts.normalizedPath || !scope.path) return false;
        if (scope.toolName && scope.toolName !== facts.toolName) return false;
        return (
          facts.normalizedPath === scope.path ||
          facts.normalizedPath.startsWith(`${scope.path}${path.sep}`) ||
          facts.normalizedPath.startsWith(`${scope.path}/`)
        );
      case "command_prefix":
        return !!facts.normalizedCommand && facts.normalizedCommand.startsWith(scope.prefix);
      case "mcp_server":
        return !!facts.normalizedServerName && facts.normalizedServerName === scope.serverName;
      default:
        return false;
    }
  }

  private static buildSuggestions(
    allowPersistence: boolean,
    facts: PermissionFacts,
  ): PermissionPromptActionOption[] {
    const base: PermissionPromptActionOption[] = [
      { action: "deny_once", label: "Deny once", effect: "deny" },
      { action: "allow_once", label: "Allow once", effect: "allow" },
    ];
    if (!allowPersistence) {
      return base;
    }
    const suggestions: PermissionPromptActionOption[] = [
      ...base,
      {
        action: "deny_session",
        label: "Deny for session",
        effect: "deny",
        destination: "session",
      },
      {
        action: "allow_session",
        label: "Allow for session",
        effect: "allow",
        destination: "session",
      },
      {
        action: "deny_workspace",
        label: "Deny for workspace",
        effect: "deny",
        destination: "workspace",
      },
      {
        action: "allow_workspace",
        label: "Allow for workspace",
        effect: "allow",
        destination: "workspace",
      },
    ];
    if (!facts.isDataExport) {
      suggestions.push(
        {
          action: "deny_profile",
          label: "Deny for profile",
          effect: "deny",
          destination: "profile",
        },
        {
          action: "allow_profile",
          label: "Allow for profile",
          effect: "allow",
          destination: "profile",
        },
      );
    }
    return suggestions;
  }

  private static buildScopePreview(
    request: PermissionEngineRequest,
    facts: PermissionFacts,
  ): string {
    const scope = this.inferScope(request, facts);
    return summarizePermissionScope(scope);
  }

  static inferScope(
    request: PermissionEngineRequest,
    facts = this.buildFacts(request),
  ): PermissionRuleScope {
    if (facts.normalizedDomain && (facts.isNetworkAccess || facts.isDataExport)) {
      return {
        kind: "domain",
        domain: facts.normalizedDomain,
        ...(facts.toolName ? { toolName: facts.toolName } : {}),
      };
    }
    if (facts.normalizedPath) {
      return {
        kind: "path",
        path: facts.normalizedPath,
        ...(facts.toolName ? { toolName: facts.toolName } : {}),
      };
    }
    if (facts.isShell && facts.normalizedCommand) {
      return {
        kind: "command_prefix",
        prefix: facts.normalizedCommand,
      };
    }
    if (facts.isMcp && facts.normalizedServerName) {
      return {
        kind: "mcp_server",
        serverName: facts.normalizedServerName,
      };
    }
    return {
      kind: "tool",
      toolName: facts.toolName,
    };
  }
}
