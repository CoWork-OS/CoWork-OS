import type { Task } from "../../shared/types";
import { LLMProviderFactory } from "./llm/provider-factory";

export function resolveComposerPredictionModel(task: Pick<Task, "agentConfig">) {
  return LLMProviderFactory.resolveTaskModelSelection(task.agentConfig, {
    forceProfile: "cheap",
    allowProviderOverride: true,
    allowProfileRouting: true,
  });
}
