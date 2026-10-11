/** Bounded, volatile evidence for fresh step contexts. Never written to long-term memory. */
export function collectCrossStepEvidence(tool: string, result: Any): Array<[string, string]> {
  const clip = (value: string, limit: number) =>
    value.length > limit
      ? `${value.slice(0, Math.floor(limit * 0.65))}\n[Evidence clipped; retrieve the original result for remaining detail]\n${value.slice(-Math.floor(limit * 0.35))}`
      : value;
  const reports =
    tool === "orchestrate_agents"
      ? result?.results
      : tool === "get_agent_status"
        ? result?.agents
        : tool === "wait_for_agent"
          ? [result]
          : [];
  if (Array.isArray(reports) && reports.length) {
    return reports.flatMap((report) => {
      if (
        typeof report?.task_id !== "string" ||
        typeof report?.result_summary !== "string" ||
        !report.result_summary.trim()
      )
        return [];
      return [
        [
          `agent:${report.task_id}`,
          `Agent ${report.title || report.task_id} (${report.status || "unknown"})\n${clip(report.result_summary, 8000)}${report.error ? `\nReported error: ${clip(String(report.error), 1000)}` : ""}`,
        ] as [string, string],
      ];
    });
  }
  if (tool === "web_search" && Array.isArray(result?.results)) {
    return result.results
      .slice(0, 8)
      .flatMap((row: Any) =>
        typeof row?.url === "string"
          ? [
              [
                `search:${row.url}`,
                `Search excerpt, not a full-page fetch: ${row.url}\n${row.title || ""}\n${clip(String(row.snippet || ""), 3000)}`,
              ] as [string, string],
            ]
          : [],
      );
  }
  if (
    tool === "web_fetch" &&
    typeof result?.url === "string" &&
    typeof result?.content === "string" &&
    result.success !== false
  ) {
    return [
      [
        `url:${result.url}`,
        `Fetched source: ${result.url}\n${result.title || ""}\n${clip(result.content, 12000)}`,
      ],
    ];
  }
  return [];
}

export function formatCrossStepEvidence(entries: Map<string, string> | undefined): string {
  if (!(entries instanceof Map)) return "";
  let remaining = 48000;
  const sections: string[] = [];
  for (const value of Array.from(entries.values()).reverse()) {
    if (remaining <= 0) break;
    sections.push(
      value.length <= remaining ? value : `${value.slice(0, remaining)}\n[Evidence budget reached]`,
    );
    remaining -= value.length;
  }
  return sections.reverse().join("\n\n");
}
