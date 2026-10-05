import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  MemoryHealthCheck,
  MemoryHealthReport,
  MemorySourcesReport,
} from "../../../../shared/memory-health-types";
import { MemoryHealthView } from "../MemoryHealthTab";
import { MemorySourcesView } from "../MemorySourcesTab";
import { formatHealthThreshold, formatHealthValue, storeLabel } from "../memory-health-model";

const noop = () => undefined;

function sources(overrides: Partial<MemorySourcesReport> = {}): MemorySourcesReport {
  return {
    generatedAt: 1,
    workspaceId: "ws-1",
    facts: {
      total: 5,
      bySource: [
        { key: "user_stated", workspace: 2, global: 1, contacts: 0 },
        { key: "third_party", workspace: 0, global: 0, contacts: 1 },
        { key: "system", workspace: 0, global: 1, contacts: 0 },
      ],
      byStore: [
        { key: "memory_hub", workspace: 2, global: 1, contacts: 0 },
        { key: "custom_store", workspace: 0, global: 1, contacts: 0 },
      ],
    },
    archive: {
      total: 7,
      private: 1,
      byType: [{ key: "screen_context", count: 1 }],
      byOrigin: [{ key: "chronicle", count: 1 }],
    },
    imports: { archiveRows: 3, facts: 2 },
    chronicle: { enabled: true, archiveRows: 1 },
    supermemory: { enabled: true, connected: false, remoteRefs: 0 },
    knowledgeGraph: {
      entities: 4,
      edges: 2,
      observations: 1,
      byType: [{ key: "person", count: 4 }],
    },
    ...overrides,
  };
}

function check(overrides: Partial<MemoryHealthCheck>): MemoryHealthCheck {
  return {
    id: "archive_telemetry_ratio",
    label: "Archive noise (tool and trace telemetry)",
    status: "pass",
    value: 0.02,
    op: "<=",
    threshold: 0.05,
    unit: "ratio",
    detail: "2 of 100 archive rows are raw tool events or traces.",
    ...overrides,
  };
}

describe("MemorySourcesView", () => {
  it("shows counts per source with explanations and a Show link for filterable sources", () => {
    const html = renderToStaticMarkup(
      <MemorySourcesView
        report={sources()}
        loading={false}
        error={null}
        onRefresh={noop}
        onShowSource={noop}
      />,
    );
    expect(html).toContain("Facts by source");
    expect(html).toContain('data-source="user_stated"');
    expect(html).toContain("You said");
    expect(html).toContain("Facts you told CoWork directly");
    // user_stated and third_party have a list filter; system does not.
    expect((html.match(/>Show</g) ?? []).length).toBe(2);
    expect(html).toContain("Memory Hub");
    expect(html).toContain("custom_store");
    expect(html).toContain("Screen context (Chronicle)");
    expect(html).toContain("3 archive entries, 2 facts");
    expect(html).toContain("On, not connected (no API key)");
    expect(html).toContain("4 entities, 2 relationships, 1 observations");
    expect(html).toContain(">Refresh<");
  });

  it("hides Show without a handler and shows loading and errors", () => {
    const html = renderToStaticMarkup(
      <MemorySourcesView report={sources()} loading={false} error={null} onRefresh={noop} />,
    );
    expect(html).not.toContain(">Show<");
    const loading = renderToStaticMarkup(
      <MemorySourcesView report={null} loading error="Boom" onRefresh={noop} />,
    );
    expect(loading).toContain("Loading sources...");
    expect(loading).toContain("Refreshing...");
    expect(loading).toContain("Boom");
  });
});

describe("MemoryHealthView", () => {
  it("lists checks with status, value and threshold", () => {
    const report: MemoryHealthReport = {
      generatedAt: Date.now(),
      ok: false,
      checks: [
        check({}),
        check({
          id: "stuck_heartbeat_runs",
          label: "Stuck heartbeat runs",
          status: "warn",
          value: 2,
          threshold: 0,
          unit: "count",
        }),
        check({
          id: "orphan_embeddings",
          label: "Orphan embeddings",
          status: "skip",
          value: null,
          threshold: 0,
          unit: "count",
          detail: "Not recorded in this profile yet.",
        }),
      ],
    };
    const html = renderToStaticMarkup(
      <MemoryHealthView report={report} loading={false} error={null} onRefresh={noop} />,
    );
    expect(html).toContain("qa:memory-health");
    expect(html).toContain("1 check needs attention.");
    expect(html).toContain('data-check="stuck_heartbeat_runs" data-status="warn"');
    expect(html).toContain(">WARN<");
    expect(html).toContain(">PASS<");
    expect(html).toContain(">SKIP<");
    expect(html).toContain("2.0%");
    expect(html).toContain("at most 5.0%");
    expect(html).toContain(">Refresh<");
  });

  it("says when every check passes", () => {
    const html = renderToStaticMarkup(
      <MemoryHealthView
        report={{ generatedAt: Date.now(), ok: true, checks: [check({})] }}
        loading={false}
        error={null}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("All checks pass.");
  });
});

describe("memory health model", () => {
  it("formats values and thresholds by unit", () => {
    expect(formatHealthValue(check({ value: null }))).toBe("-");
    expect(formatHealthValue(check({ unit: "mib", value: 12.5 }))).toBe("12.5 MiB");
    expect(formatHealthThreshold(check({ unit: "count", threshold: 25 }))).toBe("at most 25");
    expect(formatHealthThreshold(check({ op: ">=", unit: "count", threshold: 3 }))).toBe(
      "at least 3",
    );
    expect(formatHealthThreshold(check({ op: undefined, threshold: undefined }))).toBe("");
  });

  it("names known producers and passes unknown ones through", () => {
    expect(storeLabel("core_candidate").label).toBe("Task traces");
    expect(storeLabel("something_new")).toEqual({ label: "something_new", explanation: "" });
  });
});
