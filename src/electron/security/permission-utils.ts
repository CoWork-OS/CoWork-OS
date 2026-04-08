import * as path from "path";
import type { PermissionRule, PermissionRuleScope } from "../../shared/types";

export function normalizePermissionPath(input: string): string {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  return path.resolve(trimmed);
}

export function normalizeCommandPrefix(input: string): string {
  return String(input || "").replace(/\s+/g, " ").trim();
}

export function normalizeServerName(input: string): string {
  return String(input || "").trim().toLowerCase();
}

export function normalizePermissionScope(scope: PermissionRuleScope): PermissionRuleScope {
  switch (scope.kind) {
    case "domain":
      return {
        kind: "domain",
        domain: String(scope.domain || "").trim().toLowerCase(),
        ...(scope.toolName ? { toolName: String(scope.toolName || "").trim() } : {}),
      };
    case "path":
      return {
        kind: "path",
        path: normalizePermissionPath(scope.path),
        ...(scope.toolName ? { toolName: scope.toolName } : {}),
      };
    case "command_prefix":
      return {
        kind: "command_prefix",
        prefix: normalizeCommandPrefix(scope.prefix),
      };
    case "mcp_server":
      return {
        kind: "mcp_server",
        serverName: normalizeServerName(scope.serverName),
      };
    case "tool":
    default:
      return {
        kind: "tool",
        toolName: String(scope.toolName || "").trim(),
      };
  }
}

export function permissionScopeFingerprint(scope: PermissionRuleScope): string {
  const normalized = normalizePermissionScope(scope);
  switch (normalized.kind) {
    case "domain":
      return `domain:${normalized.toolName || "*"}:${normalized.domain}`;
    case "path":
      return `path:${normalized.toolName || "*"}:${normalized.path}`;
    case "command_prefix":
      return `command_prefix:${normalized.prefix}`;
    case "mcp_server":
      return `mcp_server:${normalized.serverName}`;
    case "tool":
    default:
      return `tool:${normalized.toolName}`;
  }
}

export function permissionRuleFingerprint(rule: Pick<PermissionRule, "effect" | "scope">): string {
  return `${rule.effect}:${permissionScopeFingerprint(rule.scope)}`;
}

export function summarizePermissionScope(scope: PermissionRuleScope): string {
  const normalized = normalizePermissionScope(scope);
  switch (normalized.kind) {
    case "domain":
      return normalized.toolName
        ? `${normalized.toolName} on domain ${normalized.domain}`
        : `domain ${normalized.domain}`;
    case "path":
      return normalized.toolName
        ? `${normalized.toolName} on path ${normalized.path}`
        : `path ${normalized.path}`;
    case "command_prefix":
      return `commands starting with "${normalized.prefix}"`;
    case "mcp_server":
      return `MCP server ${normalized.serverName}`;
    case "tool":
    default:
      return `tool ${normalized.toolName}`;
  }
}

export function getPermissionScopeSpecificity(scope: PermissionRuleScope): number {
  const normalized = normalizePermissionScope(scope);
  switch (normalized.kind) {
    case "domain":
      return 4500 + normalized.domain.length + (normalized.toolName ? 1000 : 0);
    case "path":
      return 4000 + normalized.path.length + (normalized.toolName ? 1000 : 0);
    case "command_prefix":
      return 3000 + normalized.prefix.length;
    case "mcp_server":
      return 2000 + normalized.serverName.length;
    case "tool":
    default:
      return 1000 + normalized.toolName.length;
  }
}
