import { useEffect, useState } from "react";
import type { LLMModelInfo, LLMProviderType, LLMReasoningEffort, Task } from "../../shared/types";

export interface ThreadModelSelection {
  modelKey: string;
  providerType: LLMProviderType;
  /** True when the open conversation has its own model picked in the thread picker. */
  pinned: boolean;
}

/**
 * The model a conversation runs on: its own pinned choice, otherwise the global default.
 * Tasks without a pin follow the global model, even if they carry an old modelKey.
 */
export function resolveThreadModelSelection(
  task: Pick<Task, "agentConfig"> | undefined,
  globalModel: string,
  globalProvider: LLMProviderType,
): ThreadModelSelection {
  const config = task?.agentConfig;
  const modelKey = config?.modelPinned ? config.modelKey?.trim() : undefined;
  if (config?.modelPinned && config.providerType && modelKey) {
    return { modelKey, providerType: config.providerType, pinned: true };
  }
  return { modelKey: globalModel, providerType: globalProvider, pinned: false };
}

/**
 * Model picker values for the open conversation. Loads the model list of a pinned provider
 * that differs from the global one, so the picker labels and effort options match it.
 */
export function useThreadModelSelection(options: {
  task: Pick<Task, "id" | "agentConfig"> | undefined;
  globalModel: string;
  globalProvider: LLMProviderType;
  globalModels: LLMModelInfo[];
  globalReasoningEffort?: LLMReasoningEffort;
}): ThreadModelSelection & { models: LLMModelInfo[]; reasoningEffort?: LLMReasoningEffort } {
  const { task, globalModel, globalProvider, globalModels, globalReasoningEffort } = options;
  const selection = resolveThreadModelSelection(task, globalModel, globalProvider);
  const otherProvider = selection.providerType !== globalProvider ? selection.providerType : null;
  const [loaded, setLoaded] = useState<{ provider: LLMProviderType; models: LLMModelInfo[] }>();

  useEffect(() => {
    if (!otherProvider || loaded?.provider === otherProvider) return;
    let cancelled = false;
    void window.electronAPI
      ?.getProviderModels?.(otherProvider)
      .then((models) => {
        if (!cancelled) setLoaded({ provider: otherProvider, models: models || [] });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ provider: otherProvider, models: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [otherProvider, loaded?.provider]);

  if (!otherProvider) {
    return { ...selection, models: globalModels, reasoningEffort: globalReasoningEffort };
  }
  return {
    ...selection,
    models: loaded?.provider === otherProvider ? loaded.models : [],
    // The saved effort belongs to the global provider; another provider shows its default.
    reasoningEffort: undefined,
  };
}
