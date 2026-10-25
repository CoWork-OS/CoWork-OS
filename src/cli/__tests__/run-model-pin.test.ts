import { describe, expect, it, vi } from "vitest";
import type { LLMProviderType } from "../../shared/types";
import {
  buildRemoteRunModelPin,
  resolveRunModelPin,
  resolveSupportedProviderType,
  type RunModelPinDependencies,
} from "../run-model-pin";

type Selection = ReturnType<RunModelPinDependencies["resolveSelection"]>;

function deps(options: {
  currentProvider?: LLMProviderType;
  configured?: LLMProviderType[];
  providerDefaults?: Partial<Record<LLMProviderType, string>>;
  selection?: (config: Parameters<RunModelPinDependencies["resolveSelection"]>[0]) => Selection;
}) {
  const currentProvider = options.currentProvider ?? "anthropic";
  const configured = options.configured ?? [currentProvider];
  const resolveSelection = vi.fn<RunModelPinDependencies["resolveSelection"]>(
    (config, resolveOptions) => {
      if (resolveOptions?.allowProviderOverride && !config.modelKey) {
        const providerType = config.providerType ?? currentProvider;
        return {
          providerType,
          modelKey: options.providerDefaults?.[providerType] ?? "",
          modelId: options.providerDefaults?.[providerType] ?? "",
          modelSource: "provider_default",
          warnings: [],
        };
      }
      if (options.selection) return options.selection(config);
      return {
        providerType: config.providerType ?? currentProvider,
        modelKey: config.modelKey ?? "",
        modelId: `id:${config.modelKey}`,
        modelSource: "explicit_override",
        warnings: [],
      };
    },
  );
  return {
    configStatus: () => ({
      currentProvider,
      providers: configured.map((type) => ({ type, configured: true })),
    }),
    resolveSelection,
  } satisfies RunModelPinDependencies;
}

describe("resolveRunModelPin", () => {
  it("leaves the task on the global model when neither flag is passed", () => {
    const d = deps({});
    expect(resolveRunModelPin({}, d)).toBeUndefined();
    expect(resolveRunModelPin({ provider: "  ", model: "" }, d)).toBeUndefined();
    expect(d.resolveSelection).not.toHaveBeenCalled();
  });

  it("pins the given provider and model and reports the model id it resolves to", () => {
    const d = deps({ currentProvider: "anthropic", configured: ["anthropic", "openrouter"] });

    const pin = resolveRunModelPin({ provider: "openrouter", model: " moonshotai/kimi-k3 " }, d);

    expect(pin).toEqual({
      agentConfig: {
        providerType: "openrouter",
        modelKey: "moonshotai/kimi-k3",
        modelPinned: true,
      },
      modelId: "id:moonshotai/kimi-k3",
    });
    expect(d.resolveSelection).toHaveBeenCalledWith(pin?.agentConfig);
  });

  it("pins --model alone on the current provider, stored explicitly", () => {
    const pin = resolveRunModelPin({ model: "gpt-6-luna" }, deps({ currentProvider: "openai" }));

    expect(pin?.agentConfig).toEqual({
      providerType: "openai",
      modelKey: "gpt-6-luna",
      modelPinned: true,
    });
  });

  it("pins --provider alone to that provider's saved model", () => {
    const d = deps({
      currentProvider: "anthropic",
      configured: ["anthropic", "ollama"],
      providerDefaults: { ollama: "qwen3.6:27b" },
    });

    const pin = resolveRunModelPin({ provider: "ollama" }, d);

    expect(d.resolveSelection).toHaveBeenNthCalledWith(
      1,
      { providerType: "ollama" },
      { allowProviderOverride: true },
    );
    expect(pin?.agentConfig).toEqual({
      providerType: "ollama",
      modelKey: "qwen3.6:27b",
      modelPinned: true,
    });
  });

  it("accepts the CLI's provider aliases", () => {
    const pin = resolveRunModelPin(
      { provider: "openai_compatible", model: "local-27b" },
      deps({ currentProvider: "openai", configured: ["openai", "openai-compatible"] }),
    );

    expect(pin?.agentConfig.providerType).toBe("openai-compatible");
  });

  it("refuses an unknown provider", () => {
    expect(() => resolveRunModelPin({ provider: "not-a-provider", model: "m" }, deps({}))).toThrow(
      "Unknown provider type: not-a-provider",
    );
  });

  it("refuses a provider that is not configured instead of running on the global model", () => {
    const d = deps({ currentProvider: "anthropic", configured: ["anthropic"] });

    expect(() => resolveRunModelPin({ provider: "openrouter", model: "x/y" }, d)).toThrow(
      'Provider "openrouter" is not configured',
    );
    expect(d.resolveSelection).not.toHaveBeenCalled();
  });

  it("refuses --provider alone when that provider has no saved model", () => {
    const d = deps({ configured: ["anthropic", "ollama"], providerDefaults: {} });

    expect(() => resolveRunModelPin({ provider: "ollama" }, d)).toThrow(
      'Provider "ollama" has no saved model. Pass --model <id>.',
    );
  });

  it("refuses a pin the model resolver would not honor", () => {
    const d = deps({
      selection: () => ({
        providerType: "anthropic",
        modelKey: "global-model",
        modelId: "global-model",
        modelSource: "provider_default",
        warnings: ["[LLMProviderFactory] Thread model anthropic/x is not available."],
      }),
    });

    expect(() => resolveRunModelPin({ model: "x" }, d)).toThrow(
      "Could not pin anthropic/x for this run: [LLMProviderFactory] Thread model anthropic/x is not available.",
    );
  });

  it("refuses a model key longer than task validation allows", () => {
    expect(() => resolveRunModelPin({ model: "m".repeat(201) }, deps({}))).toThrow(
      "--model must be at most 200 characters.",
    );
  });
});

describe("buildRemoteRunModelPin", () => {
  it("sends nothing when neither flag is passed", () => {
    expect(buildRemoteRunModelPin({})).toBeUndefined();
  });

  it("sends the pin for the remote node to resolve", () => {
    expect(buildRemoteRunModelPin({ provider: "openai_compatible", model: "local-27b" })).toEqual({
      providerType: "openai-compatible",
      modelKey: "local-27b",
      modelPinned: true,
    });
    expect(buildRemoteRunModelPin({ model: "gpt-6-sol" })).toEqual({
      modelKey: "gpt-6-sol",
      modelPinned: true,
    });
  });

  it("requires --model, since the remote node's saved model can't be read locally", () => {
    expect(() => buildRemoteRunModelPin({ provider: "openrouter" })).toThrow(
      "With --remote, pass --model too",
    );
  });
});

describe("resolveSupportedProviderType", () => {
  it("maps aliases to supported provider types", () => {
    expect(resolveSupportedProviderType("azure_anthropic")).toBe("azure-anthropic");
    expect(resolveSupportedProviderType("openrouter")).toBe("openrouter");
  });
});
