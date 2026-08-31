import type { LLMTool, LLMToolUse } from "../llm/types";
import { getDefaultRuntimeToolMetadata } from "../tools/runtime-tool-definition";

export interface PlannedToolBatch {
  concurrencyClass: ReturnType<typeof getDefaultRuntimeToolMetadata>["concurrencyClass"];
  calls: LLMToolUse[];
}

export class ToolBatchPlanner {
  constructor(private readonly toolLookup: (toolName: string) => LLMTool | undefined) {}

  getConcurrencyClass(
    toolName: string,
  ): ReturnType<typeof getDefaultRuntimeToolMetadata>["concurrencyClass"] {
    const tool = this.toolLookup(toolName);
    return (
      tool?.runtime?.concurrencyClass || getDefaultRuntimeToolMetadata(toolName).concurrencyClass
    );
  }

  isParallelEligible(toolName: string): boolean {
    const concurrencyClass = this.getConcurrencyClass(toolName);
    return concurrencyClass === "read_parallel" || concurrencyClass === "side_effect_parallel";
  }

  partition(calls: LLMToolUse[]): PlannedToolBatch[] {
    return calls.reduce<PlannedToolBatch[]>((batches, call) => {
      const concurrencyClass = this.getConcurrencyClass(call.name);
      const previous = batches.at(-1);
      if (
        previous &&
        previous.concurrencyClass === concurrencyClass &&
        (concurrencyClass === "read_parallel" || concurrencyClass === "side_effect_parallel")
      ) {
        previous.calls.push(call);
        return batches;
      }
      batches.push({ concurrencyClass, calls: [call] });
      return batches;
    }, []);
  }
}
