function dayKey(value) {
  return String(value || "").slice(0, 10);
}

export function sumNpmDownloadRows(rows) {
  if (!Array.isArray(rows)) return null;
  return rows.reduce((total, row) => total + (Number.isFinite(row?.downloads) ? row.downloads : 0), 0);
}

export function getNpmFirstPublishedDay(metadata) {
  const dates = Object.entries(metadata?.time || {})
    .filter(([version, value]) => version !== "created" && version !== "modified" && typeof value === "string")
    .map(([, value]) => dayKey(value))
    .filter(Boolean)
    .sort();

  return dates[0] || null;
}

export function buildNpmAllTimeMetric(rangeData, packageFirstPublishedDay) {
  const downloads = sumNpmDownloadRows(rangeData?.downloads);
  const start = rangeData?.start || null;
  const end = rangeData?.end || null;
  const hasCompleteHistory =
    downloads != null && Boolean(start) && Boolean(packageFirstPublishedDay) && start <= packageFirstPublishedDay;

  return {
    period: "all-time",
    downloads: hasCompleteHistory ? downloads : null,
    start,
    end,
    packageFirstPublished: packageFirstPublishedDay || null,
    coverage: rangeData?.error ? "unavailable" : hasCompleteHistory ? "complete" : "partial",
    ...(rangeData?.error ? { error: rangeData.error } : {}),
  };
}
