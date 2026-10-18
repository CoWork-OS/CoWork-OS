import { describe, expect, it } from "vitest";
import { deviceMetricLabel } from "../device-metrics";

describe("device health presentation", () => {
  it("distinguishes unavailable health from an observed zero", () => {
    expect(deviceMetricLabel({}, "cpuUsage")).toBe("—");
    expect(deviceMetricLabel({ cpuUsage: 0 }, "cpuUsage")).toBe("0%");
    expect(deviceMetricLabel({ memoryUsage: 42.7 }, "memoryUsage")).toBe("43%");
    expect(deviceMetricLabel({ loadAverage: [1.24, 2, 3] }, "loadAverage")).toBe("1.2");
  });

  it.each([null, "45", NaN, Infinity, -1, {}, []])(
    "rejects malformed remote health samples: %s",
    (value) => {
      expect(deviceMetricLabel({ cpuUsage: value }, "cpuUsage")).toBe("—");
      expect(deviceMetricLabel({ loadAverage: [value] }, "loadAverage")).toBe("—");
    },
  );
});
