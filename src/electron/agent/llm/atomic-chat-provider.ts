import {
  AtomicChatProviderError,
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderOptions,
} from "./openai-compatible-provider";
import type { LLMRequest } from "./types";
import { ModelCapabilityRegistry, type ModelCapabilityProfile } from "./model-capability-profile";

export const ATOMIC_CHAT_DEFAULT_BASE_URL = "http://127.0.0.1:1337/v1";

export const atomicChatCapabilityRegistry = new ModelCapabilityRegistry();

function readTimeoutOverride(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export type AtomicChatProviderOptions = Omit<
  OpenAICompatibleProviderOptions,
  "type" | "providerName" | "baseUrl"
> & {
  baseUrl?: string;
  providerName?: string;
  backendVersion?: string;
  template?: string;
};

/**
 * Inference-only adapter for an already-running Atomic Chat API.
 *
 * Atomic Chat owns model loading and its local server lifecycle. CoWork owns
 * the task loop, permissions, approvals, tools, evidence, and cancellation.
 */
export class AtomicChatProvider extends OpenAICompatibleProvider {
  private readonly capabilityEndpoint: string;
  private readonly backendVersion?: string;
  private readonly template?: string;

  constructor(options: AtomicChatProviderOptions) {
    const baseUrl = options.baseUrl || ATOMIC_CHAT_DEFAULT_BASE_URL;
    super({
      ...options,
      type: "atomic-chat",
      providerName: options.providerName || "Atomic Chat",
      baseUrl,
      requestTimeoutMs:
        options.requestTimeoutMs ??
        readTimeoutOverride("COWORK_ATOMIC_CHAT_REQUEST_TIMEOUT_MS", 60_000),
      discoveryTimeoutMs:
        options.discoveryTimeoutMs ??
        readTimeoutOverride("COWORK_ATOMIC_CHAT_DISCOVERY_TIMEOUT_MS", 5_000),
    });
    this.capabilityEndpoint = normalizeCapabilityEndpoint(baseUrl);
    this.backendVersion = options.backendVersion?.trim() || undefined;
    this.template = options.template?.trim() || undefined;
  }

  getCapabilityProfile(modelId: string): ModelCapabilityProfile {
    return atomicChatCapabilityRegistry.getOrCreate({
      endpoint: this.capabilityEndpoint,
      modelId,
      backend: "atomic-chat",
      backendVersion: this.backendVersion,
      template: this.template,
    });
  }

  protected override observeResponse(model: string, request: LLMRequest, data: Any): void {
    const toolCalls = data?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(request.tools) || request.tools.length === 0 || !Array.isArray(toolCalls)) {
      return;
    }

    const key = {
      endpoint: this.capabilityEndpoint,
      modelId: model,
      backend: "atomic-chat",
      backendVersion: this.backendVersion,
      template: this.template,
    };
    atomicChatCapabilityRegistry.record(key, "tools", "verified", {
      source: "atomic_chat_tool_call_response",
      note: "The endpoint returned a structurally valid tool-call envelope.",
    });
    if (toolCalls.length > 1) {
      atomicChatCapabilityRegistry.record(key, "multiple_tool_calls", "verified", {
        source: "atomic_chat_tool_call_response",
        note: "The endpoint returned more than one tool call in a single response.",
      });
    }
  }
}

function normalizeCapabilityEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    // Capability identity must never include credentials embedded in a URL.
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl.trim().replace(/\/+$/, "");
  }
}

export { AtomicChatProviderError };
