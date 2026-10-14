import { describe, it, expect } from "vitest";
import { applicationReadbackPath, summarizeApplicationReadback } from "../application-readback";

describe("application saved-file readback", () => {
  it("ignores other tools, failures and results without a file hash", () => {
    expect(
      summarizeApplicationReadback("read_file", { path: "/a", persisted: { sha256: "x" } }),
    ).toBeNull();
    expect(summarizeApplicationReadback("local_photoshop_read", { success: false })).toBeNull();
    expect(
      summarizeApplicationReadback("local_photoshop_read", { path: "/a", model: {} }),
    ).toBeNull();
  });
  it("uses the input path when the result has none and accepts flat inspect hashes", () => {
    expect(
      applicationReadbackPath(
        "native_application_inspect",
        { sha256: "abc", size: 3 },
        { path: "/w/plan.xlsx" },
      ),
    ).toBe("/w/plan.xlsx");
    expect(
      summarizeApplicationReadback(
        "native_application_inspect",
        { sha256: "abc", size: 3 },
        { path: "/w/plan.xlsx" },
      ),
    ).toContain("sha256=abc, size=3B");
  });
  it("bounds layer listings", () => {
    const layers = Array.from({ length: 45 }, (_, i) => ({ path: [`L${i}`], kind: "raster" }));
    const summary = summarizeApplicationReadback("local_photoshop_read", {
      path: "/w/a.psd",
      model: { width: 10, height: 10, layers },
      persisted: { sha256: "s", size: 1 },
    })!;
    expect(summary).toContain("Layers (45):");
    expect(summary).toContain("(5 more layers omitted)");
    expect(summary).toContain("END SAVED FILE READBACK");
  });
});
