import type { MemoryFeaturesSettings } from "../../../shared/types";
import { ContentBuilder, type BuildExecutionPromptParams, type BuildExecutionPromptResult } from "../content/ContentBuilder";
import { TranscriptStore } from "../../memory/TranscriptStore";

export interface QueryContextSelection {
  query: string;
  transcriptContext: string;
  transcriptHits: number;
}

export class QueryOrchestrator {
  constructor(private readonly features: MemoryFeaturesSettings) {}

  buildRetrievalQuery(taskPrompt: string, followUpMessage?: string): string {
    const query = [followUpMessage, taskPrompt]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n\n")
      .trim();
    return query.slice(0, 2500);
  }

  async selectContext(params: {
    workspacePath: string;
    taskId: string;
    taskPrompt: string;
    followUpMessage?: string;
  }): Promise<QueryContextSelection> {
    const query = this.buildRetrievalQuery(params.taskPrompt, params.followUpMessage);
    if (!this.features.transcriptStoreEnabled) {
      return { query, transcriptContext: "", transcriptHits: 0 };
    }

    const results = await TranscriptStore.searchSpans({
      workspacePath: params.workspacePath,
      taskId: params.taskId,
      query,
      limit: 5,
    });

    const transcriptContext = results
      .map((entry) => {
        const payload =
          typeof entry.payload === "string" ? entry.payload : JSON.stringify(entry.payload).slice(0, 320);
        return `- [${entry.type}] ${payload}`;
      })
      .join("\n");

    return {
      query,
      transcriptContext,
      transcriptHits: results.length,
    };
  }

  async buildExecutionPrompt(
    params: BuildExecutionPromptParams & { transcriptContext?: string },
  ): Promise<BuildExecutionPromptResult> {
    const nextParams = {
      ...params,
      memoryContext: [params.memoryContext, params.transcriptContext].filter(Boolean).join("\n\n"),
      allowLayeredMemory: this.features.layeredMemoryEnabled,
    };
    return ContentBuilder.buildExecutionPrompt(nextParams);
  }
}
