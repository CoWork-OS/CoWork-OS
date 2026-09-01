import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import { deriveTaskImpactMetrics, selectTaskStatusMetricSlots } from "../task-impact-metrics";

function event(
  id: string,
  seq: number,
  type: TaskEvent["type"],
  payload: Record<string, unknown> = {},
): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp: seq,
    type,
    payload,
    schemaVersion: 2,
    seq,
  };
}

describe("task impact metrics", () => {
  it("uses typed canonical evidence and never parses prose counts", () => {
    const metrics = deriveTaskImpactMetrics({
      events: [
        event("prose", 1, "assistant_message", {
          message: "Reviewed 500 sources and changed 900 files",
        }),
        event("citations", 2, "citations_collected", {
          citations: [
            { url: "https://example.com/a" },
            { url: "https://example.com/a" },
            { url: "https://example.com/b" },
          ],
        }),
        event("artifact", 3, "artifact_created", { path: "report.docx" }),
      ],
      taskStatus: "completed",
    });

    expect(metrics.find((metric) => metric.kind === "sources_collected")?.value).toBe(2);
    expect(metrics.find((metric) => metric.kind === "artifacts_created")?.value).toBe(1);
    expect(metrics.find((metric) => metric.kind === "files_changed")).toBeUndefined();
  });

  it("folds persisted revisions and combines attributable line metrics", () => {
    const metrics = deriveTaskImpactMetrics({
      events: [
        event("impact-1", 1, "task_impact_updated", {
          metrics: [
            {
              id: "task-1:files",
              kind: "files_changed",
              value: 2,
              provenance: "task_mutation_ledger",
              sourceEventIds: ["file-1"],
              revision: 1,
              updatedAt: 1,
            },
          ],
        }),
        event("impact-2", 2, "task_impact_updated", {
          metrics: [
            {
              id: "task-1:files",
              kind: "files_changed",
              value: 3,
              provenance: "task_mutation_ledger",
              sourceEventIds: ["file-1", "file-2"],
              revision: 2,
              updatedAt: 2,
            },
            {
              id: "task-1:added",
              kind: "lines_added",
              value: 40,
              provenance: "task_mutation_ledger",
              sourceEventIds: ["file-1", "file-2"],
              revision: 2,
              updatedAt: 2,
            },
            {
              id: "task-1:removed",
              kind: "lines_removed",
              value: 9,
              provenance: "task_mutation_ledger",
              sourceEventIds: ["file-1", "file-2"],
              revision: 2,
              updatedAt: 2,
            },
          ],
        }),
      ],
    });

    expect(metrics.find((metric) => metric.kind === "files_changed")?.value).toBe(3);
    expect(selectTaskStatusMetricSlots(metrics)).toEqual([
      expect.objectContaining({ label: "3 files" }),
      expect.objectContaining({ label: "+40 −9" }),
    ]);
  });

  it("replaces mutation snapshots so incomplete attribution removes stale line counts", () => {
    const metric = (kind: "files_changed" | "lines_added" | "lines_removed", value: number) => ({
      id: `task-1:mutation:${kind}`,
      kind,
      value,
      provenance: "task_mutation_ledger",
      sourceEventIds: ["file-1"],
      revision: 1,
      updatedAt: 1,
    });
    const metrics = deriveTaskImpactMetrics({
      events: [
        event("complete", 1, "task_impact_updated", {
          replaceProvenance: "task_mutation_ledger",
          metrics: [
            metric("files_changed", 1),
            metric("lines_added", 10),
            metric("lines_removed", 2),
          ],
        }),
        event("incomplete", 2, "task_impact_updated", {
          replaceProvenance: "task_mutation_ledger",
          metrics: [{ ...metric("files_changed", 2), revision: 2, updatedAt: 2 }],
        }),
      ],
    });

    expect(metrics.map((item) => item.kind)).toEqual(["files_changed"]);
    expect(metrics[0]?.value).toBe(2);
  });

  it("sums per-outcome canonical metrics across successful tool results", () => {
    const metrics = deriveTaskImpactMetrics({
      events: [
        event("slides-1", 1, "task_impact_updated", {
          metrics: [
            {
              id: "task-1:slides_created:canonical:tool-1",
              kind: "slides_created",
              value: 4,
              provenance: "canonical_tool_outcome",
              sourceEventIds: ["tool-1"],
              revision: 1,
              updatedAt: 1,
            },
          ],
        }),
        event("slides-2", 2, "task_impact_updated", {
          metrics: [
            {
              id: "task-1:slides_created:canonical:tool-2",
              kind: "slides_created",
              value: 6,
              provenance: "canonical_tool_outcome",
              sourceEventIds: ["tool-2"],
              revision: 2,
              updatedAt: 2,
            },
          ],
        }),
      ],
    });

    expect(metrics.find((item) => item.kind === "slides_created")).toEqual(
      expect.objectContaining({ value: 10, sourceEventIds: ["tool-1", "tool-2"] }),
    );
  });

  it("counts URL evidence references without inspecting snippets or file paths", () => {
    const metrics = deriveTaskImpactMetrics({
      events: [
        event("evidence", 1, "timeline_evidence_attached", {
          evidenceRefs: [
            {
              evidenceId: "one",
              sourceType: "url",
              sourceUrlOrPath: "https://example.com/a",
              snippet: "claims 999 sources",
            },
            {
              evidenceId: "local",
              sourceType: "file",
              sourceUrlOrPath: "/private/report.txt",
            },
          ],
        }),
      ],
      taskStatus: "executing",
    });

    expect(metrics.find((metric) => metric.kind === "sources_collected")?.value).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain("private/report");
  });

  it("does not treat ordinary file mutation timeline events as output artifacts", () => {
    const metrics = deriveTaskImpactMetrics({
      events: [
        {
          ...event("file", 1, "timeline_artifact_emitted", { path: "src/index.ts" }),
          legacyType: "file_modified",
        },
      ],
    });

    expect(metrics.find((metric) => metric.kind === "artifacts_created")).toBeUndefined();
  });
});
