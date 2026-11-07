/** Command-selection probe metrics. These are deterministic task proxies, not LLM scores. */
export interface QualityExpectation {
  expectedCommand: string | null;
  requiresRecall: boolean;
  supportedCommands: string[];
  staleCommands: string[];
  mustNotExpose: string[];
}
export interface QualityObservation {
  command: string | null;
  context: string;
  recalled: string[];
  estimatedMemoryTokens: number;
}
export interface QualityPair {
  id: string;
  category: string;
  expectation: QualityExpectation;
  enabled: QualityObservation;
  disabled: QualityObservation;
}
export interface QualityThresholds {
  minSuccessRate: number;
  minSuccessGain: number;
  minRecallAt5: number;
  maxUnsupportedRate: number;
  maxStaleRate: number;
  maxExposures: number;
  maxEstimatedMemoryTokens: number;
}

export function gradeQualityArm(pairs: QualityPair[], arm: "enabled" | "disabled") {
  let successes = 0,
    claims = 0,
    unsupported = 0,
    stale = 0,
    exposures = 0,
    recalled = 0;
  const recallEligible = pairs.filter((p) => p.expectation.requiresRecall).length;
  const details = pairs.map((pair) => {
    const observed = pair[arm];
    const expected = pair.expectation;
    const success = observed.command === expected.expectedCommand;
    successes += Number(success);
    if (observed.command !== null) {
      claims++;
      unsupported += Number(!expected.supportedCommands.includes(observed.command));
      stale += Number(expected.staleCommands.includes(observed.command));
    }
    const evidence = [observed.context, ...observed.recalled].join("\n");
    const leaked = expected.mustNotExpose.filter((value) => evidence.includes(value));
    exposures += leaked.length;
    const hit =
      expected.requiresRecall &&
      expected.expectedCommand !== null &&
      observed.recalled
        .slice(0, 5)
        .some((text) => text.includes("`" + expected.expectedCommand + "`"));
    recalled += Number(hit);
    return {
      id: pair.id,
      category: pair.category,
      success,
      command: observed.command,
      recallHit: hit,
      exposures: leaked.length,
      estimatedMemoryTokens: observed.estimatedMemoryTokens,
    };
  });
  const total = pairs.length;
  return {
    cases: total,
    successRate: total ? successes / total : 0,
    recallAt5: recallEligible ? recalled / recallEligible : 0,
    recallEligible,
    claims,
    unsupportedClaims: unsupported,
    staleClaims: stale,
    unsupportedRate: claims ? unsupported / claims : 0,
    staleRate: claims ? stale / claims : 0,
    exposures,
    meanEstimatedMemoryTokens: total
      ? pairs.reduce((n, p) => n + p[arm].estimatedMemoryTokens, 0) / total
      : 0,
    maxEstimatedMemoryTokens: Math.max(0, ...pairs.map((p) => p[arm].estimatedMemoryTokens)),
    details,
  };
}

export function gradeMemoryQuality(pairs: QualityPair[], thresholds: QualityThresholds) {
  const enabled = gradeQualityArm(pairs, "enabled");
  const disabled = gradeQualityArm(pairs, "disabled");
  const successGain = enabled.successRate - disabled.successRate;
  const failures: string[] = [];
  if (!pairs.length || new Set(pairs.map((p) => p.id)).size !== pairs.length)
    failures.push("Empty corpus or duplicate case IDs");
  if (!enabled.recallEligible) failures.push("No positive recall cases");
  if (enabled.successRate < thresholds.minSuccessRate)
    failures.push("Enabled task-proxy success below threshold");
  if (successGain < thresholds.minSuccessGain)
    failures.push("Paired task-proxy gain below threshold");
  if (enabled.recallAt5 < thresholds.minRecallAt5) failures.push("Useful recall@5 below threshold");
  // Safety gates apply to BOTH arms, including a custom responder that hallucinates without memory.
  for (const [name, metrics] of Object.entries({ enabled, disabled })) {
    if (metrics.unsupportedRate > thresholds.maxUnsupportedRate)
      failures.push(`${name}: unsupported command claims`);
    if (metrics.staleRate > thresholds.maxStaleRate) failures.push(`${name}: stale command claims`);
    if (metrics.exposures > thresholds.maxExposures)
      failures.push(`${name}: forbidden content exposure`);
    if (metrics.maxEstimatedMemoryTokens > thresholds.maxEstimatedMemoryTokens)
      failures.push(`${name}: memory token budget exceeded`);
  }
  return { passed: !failures.length, failures, enabled, disabled, successGain };
}
