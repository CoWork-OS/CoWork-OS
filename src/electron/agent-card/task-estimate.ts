import {
  ApplicationPreparedChangeSchema,
  type ApplicationPreparedChange,
} from "../../shared/application-execution";
import { modelCostClass } from "./agent-card";

/**
 * A task estimate before running it (WP16), in the prepared-change shape the application
 * layer already uses: cost and duration from the user's own recent tasks on the model. The
 * prompt is not analysed; the summary says so.
 */
export interface TaskEstimateInput {
  prompt: string;
  modelId: string;
  provider?: string | null;
  cost: { sampleSize: number; medianCost: number; p90Cost: number } | null;
  duration: { sampleSize: number; medianMs: number; p90Ms: number } | null;
}

function money(value: number): string {
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function minutes(ms: number): string {
  const total = Math.max(1, Math.round(ms / 60_000));
  return total >= 60 ? `${Math.floor(total / 60)} h ${total % 60} min` : `${total} min`;
}

export function buildTaskEstimate(input: TaskEstimateInput): ApplicationPreparedChange {
  const model = input.modelId.trim();
  const price = modelCostClass({ provider: input.provider, modelId: model });
  const local = price.class === "local";
  const lines: string[] = [];
  if (local) {
    lines.push(`${model} runs locally: no per-token cost.`);
  } else if (input.cost) {
    lines.push(
      `Typical cost on ${model}: ${money(input.cost.medianCost)}; 90% of your last ${input.cost.sampleSize} tasks cost under ${money(input.cost.p90Cost)}.`,
    );
  } else {
    lines.push(`Not enough history on ${model} to estimate the cost (fewer than 3 tasks).`);
  }
  if (input.duration) {
    lines.push(
      `Typical duration: ${minutes(input.duration.medianMs)}; 90% finished within ${minutes(input.duration.p90Ms)} (wall clock, approval waits included).`,
    );
  } else {
    lines.push("Not enough history to estimate the duration.");
  }
  lines.push("Based only on your past tasks on this model; the prompt itself is not analysed.");

  const estimatedCost = local ? 0 : input.cost?.medianCost;
  const payload: Record<string, string | number | boolean> = {
    basis: "history",
    model,
    priceClass: String(price.class),
    promptChars: input.prompt.length,
  };
  if (input.cost) {
    payload.costSampleSize = input.cost.sampleSize;
    payload.p90Cost = input.cost.p90Cost;
  }
  if (input.duration) {
    payload.durationSampleSize = input.duration.sampleSize;
    payload.p90DurationMs = input.duration.p90Ms;
  }
  return ApplicationPreparedChangeSchema.parse({
    kind: "summary",
    summary: lines.join(" "),
    references: [],
    ...(estimatedCost !== undefined ? { estimatedCost, currency: "USD" } : {}),
    ...(input.duration ? { estimatedDurationMs: input.duration.medianMs } : {}),
    payload,
  });
}
