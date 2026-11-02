import type { LLMTool } from "../llm/types";
import { TOOL_RESULT_READ_TOOL } from "../tool-result-spill";
import {
  SPILL_PAGE_DEFAULT_CHARS,
  SPILL_PAGE_MAX_CHARS,
  ToolResultSpillStore,
} from "../tool-result-spill-store";

const FINISHED_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * SpillTools pages through tool results that were shortened to fit the context window
 * (Inline & Spill). The truncation code keeps the omitted text under a handle and its
 * marker names the call; tool_result_read returns that text a page at a time.
 *
 * Handles are scoped to the task that wrote them: a task reads only its own spills.
 */
export class SpillTools {
  private storeOverride?: ToolResultSpillStore;

  constructor(
    private readonly taskId: string,
    store?: ToolResultSpillStore,
  ) {
    this.storeOverride = store;
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: TOOL_RESULT_READ_TOOL,
        description:
          "Read more of a tool result that was shortened to fit the context window. Use it when " +
          'a result contains a marker like [... 51234 chars omitted; call tool_result_read(handle="sp…", ' +
          "offset=4000) to continue ...] and you need the omitted text: pass that handle and offset, " +
          "then call again with next_offset until it is null or you have what you need. Prefer this " +
          "over re-running the command or fetch. Handles belong to this task and expire when it " +
          "finishes or after 24 hours; if one has expired, run the original tool again.",
        input_schema: {
          type: "object" as const,
          properties: {
            handle: {
              type: "string",
              description:
                'The handle from the omission marker (e.g. "sp0123456789ab" or "sp0123456789ab.2").',
            },
            offset: {
              type: "number",
              description:
                "Character offset to start reading from: the offset in the marker, or next_offset from the previous page. Default 0.",
            },
            length: {
              type: "number",
              description: `Characters to return (default ${SPILL_PAGE_DEFAULT_CHARS}, max ${SPILL_PAGE_MAX_CHARS}).`,
            },
          },
          required: ["handle"],
        },
      },
    ];
  }

  read(input: { handle?: unknown; offset?: unknown; length?: unknown }): Record<string, unknown> {
    const handle = typeof input?.handle === "string" ? input.handle.trim() : "";
    const offset = Number(input?.offset ?? 0);
    const length = input?.length === undefined ? SPILL_PAGE_DEFAULT_CHARS : Number(input.length);
    const page = this.store.read(this.taskId, handle, offset, length);
    if (!page.success) return { ...page };
    return {
      ...page,
      ...(page.next_offset === null
        ? { note: "End of this result." }
        : {
            note: `Call ${TOOL_RESULT_READ_TOOL}(handle="${page.handle}", offset=${page.next_offset}) for the next page.`,
          }),
    };
  }

  /** Spills live as long as the task runs: they go when it has finished. */
  expireIfTaskFinished(status: string | undefined): void {
    if (status && FINISHED_TASK_STATUSES.has(status)) this.store.expireTask(this.taskId);
  }

  private get store(): ToolResultSpillStore {
    this.storeOverride ??= ToolResultSpillStore.getDefault();
    return this.storeOverride;
  }
}
