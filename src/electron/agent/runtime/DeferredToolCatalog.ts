import type { LLMTool } from "../llm/types";

export interface DeferredToolCatalogEntry {
  tool: LLMTool;
  deferred: boolean;
}

export class DeferredToolCatalog {
  private readonly entries = new Map<string, DeferredToolCatalogEntry>();

  constructor(tools: LLMTool[]) {
    for (const tool of tools) {
      this.entries.set(tool.name, {
        tool,
        deferred: Boolean(tool.runtime?.deferLoad && !tool.runtime?.alwaysExpose),
      });
    }
  }

  getVisibleTools(): LLMTool[] {
    return Array.from(this.entries.values())
      .filter((entry) => !entry.deferred)
      .map((entry) => entry.tool);
  }

  getDeferredTools(): LLMTool[] {
    return Array.from(this.entries.values())
      .filter((entry) => entry.deferred)
      .map((entry) => entry.tool);
  }

  getAll(): DeferredToolCatalogEntry[] {
    return Array.from(this.entries.values());
  }
}
