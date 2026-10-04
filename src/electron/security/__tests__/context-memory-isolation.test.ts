import { describe, expect, it } from "vitest";
import {
  CONTEXT_TOOL_RESTRICTIONS,
  RETIRED_MEMORY_TOOL_NAMES,
  TOOL_GROUPS,
  type Workspace,
} from "../../../shared/types";
import { isToolAllowedQuick, SecurityPolicyManager } from "../policy-manager";

const workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/tmp/ws-1",
  createdAt: 0,
  permissions: {
    read: true,
    write: true,
    delete: true,
    network: true,
    shell: true,
  },
} as unknown as Workspace;

// SEC-4: group/public gateway chats must not reach private memory recall or
// the knowledge graph.
const MEMORY_RECALL_TOOLS = [
  // The consolidated memory tools (audit §8.3).
  "memory_recall",
  "memory_remember",
  "memory_forget",
  "context_recall",
  "kg_search",
  "kg_get_neighbors",
  "kg_get_subgraph",
  "kg_create_entity",
  "kg_add_observation",
  "task_history",
];

describe("gateway context memory isolation", () => {
  it("keeps group:memory denied in group and public contexts", () => {
    expect(CONTEXT_TOOL_RESTRICTIONS.group.deniedGroups).toContain("group:memory");
    expect(CONTEXT_TOOL_RESTRICTIONS.public.deniedGroups).toContain("group:memory");
  });

  it.each(MEMORY_RECALL_TOOLS)("lists %s in group:memory", (tool) => {
    expect(SecurityPolicyManager.isToolInGroup(tool, "group:memory")).toBe(true);
  });

  it.each(["group", "public"] as const)("denies memory recall tools in %s context", (ctx) => {
    for (const tool of MEMORY_RECALL_TOOLS) {
      expect({ tool, allowed: isToolAllowedQuick(tool, workspace, ctx) }).toEqual({
        tool,
        allowed: false,
      });
    }
  });

  it("still allows memory recall in private context", () => {
    for (const tool of ["memory_recall", "context_recall", "kg_search"]) {
      expect(isToolAllowedQuick(tool, workspace, "private")).toBe(true);
    }
  });

  it("covers every registered kg_* tool", () => {
    const memoryGroup = new Set<string>(TOOL_GROUPS["group:memory"]);
    for (const tool of [
      "kg_create_entity",
      "kg_update_entity",
      "kg_delete_entity",
      "kg_create_edge",
      "kg_delete_edge",
      "kg_invalidate_edge",
      "kg_add_observation",
      "kg_search",
      "kg_get_neighbors",
      "kg_get_subgraph",
    ]) {
      expect(memoryGroup.has(tool)).toBe(true);
    }
  });

  it("lists no retired memory tool name in any tool group", () => {
    const grouped = new Set<string>(Object.values(TOOL_GROUPS).flat() as string[]);
    for (const retired of RETIRED_MEMORY_TOOL_NAMES) {
      expect({ retired, listed: grouped.has(retired) }).toEqual({ retired, listed: false });
    }
  });
});
