import { createHash } from "node:crypto";
import type { MCPTool } from "../types";

/** Provider tool names are capped at 64 characters, including the "mcp_" prefix. */
const MAX_EXPOSED_NAME = 59;
const SEPARATOR = "__";

export interface ServerToolCatalog {
  serverId: string;
  serverName: string;
  tools: MCPTool[];
}

export interface ExposedTool {
  serverId: string;
  /** Name offered to the agent; equals the server's name unless it collides. */
  exposedName: string;
  /** Name the server knows the tool by. */
  serverToolName: string;
  tool: MCPTool;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

/** Truncates to the provider limit, keeping the name unique with a stable hash suffix. */
function fit(name: string, serverId: string, toolName: string): string {
  if (name.length <= MAX_EXPOSED_NAME) return name;
  const suffix = `_${shortHash(`${serverId}:${toolName}`)}`;
  return name.slice(0, MAX_EXPOSED_NAME - suffix.length) + suffix;
}

/**
 * Gives every connected tool a unique name. A name offered by one server keeps
 * its plain name, so existing references keep working. A name offered by
 * several servers is namespaced on all of them ("<server>__<tool>"), so routing
 * never depends on which server connected first.
 */
export function assignExposedToolNames(catalogs: ServerToolCatalog[]): {
  tools: ExposedTool[];
  /** Plain names that more than one server offers; they are not callable unqualified. */
  ambiguous: Map<string, string[]>;
} {
  const providers = new Map<string, Set<string>>();
  for (const catalog of catalogs)
    for (const tool of catalog.tools) {
      if (!providers.has(tool.name)) providers.set(tool.name, new Set());
      providers.get(tool.name)!.add(catalog.serverId);
    }

  // Server prefixes must differ even when two servers share a display name.
  const slugCounts = new Map<string, number>();
  for (const catalog of catalogs) {
    const base = slug(catalog.serverName) || "server";
    slugCounts.set(base, (slugCounts.get(base) ?? 0) + 1);
  }
  const prefixFor = (catalog: ServerToolCatalog) => {
    const base = slug(catalog.serverName) || "server";
    return (slugCounts.get(base) ?? 0) > 1 ? `${base}_${shortHash(catalog.serverId)}` : base;
  };

  const tools: ExposedTool[] = [];
  const ambiguous = new Map<string, string[]>();
  const taken = new Set<string>();
  for (const catalog of catalogs) {
    const prefix = prefixFor(catalog);
    for (const tool of catalog.tools) {
      // A server listing the same name twice offers it once.
      if (
        tools.some(
          (entry) => entry.serverId === catalog.serverId && entry.serverToolName === tool.name,
        )
      )
        continue;
      const shared = (providers.get(tool.name)?.size ?? 0) > 1;
      let exposedName = shared
        ? fit(`${prefix}${SEPARATOR}${tool.name}`, catalog.serverId, tool.name)
        : tool.name;
      // A namespaced name can still match another server's plain tool name.
      const candidate = exposedName;
      for (let attempt = 1; taken.has(exposedName); attempt++)
        exposedName = fit(`${candidate}_${attempt}`, catalog.serverId, `${tool.name}#${attempt}`);
      taken.add(exposedName);
      if (shared) {
        const names = ambiguous.get(tool.name) ?? [];
        names.push(exposedName);
        ambiguous.set(tool.name, names);
      }
      tools.push({
        serverId: catalog.serverId,
        exposedName,
        serverToolName: tool.name,
        tool: {
          ...tool,
          name: exposedName,
          ...(exposedName !== tool.name ? { serverToolName: tool.name } : {}),
          inputSchema: tool.inputSchema ? { ...tool.inputSchema } : tool.inputSchema,
        },
      });
    }
  }
  return { tools, ambiguous };
}
