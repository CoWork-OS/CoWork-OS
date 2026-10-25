import { LLM_PROVIDER_TYPES, type AgentConfig, type LLMProviderType } from "../shared/types";

/** The longest model key `AgentConfigSchema` accepts. */
const MAX_MODEL_KEY_LENGTH = 200;

type PinFields = Pick<AgentConfig, "providerType" | "modelKey" | "modelPinned">;

export function normalizeProviderType(providerType: string): string {
  switch (providerType) {
    case "claude":
      return "anthropic";
    case "azure_anthropic":
      return "azure-anthropic";
    case "openai_compatible":
      return "openai-compatible";
    default:
      return providerType;
  }
}

export function resolveSupportedProviderType(providerType: string): LLMProviderType {
  const normalized = normalizeProviderType(providerType);
  const supportedProvider = LLM_PROVIDER_TYPES.find((candidate) => candidate === normalized);
  if (!supportedProvider) {
    throw new Error(
      `Unknown provider type: ${providerType}. Run cowork providers list for supported providers.`,
    );
  }
  return supportedProvider;
}

export interface RunModelPinDependencies {
  configStatus(): {
    currentProvider: LLMProviderType;
    providers: Array<{ type: LLMProviderType; configured: boolean }>;
  };
  /** `LLMProviderFactory.resolveTaskModelSelection`. */
  resolveSelection(
    config: PinFields,
    options?: { allowProviderOverride?: boolean },
  ): {
    providerType: LLMProviderType;
    modelId: string;
    modelKey: string;
    modelSource: "explicit_override" | "profile_model" | "provider_default";
    warnings: string[];
  };
}

export interface RunModelPin {
  agentConfig: Required<PinFields>;
  /** The model id the provider will be called with. */
  modelId: string;
}

function readPinInput(input: { provider?: string; model?: string }): {
  rawProvider: string;
  rawModel: string;
} {
  const rawProvider = input.provider?.trim() || "";
  const rawModel = input.model?.trim() || "";
  if (rawModel.length > MAX_MODEL_KEY_LENGTH) {
    throw new Error(`--model must be at most ${MAX_MODEL_KEY_LENGTH} characters.`);
  }
  return { rawProvider, rawModel };
}

/**
 * `cowork run --provider/--model`: pins the task to that model the same way the thread model
 * picker does (`modelPinned`), so the global default stays unchanged and runs can use
 * different models side by side. `--model` alone uses the current provider; `--provider`
 * alone uses that provider's saved model. Throws before the task exists when the pin would
 * not be honored, because the executor otherwise falls back to the global model quietly.
 */
export function resolveRunModelPin(
  input: { provider?: string; model?: string },
  deps: RunModelPinDependencies,
): RunModelPin | undefined {
  const { rawProvider, rawModel } = readPinInput(input);
  if (!rawProvider && !rawModel) return undefined;

  const status = deps.configStatus();
  const providerType = rawProvider
    ? resolveSupportedProviderType(rawProvider)
    : status.currentProvider;
  const configured = status.providers.some(
    (provider) => provider.type === providerType && provider.configured,
  );
  if (!configured) {
    throw new Error(
      `Provider "${providerType}" is not configured. Set it up in the desktop app or run: cowork providers configure ${providerType}`,
    );
  }

  const modelKey =
    rawModel || deps.resolveSelection({ providerType }, { allowProviderOverride: true }).modelKey;
  if (!modelKey) {
    throw new Error(`Provider "${providerType}" has no saved model. Pass --model <id>.`);
  }

  const agentConfig: Required<PinFields> = { providerType, modelKey, modelPinned: true };
  const selection = deps.resolveSelection(agentConfig);
  if (selection.providerType !== providerType || selection.modelSource !== "explicit_override") {
    const reason = selection.warnings.join(" ").trim();
    throw new Error(
      `Could not pin ${providerType}/${modelKey} for this run${reason ? `: ${reason}` : "."}`,
    );
  }
  return { agentConfig, modelId: selection.modelId };
}

/**
 * The pin for `cowork run --remote`. The remote node resolves it against its own settings, so
 * `--model` is required: that node's saved model for a provider can't be read from here.
 * Without `--provider` the model runs on the node's current provider.
 */
export function buildRemoteRunModelPin(input: {
  provider?: string;
  model?: string;
}): PinFields | undefined {
  const { rawProvider, rawModel } = readPinInput(input);
  if (!rawProvider && !rawModel) return undefined;
  if (!rawModel) {
    throw new Error(
      "With --remote, pass --model too: the remote node's saved model can't be read from here.",
    );
  }
  return {
    ...(rawProvider ? { providerType: resolveSupportedProviderType(rawProvider) } : {}),
    modelKey: rawModel,
    modelPinned: true,
  };
}
