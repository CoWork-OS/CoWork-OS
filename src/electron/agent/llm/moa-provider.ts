import * as crypto from "crypto";
import type { MoaModelSlot, MoaPreset } from "../../../shared/types";
import type {
  LLMContent,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from "./types";

const DEFAULT_REFERENCE_MAX_TOKENS = 1024;
const DEFAULT_REFERENCE_MAX_CHARS_PER_MODEL = 12000;
const DEFAULT_REFERENCE_CONCURRENCY = 4;
const REFERENCE_TRANSCRIPT_CHAR_LIMIT = 120000;
const REFERENCE_CACHE_TTL_MS = 10 * 60 * 1000;
const REFERENCE_CACHE_MAX_ENTRIES = 64;

export interface ResolvedMoaSlot {
  provider: LLMProvider;
  modelId: string;
}

export interface MoaProviderOptions {
  defaultPreset?: string;
  presets?: Record<string, MoaPreset>;
  resolveSlot(slot: MoaModelSlot): ResolvedMoaSlot | ResolvedMoaSlot[];
}

interface ReferenceResult {
  index: number;
  slot: MoaModelSlot;
  ok: boolean;
  text: string;
  usage?: LLMResponse["usage"];
  error?: string;
}

interface ReferenceCacheEntry {
  expiresAt: number;
  results: ReferenceResult[];
}

export class MoaProvider implements LLMProvider {
  readonly type = "moa" as const;

  private defaultPreset?: string;
  private presets: Record<string, MoaPreset>;
  private resolveSlot: MoaProviderOptions["resolveSlot"];
  private referenceCache = new Map<string, ReferenceCacheEntry>();

  constructor(options: MoaProviderOptions) {
    this.defaultPreset = options.defaultPreset;
    this.presets = options.presets || {};
    this.resolveSlot = options.resolveSlot;
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const preset = this.resolvePreset(request.model);
    this.validatePreset(preset);
    const cacheKey = this.buildReferenceCacheKey(preset, request);
    const referenceResults = await this.getReferenceResults(
      cacheKey,
      preset,
      request,
    );
    const advisory = this.buildAdvisoryContext(preset, referenceResults);
    const aggregatorResponse = await this.createMessageWithSlotFailover(
      preset.aggregator,
      {
        ...request,
        messages: this.withAdvisoryContext(request.messages, advisory),
      },
    );

    return {
      ...aggregatorResponse,
      usage: this.mergeUsage(
        aggregatorResponse.usage,
        ...referenceResults.map((result) => result.usage),
      ),
    };
  }

  private async createMessageWithSlotFailover(
    slot: MoaModelSlot,
    request: LLMRequest,
  ): Promise<LLMResponse> {
    const candidates = this.resolveSlotCandidates(slot);
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        this.throwIfAborted(request.signal);
        return await candidate.provider.createMessage({
          ...request,
          model: candidate.modelId,
        });
      } catch (error: unknown) {
        if (request.signal?.aborted) {
          throw error;
        }
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError || "MoA slot failed."));
  }

  private resolveSlotCandidates(slot: MoaModelSlot): ResolvedMoaSlot[] {
    const resolved = this.resolveSlot(slot);
    const candidates = Array.isArray(resolved) ? resolved : [resolved];
    if (candidates.length === 0) {
      throw new Error(
        `Mixture of Agents slot ${slot.providerType}/${slot.modelKey} has no usable provider.`,
      );
    }
    return candidates;
  }

  private async testConnectionWithSlotFailover(
    slot: MoaModelSlot,
  ): Promise<{ success: boolean; error?: string }> {
    const candidates = this.resolveSlotCandidates(slot);
    let lastError: string | undefined;
    for (const candidate of candidates) {
      const result = await candidate.provider.testConnection();
      if (result.success) return result;
      lastError = result.error;
    }

    return {
      success: false,
      error: lastError || "All MoA slot providers failed connection testing.",
    };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const preset = this.resolvePreset(this.defaultPreset);
      this.validatePreset(preset);
      return await this.testConnectionWithSlotFailover(preset.aggregator);
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolvePreset(requestedPreset?: string): MoaPreset {
    const id = requestedPreset?.trim() || this.defaultPreset?.trim();
    const preset = id ? this.presets[id] : undefined;
    if (preset) return preset;

    const fallback = Object.values(this.presets).find(
      (candidate) => candidate.enabled !== false,
    );
    if (fallback) return fallback;

    throw new Error("No enabled Mixture of Agents preset is configured.");
  }

  private validatePreset(preset: MoaPreset): void {
    if (preset.enabled === false) {
      throw new Error(`Mixture of Agents preset "${preset.name}" is disabled.`);
    }
    if (!preset.aggregator?.providerType || !preset.aggregator.modelKey?.trim()) {
      throw new Error(`Mixture of Agents preset "${preset.name}" has no aggregator model.`);
    }
    if (!Array.isArray(preset.referenceModels) || preset.referenceModels.length < 1) {
      throw new Error(`Mixture of Agents preset "${preset.name}" has no reference models.`);
    }
    for (const slot of [preset.aggregator, ...preset.referenceModels]) {
      if (slot.providerType === "moa") {
        throw new Error("Mixture of Agents presets cannot reference another MoA preset.");
      }
      if (!slot.modelKey?.trim()) {
        throw new Error(`Mixture of Agents preset "${preset.name}" has an empty model slot.`);
      }
    }
  }

  private async getReferenceResults(
    cacheKey: string,
    preset: MoaPreset,
    request: LLMRequest,
  ): Promise<ReferenceResult[]> {
    const cached = this.referenceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.results;
    }

    const concurrency = this.clampInteger(
      preset.concurrency,
      1,
      8,
      DEFAULT_REFERENCE_CONCURRENCY,
    );
    const results = await this.runWithConcurrency(
      preset.referenceModels,
      concurrency,
      async (slot, index) => this.runReferenceModel(preset, request, slot, index),
    );
    this.referenceCache.set(cacheKey, {
      expiresAt: Date.now() + REFERENCE_CACHE_TTL_MS,
      results,
    });
    this.pruneReferenceCache();
    return results;
  }

  private async runReferenceModel(
    preset: MoaPreset,
    request: LLMRequest,
    slot: MoaModelSlot,
    index: number,
  ): Promise<ReferenceResult> {
    try {
      this.throwIfAborted(request.signal);
      const response = await this.createMessageWithSlotFailover(slot, {
        model: slot.modelKey,
        maxTokens: this.getReferenceMaxTokens(preset, slot),
        system:
          "You are an advisor in a Mixture of Agents call. Review the transcript and provide concise, high-signal guidance for the final acting model. Do not call tools.",
        messages: [
          {
            role: "user",
            content: this.buildReferencePrompt(preset, request, slot),
          },
        ],
        toolChoice: "none",
        signal: request.signal,
      });
      return {
        index,
        slot,
        ok: true,
        text: this.truncate(
          this.responseToText(response),
          this.clampInteger(
            preset.maxReferenceCharsPerModel,
            500,
            50000,
            DEFAULT_REFERENCE_MAX_CHARS_PER_MODEL,
          ),
        ),
        usage: response.usage,
      };
    } catch (error: unknown) {
      if (request.signal?.aborted) {
        throw error;
      }
      return {
        index,
        slot,
        ok: false,
        text: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private buildReferencePrompt(
    preset: MoaPreset,
    request: LLMRequest,
    slot: MoaModelSlot,
  ): string {
    const parts = [
      `Preset: ${preset.name}`,
      slot.roleInstruction?.trim()
        ? `Your advisor role:\n${slot.roleInstruction.trim()}`
        : undefined,
      request.system?.trim()
        ? `Original system context:\n${this.truncate(request.system, 20000)}`
        : undefined,
      request.systemBlocks?.length
        ? `Additional system blocks:\n${this.truncate(
            request.systemBlocks.map((block) => block.text).join("\n\n"),
            20000,
          )}`
        : undefined,
      `Transcript:\n${this.truncate(
        this.renderMessagesForReference(request.messages),
        REFERENCE_TRANSCRIPT_CHAR_LIMIT,
      )}`,
      "Return concise advisory notes. Focus on risks, missing context, and concrete next steps for the acting model.",
    ];
    return parts.filter(Boolean).join("\n\n");
  }

  private renderMessagesForReference(messages: LLMMessage[]): string {
    return messages
      .map((message, index) => {
        return `#${index + 1} ${message.role.toUpperCase()}\n${this.renderContent(
          message.content,
        )}`;
      })
      .join("\n\n");
  }

  private renderContent(content: LLMMessage["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((item) => {
        if (item.type === "text") return item.text;
        if (item.type === "image") {
          return `[image ${item.mimeType}, ${item.originalSizeBytes ?? "unknown"} bytes]`;
        }
        if (item.type === "tool_use") {
          return `[tool_call ${item.name} ${this.safeJson(item.input)}]`;
        }
        if (item.type === "tool_result") {
          return `[tool_result ${item.tool_use_id}${item.is_error ? " error" : ""}]\n${
            item.content
          }`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private buildAdvisoryContext(
    preset: MoaPreset,
    referenceResults: ReferenceResult[],
  ): string {
    const sections = referenceResults
      .sort((a, b) => a.index - b.index)
      .map((result) => {
        const label = `${result.slot.providerType}/${result.slot.modelKey}`;
        if (!result.ok) {
          return `## Advisor ${result.index + 1}: ${label}\nReference call failed: ${
            result.error || "unknown error"
          }`;
        }
        return `## Advisor ${result.index + 1}: ${label}\n${result.text}`;
      })
      .join("\n\n");

    return [
      "<cowork_moa_advisory>",
      `Mixture of Agents preset: ${preset.name}`,
      "Use these internal advisor notes as optional guidance. Do not mention this advisory block unless the user asks about model routing.",
      sections,
      "</cowork_moa_advisory>",
    ].join("\n\n");
  }

  private withAdvisoryContext(
    messages: LLMMessage[],
    advisory: string,
  ): LLMMessage[] {
    const next = messages.map((message) => ({ ...message }));
    const last = next[next.length - 1];
    if (last?.role === "user" && typeof last.content === "string") {
      last.content = `${last.content}\n\n${advisory}`;
      return next;
    }
    if (
      last?.role === "user" &&
      Array.isArray(last.content) &&
      last.content.every((item) => item.type !== "tool_result")
    ) {
      last.content = [
        ...(last.content as LLMContent[]),
        { type: "text", text: advisory },
      ];
      return next;
    }
    return [...next, { role: "user", content: advisory }];
  }

  private responseToText(response: LLMResponse): string {
    return response.content
      .map((item) => {
        if (item.type === "text") return item.text;
        if (item.type === "tool_use") {
          return `[tool_call ${item.name} ${this.safeJson(item.input)}]`;
        }
        if (item.type === "image") return `[image ${item.mimeType}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private buildReferenceCacheKey(preset: MoaPreset, request: LLMRequest): string {
    const material = {
      presetId: preset.id,
      references: preset.referenceModels.map((slot) => ({
        providerType: slot.providerType,
        modelKey: slot.modelKey,
        maxTokens: slot.maxTokens,
        roleInstruction: slot.roleInstruction,
      })),
      system: request.system,
      systemBlocks: request.systemBlocks?.map((block) => block.text),
      messages: this.renderMessagesForReference(request.messages),
    };
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(material))
      .digest("hex");
  }

  private getReferenceMaxTokens(preset: MoaPreset, slot: MoaModelSlot): number {
    return this.clampInteger(
      slot.maxTokens ?? preset.maxReferenceTokens,
      64,
      8192,
      DEFAULT_REFERENCE_MAX_TOKENS,
    );
  }

  private mergeUsage(
    ...usages: Array<LLMResponse["usage"] | undefined>
  ): LLMResponse["usage"] | undefined {
    const present = usages.filter(Boolean) as NonNullable<LLMResponse["usage"]>[];
    if (present.length === 0) return undefined;
    return present.reduce(
      (acc, usage) => ({
        inputTokens: acc.inputTokens + usage.inputTokens,
        outputTokens: acc.outputTokens + usage.outputTokens,
        cachedTokens: (acc.cachedTokens || 0) + (usage.cachedTokens || 0),
        cacheWriteTokens:
          (acc.cacheWriteTokens || 0) + (usage.cacheWriteTokens || 0),
      }),
      { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
    );
  }

  private async runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = Array.from({ length: items.length });
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (nextIndex < items.length) {
          const current = nextIndex;
          nextIndex += 1;
          results[current] = await worker(items[current], current);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  private pruneReferenceCache(): void {
    const now = Date.now();
    for (const [key, value] of this.referenceCache) {
      if (value.expiresAt <= now) this.referenceCache.delete(key);
    }
    while (this.referenceCache.size > REFERENCE_CACHE_MAX_ENTRIES) {
      const firstKey = this.referenceCache.keys().next().value;
      if (!firstKey) break;
      this.referenceCache.delete(firstKey);
    }
  }

  private truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    const head = Math.floor(maxChars * 0.55);
    const tail = Math.max(0, maxChars - head - 32);
    return `${value.slice(0, head)}\n...[truncated]...\n${value.slice(-tail)}`;
  }

  private clampInteger(
    value: number | undefined,
    min: number,
    max: number,
    fallback: number,
  ): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(value as number)));
  }

  private safeJson(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable]";
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error("Mixture of Agents request aborted.");
    }
  }
}
