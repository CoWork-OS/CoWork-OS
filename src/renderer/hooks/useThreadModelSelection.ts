import { useEffect, useState } from "react";
import { BOT_PROFILE_UPDATED_EVENT } from "../components/BotProfileDialog";
import type {
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
  Task,
} from "../../shared/types";

export interface ThreadModelSelection {
  modelKey: string;
  providerType: LLMProviderType;
  /** True when the open conversation has its own model picked in the thread picker. */
  pinned: boolean;
  /** Where the model comes from: this conversation, its bot, or the global default. */
  source: "thread" | "bot" | "global";
}

/** A bot's own model (`AgentRole.modelKey` / `providerType`); empty means the default. */
export interface BotModelChoice {
  modelKey?: string | null;
  providerType?: LLMProviderType | null;
}

/**
 * The model a conversation runs on: its own pinned choice, then its bot's model, otherwise
 * the global default. Tasks without either follow the global model, even if they carry an
 * old modelKey.
 */
export function resolveThreadModelSelection(
  task: Pick<Task, "agentConfig"> | undefined,
  globalModel: string,
  globalProvider: LLMProviderType,
  botModel?: BotModelChoice | null,
): ThreadModelSelection {
  const config = task?.agentConfig;
  const modelKey = config?.modelPinned ? config.modelKey?.trim() : undefined;
  if (config?.modelPinned && config.providerType && modelKey) {
    return { modelKey, providerType: config.providerType, pinned: true, source: "thread" };
  }
  const botKey = botModel?.modelKey?.trim();
  // A bot model without a provider is not used (see effectiveTaskModelConfig).
  if (botKey && botModel?.providerType) {
    return {
      modelKey: botKey,
      providerType: botModel.providerType,
      pinned: false,
      source: "bot",
    };
  }
  return { modelKey: globalModel, providerType: globalProvider, pinned: false, source: "global" };
}

/** The bot's own model for a conversation assigned to a bot; reloads when a bot is saved. */
function useBotModel(roleId: string | undefined): BotModelChoice | null {
  const [state, setState] = useState<{ roleId: string; model: BotModelChoice | null }>();
  const [token, setToken] = useState(0);
  useEffect(() => {
    const onSaved = () => setToken((value) => value + 1);
    window.addEventListener(BOT_PROFILE_UPDATED_EVENT, onSaved);
    return () => window.removeEventListener(BOT_PROFILE_UPDATED_EVENT, onSaved);
  }, []);
  useEffect(() => {
    if (!roleId || !window.electronAPI?.getAgentRole) return;
    let cancelled = false;
    window.electronAPI
      .getAgentRole(roleId)
      .then((role) => {
        if (cancelled) return;
        setState({
          roleId,
          model: role
            ? {
                modelKey: role.modelKey,
                providerType: (role.providerType as LLMProviderType | undefined) ?? null,
              }
            : null,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ roleId, model: null });
      });
    return () => {
      cancelled = true;
    };
  }, [roleId, token]);
  return roleId && state?.roleId === roleId ? state.model : null;
}

/**
 * Model picker values for the open conversation. Loads the model list of a pinned provider
 * that differs from the global one, so the picker labels and effort options match it.
 */
export function useThreadModelSelection(options: {
  task: Pick<Task, "id" | "agentConfig" | "assignedAgentRoleId"> | undefined;
  globalModel: string;
  globalProvider: LLMProviderType;
  globalModels: LLMModelInfo[];
  globalReasoningEffort?: LLMReasoningEffort;
  /** Provider status, for the saved effort of a pinned provider other than the global one. */
  globalProviders?: LLMProviderInfo[];
}): ThreadModelSelection & { models: LLMModelInfo[]; reasoningEffort?: LLMReasoningEffort } {
  const { task, globalModel, globalProvider, globalModels, globalReasoningEffort } = options;
  const botModel = useBotModel(
    task?.agentConfig?.modelPinned ? undefined : task?.assignedAgentRoleId,
  );
  const selection = resolveThreadModelSelection(task, globalModel, globalProvider, botModel);
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
    // The global effort belongs to the global provider; a pinned provider shows its own
    // saved effort (the one task:setModel writes), else its default.
    reasoningEffort: options.globalProviders?.find((provider) => provider.type === otherProvider)
      ?.reasoningEffort,
  };
}
