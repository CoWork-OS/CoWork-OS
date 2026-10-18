/** Older device responses may include health samples absent from the current summary contract. */
export function deviceMetricLabel(
  device: unknown,
  metric: "cpuUsage" | "memoryUsage" | "loadAverage",
): string {
  if (!device || typeof device !== "object") return "—";
  const sample = (device as Record<string, unknown>)[metric];
  const value = metric === "loadAverage" && Array.isArray(sample) ? sample[0] : sample;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  return metric === "loadAverage" ? value.toFixed(1) : `${value.toFixed(0)}%`;
}
