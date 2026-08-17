import { describe, expect, it } from "vitest";

import {
  evaluateBudgets,
  parseCliArgs,
  parseLogMetrics,
  summarizeValues,
} from "../scripts/qa/profile_electron_task_switch.mjs";

describe("profile_electron_task_switch", () => {
  it("parses profiling flags", () => {
    const options = parseCliArgs(
      [
        "--mode=dev",
        "--switches=3",
        "--start-index=2",
        "--no-build",
        "--budget-profile=dev-fast",
        "--output=/tmp/profile.json",
      ],
      {},
    );

    expect(options).toMatchObject({
      mode: "dev",
      switches: 3,
      startIndex: 2,
      noBuild: true,
      profileMode: "fixture",
      quiet: true,
      budgetProfile: "dev-fast",
      output: "/tmp/profile.json",
    });
  });

  it("requires explicit opt-in for the real user profile", () => {
    expect(parseCliArgs([], {})).toMatchObject({
      profileMode: "fixture",
      quiet: true,
    });
    expect(parseCliArgs(["--real-profile", "--no-quiet"], {})).toMatchObject({
      profileMode: "real",
      quiet: false,
    });
  });

  it("parses deterministic large-session fixture options", () => {
    expect(
      parseCliArgs(
        [
          "--fixture-turn-count=741",
          "--fixture-event-count=15529",
          "--fixture-total-payload-mb=231",
          "--fixture-heavy-event-every=50",
          "--fixture-heavy-event-kb=256",
        ],
        {},
      ),
    ).toMatchObject({
      fixtureTurnCount: 741,
      fixtureEventCount: 15529,
      fixtureTotalPayloadMb: 231,
      fixtureHeavyEventEvery: 50,
      fixtureHeavyEventKb: 256,
    });
  });

  it("summarizes p95 with the same nearest-rank convention as perf logs", () => {
    expect(summarizeValues([5, 10, 20, 100])).toMatchObject({
      n: 4,
      p50: 10,
      p95: 100,
      max: 100,
    });
  });

  it("reports budget failures for slow switches and early background work", () => {
    const report = {
      startup: {
        appShellReadyMs: 500,
        sidebarReadyMs: 900,
        backgroundBeforeSidebar: [{ source: "electron", line: "MailboxService auto sync" }],
      },
      evidence: {
        logCaptureAvailable: true,
        quietMode: false,
      },
      summary: {
        taskSwitch: {
          failed: 1,
          headerReadyMs: summarizeValues([40, 120]),
          timelineDataReceivedMs: summarizeValues([35, 90]),
          timelineFirstRowsReadyMs: summarizeValues([50]),
        },
        renderer: {
          longTaskMs: summarizeValues([40, 95]),
          frameGapMs: summarizeValues([60]),
        },
        ipc: {
          "task:timelinePage": {
            serializedBytes: summarizeValues([1024]),
          },
        },
      },
    };

    const failures = evaluateBudgets(report, {
      taskHeaderReadyP95Ms: 75,
      timelineDataReceivedP95Ms: 75,
      timelineFirstRowsReadyP95Ms: 125,
      longTaskMaxMs: 80,
      frameGapMaxMs: 120,
      appShellReadyMs: 2_000,
      sidebarReadyMs: 4_000,
      timelinePageSerializedP95Bytes: 768 * 1024,
      timelinePageSerializedMaxBytes: 1024 * 1024,
      backgroundBeforeSidebarMax: 0,
    });

    expect(failures).toEqual(
      expect.arrayContaining([
        "1 task switch(es) failed or timed out",
        "task header ready: p95=120.0ms over budget 75ms",
        "timeline data received: p95=90.0ms over budget 75ms",
        "renderer long task: max=95.0ms over budget 80ms",
        "background work before sidebar_ready: 1 line(s) over budget 0",
      ]),
    );
  });

  it("fails budgets when attach mode has no log-derived evidence", () => {
    const failures = evaluateBudgets(
      {
        startup: {
          appShellReadyMs: 100,
          sidebarReadyMs: 200,
          backgroundBeforeSidebar: [],
        },
        evidence: {
          logCaptureAvailable: false,
          quietMode: false,
        },
        summary: {
          taskSwitch: {
            failed: 0,
            headerReadyMs: summarizeValues([10]),
            timelineDataReceivedMs: summarizeValues([20]),
            timelineFirstRowsReadyMs: summarizeValues([30]),
          },
          renderer: {
            longTaskMs: summarizeValues([]),
            frameGapMs: summarizeValues([]),
          },
          ipc: {},
        },
      },
      {
        taskHeaderReadyP95Ms: 75,
        timelineDataReceivedP95Ms: 75,
        timelineFirstRowsReadyP95Ms: 125,
        longTaskMaxMs: 80,
        frameGapMaxMs: 120,
        appShellReadyMs: 2_000,
        sidebarReadyMs: 4_000,
        timelinePageSerializedP95Bytes: 768 * 1024,
        timelinePageSerializedMaxBytes: 1024 * 1024,
        backgroundBeforeSidebarMax: 0,
      },
    );

    expect(failures).toEqual(
      expect.arrayContaining([
        "timeline page serialized: no IPC samples",
        "background before sidebar_ready: no log evidence",
      ]),
    );
  });

  it("enforces renderer heap growth and virtual feed DOM budgets", () => {
    const failures = evaluateBudgets(
      {
        startup: {
          appShellReadyMs: 100,
          sidebarReadyMs: 200,
          backgroundBeforeSidebar: [],
        },
        evidence: {
          logCaptureAvailable: true,
          quietMode: true,
        },
        summary: {
          taskSwitch: {
            failed: 0,
            headerReadyMs: summarizeValues([10]),
            timelineDataReceivedMs: summarizeValues([20]),
            timelineFirstRowsReadyMs: summarizeValues([30]),
          },
          renderer: {
            longTaskMs: summarizeValues([]),
            frameGapMs: summarizeValues([]),
            heapGrowthBytes: 129 * 1024 * 1024,
            virtualFeedDomNodes: 25,
          },
          ipc: {
            "task:timelinePage": {
              serializedBytes: summarizeValues([1024]),
            },
          },
        },
      },
      {
        taskHeaderReadyP95Ms: 75,
        timelineDataReceivedP95Ms: 75,
        timelineFirstRowsReadyP95Ms: 125,
        longTaskMaxMs: 80,
        frameGapMaxMs: 120,
        appShellReadyMs: 2_000,
        sidebarReadyMs: 4_000,
        timelinePageSerializedP95Bytes: 768 * 1024,
        timelinePageSerializedMaxBytes: 1024 * 1024,
        rendererHeapGrowthMaxBytes: 128 * 1024 * 1024,
        virtualFeedDomNodesMax: 24,
        backgroundBeforeSidebarMax: 0,
      },
    );

    expect(failures).toEqual(
      expect.arrayContaining([
        "renderer heap growth: 135266304B over budget 134217728B",
        "virtual feed DOM nodes: 25 over budget 24",
      ]),
    );
  });

  it("fails closed when renderer heap measurement is missing", () => {
    const failures = evaluateBudgets(
      {
        startup: {
          appShellReadyMs: 100,
          sidebarReadyMs: 200,
          backgroundBeforeSidebar: [],
        },
        evidence: {
          logCaptureAvailable: true,
          quietMode: true,
        },
        summary: {
          taskSwitch: {
            failed: 0,
            headerReadyMs: summarizeValues([10]),
            timelineDataReceivedMs: summarizeValues([20]),
            timelineFirstRowsReadyMs: summarizeValues([30]),
          },
          renderer: {
            longTaskMs: summarizeValues([]),
            frameGapMs: summarizeValues([]),
            heapGrowthBytes: null,
            virtualFeedDomNodes: 1,
          },
          ipc: {
            "task:timelinePage": {
              serializedBytes: summarizeValues([1024]),
            },
          },
        },
      },
      {
        taskHeaderReadyP95Ms: 75,
        timelineDataReceivedP95Ms: 75,
        timelineFirstRowsReadyP95Ms: 125,
        longTaskMaxMs: 80,
        frameGapMaxMs: 120,
        appShellReadyMs: 2_000,
        sidebarReadyMs: 4_000,
        timelinePageSerializedP95Bytes: 768 * 1024,
        timelinePageSerializedMaxBytes: 1024 * 1024,
        rendererHeapGrowthMaxBytes: 128 * 1024 * 1024,
        virtualFeedDomNodesMax: 24,
        backgroundBeforeSidebarMax: 0,
      },
    );

    expect(failures).toContain("renderer heap growth: missing measurement");
  });

  it("does not count quiet-mode disabled service logs as background work", () => {
    const metrics = parseLogMetrics([
      {
        source: "electron",
        line: "[Main] SubconsciousLoopService initialized (quiet mode; not started)",
      },
      {
        source: "electron",
        line: "[Main] AwarenessService initialized (quiet mode; not started)",
      },
      {
        source: "electron",
        line: "[IPC] [RendererPerf] {\"message\":\"[Startup] sidebar_ready at 200.0ms\"}",
      },
    ]);

    expect(metrics.backgroundBeforeSidebar).toEqual([]);

    const failures = evaluateBudgets(
      {
        startup: {
          appShellReadyMs: 100,
          sidebarReadyMs: 200,
          backgroundBeforeSidebar: [],
        },
        evidence: {
          logCaptureAvailable: true,
          quietMode: true,
        },
        summary: {
          taskSwitch: {
            failed: 0,
            headerReadyMs: summarizeValues([10]),
            timelineDataReceivedMs: summarizeValues([20]),
            timelineFirstRowsReadyMs: summarizeValues([30]),
          },
          renderer: {
            longTaskMs: summarizeValues([]),
            frameGapMs: summarizeValues([]),
          },
          ipc: {
            "task:timelinePage": {
              serializedBytes: summarizeValues([1024]),
            },
          },
        },
      },
      {
        taskHeaderReadyP95Ms: 75,
        timelineDataReceivedP95Ms: 75,
        timelineFirstRowsReadyP95Ms: 125,
        longTaskMaxMs: 80,
        frameGapMaxMs: 120,
        appShellReadyMs: 2_000,
        sidebarReadyMs: 4_000,
        timelinePageSerializedP95Bytes: 768 * 1024,
        timelinePageSerializedMaxBytes: 1024 * 1024,
        backgroundBeforeSidebarMax: 0,
      },
    );

    expect(failures).toEqual([]);
  });
});
