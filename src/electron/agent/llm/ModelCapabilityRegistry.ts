/**
 * Model Capability Registry
 *
 * Maps task capability requirements to appropriate model selections.
 * Provides a structured way to route tasks to models based on their strengths
 * (code generation, math, research, vision) rather than just cost tier.
 */

export type ModelCapability = "code" | "math" | "research" | "vision" | "fast" | "long_context";

export interface ModelCapabilityProfile {
  /** Model key alias used in resolveModelPreferenceToModelKey */
  modelPreference: "cheaper" | "smarter" | "sonnet";
  capabilities: ModelCapability[];
  costTier: "cheap" | "balanced" | "strong";
  contextWindowK: number;
  supportsVision: boolean;
}

/**
 * Capability keyword signals used to infer required capability from task text.
 * Ordered by specificity — more specific patterns first.
 */
const CAPABILITY_SIGNALS: Record<ModelCapability, RegExp> = {
  vision: /\b(image|screenshot|photo|picture|diagram|chart|visual|figure|ocr|annotate)\b/i,
  code: /\b(code|bug|debug|function|class|refactor|test|typescript|javascript|python|rust|go|kotlin|swift|compile|lint|diff|patch|implement|algorithm)\b/i,
  math: /\b(math|equation|formula|calculate|solve|integral|derivative|probability|statistics|proof|algebra|geometry|calculus)\b/i,
  research:
    /\b(research|summarize|survey|literature|compare|analyze|review|report|investigate|background)\b/i,
  long_context:
    /\b(entire file|full codebase|whole repo|all files|read through|scan all|large document|book|transcript)\b/i,
  fast: /\b(quickly|fast|brief|short|simple|tiny|small|quick|one-liner|trivial)\b/i,
};

/**
 * Profiles for the three model tiers available in CoWork OS.
 * Mapped to the preference aliases accepted by resolveModelPreferenceToModelKey.
 */
const PROFILES: ModelCapabilityProfile[] = [
  {
    modelPreference: "cheaper",
    capabilities: ["fast", "code"],
    costTier: "cheap",
    contextWindowK: 200,
    supportsVision: false,
  },
  {
    modelPreference: "sonnet",
    capabilities: ["code", "research", "math", "vision", "long_context"],
    costTier: "balanced",
    contextWindowK: 200,
    supportsVision: true,
  },
  {
    modelPreference: "smarter",
    capabilities: ["code", "math", "research", "vision", "long_context"],
    costTier: "strong",
    contextWindowK: 200,
    supportsVision: true,
  },
];

export class ModelCapabilityRegistry {
  static selectForWorkflowPhaseType(
    phaseType: string,
  ): "cheaper" | "smarter" | "sonnet" | undefined {
    switch (phaseType) {
      case "research":
      case "analyze":
        return "sonnet";
      case "create":
        return "sonnet";
      case "deliver":
        return "cheaper";
      case "general":
      default:
        return undefined;
    }
  }

  /**
   * Select the cheapest model that satisfies the required capability.
   * Falls back to "smarter" if no profile can handle the capability.
   */
  static selectForCapability(
    capability: ModelCapability,
    costBudget: "cheap" | "any" = "any",
  ): "cheaper" | "smarter" | "sonnet" {
    const candidates = PROFILES.filter(
      (p) =>
        p.capabilities.includes(capability) && (costBudget === "any" || p.costTier === "cheap"),
    );
    // Return cheapest matching profile
    for (const tier of ["cheap", "balanced", "strong"] as const) {
      const match = candidates.find((p) => p.costTier === tier);
      if (match) return match.modelPreference;
    }
    return "smarter";
  }

  /**
   * Infer required capabilities from free-text task signals, then select a model.
   * Returns the model preference string suitable for resolveModelPreferenceToModelKey.
   */
  static selectForTask(
    taskText: string,
    costBudget: "cheap" | "any" = "any",
  ): "cheaper" | "smarter" | "sonnet" | undefined {
    if (!taskText) return undefined;
    const capabilities = this.inferCapabilities(taskText);
    if (capabilities.length === 0) return undefined;

    // Vision tasks always need sonnet or smarter
    if (capabilities.includes("vision")) {
      return costBudget === "cheap" ? "sonnet" : "sonnet";
    }
    // Math and long_context tasks prefer sonnet or smarter
    if (capabilities.includes("math") || capabilities.includes("long_context")) {
      return "sonnet";
    }
    // Code tasks can use cheaper for simple work
    if (capabilities.includes("code") && costBudget === "cheap") {
      return "cheaper";
    }
    // Research tasks use sonnet
    if (capabilities.includes("research")) {
      return "sonnet";
    }
    // Fast/trivial tasks use cheaper
    if (capabilities.includes("fast")) {
      return "cheaper";
    }
    return undefined;
  }

  /**
   * Infer the capabilities required by a task from its text content.
   */
  static inferCapabilities(taskText: string): ModelCapability[] {
    const text = String(taskText || "");
    const result: ModelCapability[] = [];
    for (const [cap, pattern] of Object.entries(CAPABILITY_SIGNALS) as [
      ModelCapability,
      RegExp,
    ][]) {
      if (pattern.test(text)) {
        result.push(cap);
      }
    }
    return result;
  }

  static getProfiles(): ModelCapabilityProfile[] {
    return [...PROFILES];
  }
}
