/**
 * The model client of memory folder dreaming (docs/memory-repo-phase2-design.md §6): the
 * configured provider and model, the same selection as AI memory compression, with usage
 * telemetry under `memory_repo_dream`. A dream is not tied to one workspace.
 */
import type { DreamModelClient } from "./MemoryRepoDreamer";

export const MEMORY_REPO_DREAM_TELEMETRY_SOURCE = "memory_repo_dream";

export function createProviderDreamModelClient(): DreamModelClient {
  return {
    async complete(request) {
      const { LLMProviderFactory } = await import("../../agent/llm/provider-factory");
      const { recordLlmCallError, recordLlmCallSuccess } =
        await import("../../agent/llm/usage-telemetry");
      const selection = LLMProviderFactory.resolveTaskModelSelection();
      const telemetry = {
        workspaceId: null,
        sourceKind: MEMORY_REPO_DREAM_TELEMETRY_SOURCE,
        sourceId: "memory_repo",
        providerType: selection.providerType,
        modelKey: selection.modelKey,
        modelId: selection.modelId,
      };
      try {
        const provider = LLMProviderFactory.createProvider();
        const response = await provider.createMessage({
          model: selection.modelId,
          maxTokens: request.maxTokens,
          system: request.system,
          messages: [{ role: "user", content: [{ type: "text", text: request.user }] }],
        });
        recordLlmCallSuccess(telemetry, response.usage);
        const text = response.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        return {
          text,
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
        };
      } catch (error) {
        recordLlmCallError(telemetry, error);
        throw error;
      }
    },
  };
}
