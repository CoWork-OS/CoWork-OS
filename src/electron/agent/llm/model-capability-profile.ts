export type ModelCapabilityState = "verified" | "unsupported" | "unknown";
export type ModelCapabilityName =
  | "tools"
  | "multiple_tool_calls"
  | "images"
  | "streaming"
  | "reasoning"
  | "structured_output"
  | "context_limit";

export interface ModelCapabilityKey {
  endpoint: string;
  modelId: string;
  backend: string;
  backendVersion?: string;
  template?: string;
}

export interface ModelCapabilityEvidence {
  source: string;
  observedAt: number;
  note?: string;
}

export interface ModelCapabilityProfile {
  key: ModelCapabilityKey;
  capabilities: Record<ModelCapabilityName, ModelCapabilityState>;
  evidence: Partial<Record<ModelCapabilityName, ModelCapabilityEvidence>>;
}

const CAPABILITY_NAMES: ModelCapabilityName[] = [
  "tools",
  "multiple_tool_calls",
  "images",
  "streaming",
  "reasoning",
  "structured_output",
  "context_limit",
];

export function normalizeModelCapabilityKey(input: ModelCapabilityKey): ModelCapabilityKey {
  return {
    endpoint: String(input.endpoint || "")
      .trim()
      .replace(/\/+$/, ""),
    modelId: String(input.modelId || "").trim(),
    backend: String(input.backend || "").trim(),
    ...(input.backendVersion ? { backendVersion: String(input.backendVersion).trim() } : {}),
    ...(input.template ? { template: String(input.template).trim() } : {}),
  };
}

export function modelCapabilityKey(input: ModelCapabilityKey): string {
  const key = normalizeModelCapabilityKey(input);
  return [
    key.endpoint,
    key.modelId,
    key.backend,
    key.backendVersion || "",
    key.template || "",
  ].join("|");
}

export function createUnknownModelCapabilityProfile(
  input: ModelCapabilityKey,
): ModelCapabilityProfile {
  return {
    key: normalizeModelCapabilityKey(input),
    capabilities: Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, "unknown"])) as Record<
      ModelCapabilityName,
      ModelCapabilityState
    >,
    evidence: {},
  };
}

export class ModelCapabilityRegistry {
  private readonly profiles = new Map<string, ModelCapabilityProfile>();

  getOrCreate(key: ModelCapabilityKey): ModelCapabilityProfile {
    const normalized = normalizeModelCapabilityKey(key);
    const cacheKey = modelCapabilityKey(normalized);
    const existing = this.profiles.get(cacheKey);
    if (existing) return existing;
    const created = createUnknownModelCapabilityProfile(normalized);
    this.profiles.set(cacheKey, created);
    return created;
  }

  record(
    key: ModelCapabilityKey,
    capability: ModelCapabilityName,
    state: Exclude<ModelCapabilityState, "unknown">,
    evidence: Omit<ModelCapabilityEvidence, "observedAt"> & { observedAt?: number },
  ): ModelCapabilityProfile {
    const profile = this.getOrCreate(key);
    profile.capabilities[capability] = state;
    profile.evidence[capability] = {
      ...evidence,
      observedAt: evidence.observedAt ?? Date.now(),
    };
    return profile;
  }

  clear(): void {
    this.profiles.clear();
  }
}
