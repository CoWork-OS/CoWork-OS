import { describe, expect, it } from "vitest";
import { buildHostPerfSample, startHostPerfMonitor } from "../host-perf-monitor";
import {
  getSqliteInstrumentationSnapshot,
  recordHostOperation,
  resetSqliteInstrumentation,
} from "../../database/sqlite-instrumentation";

describe("buildHostPerfSample", () => {
  it("converts event-loop nanoseconds to milliseconds and reports the SQLite share", () => {
    resetSqliteInstrumentation();
    recordHostOperation("timeline.persist", 5);
    const sqlite = { ...getSqliteInstrumentationSnapshot(), windowMs: 1000, hostMs: 250 };
    const histogram = {
      count: 10,
      percentile: (value: number) => value * 1e6,
      max: 120e6,
      mean: 30e6,
    };

    const sample = buildHostPerfSample(
      "daemon",
      histogram,
      { idle: 400, active: 600, utilization: 0.6 },
      sqlite,
    );

    expect(sample.runtime).toBe("daemon");
    expect(sample.eventLoop).toEqual({
      p50Ms: 50,
      p90Ms: 90,
      p99Ms: 99,
      maxMs: 120,
      meanMs: 30,
      utilization: 0.6,
    });
    expect(sample.sqlite.hostShare).toBe(0.25);
    expect(sample.sqlite.hostOperations["timeline.persist"]?.count).toBe(1);
  });

  it("reports zeros when the event-loop histogram has no samples", () => {
    const sample = buildHostPerfSample(
      "cli",
      { count: 0, percentile: () => Number.NaN, max: 0, mean: Number.NaN },
      { idle: 0, active: 0, utilization: 0 },
      { ...getSqliteInstrumentationSnapshot(), windowMs: 0 },
    );
    expect(sample.eventLoop.p99Ms).toBe(0);
    expect(sample.eventLoop.meanMs).toBe(0);
    expect(sample.sqlite.hostShare).toBe(0);
  });
});

describe("startHostPerfMonitor", () => {
  it("returns the running monitor and stops cleanly", () => {
    const first = startHostPerfMonitor({ runtime: "cli" });
    const second = startHostPerfMonitor({ runtime: "daemon" });
    expect(second).toBe(first);
    first.stop({ flush: false });

    const restarted = startHostPerfMonitor({ runtime: "daemon" });
    expect(restarted).not.toBe(first);
    restarted.stop();
  });
});
