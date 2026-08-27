import { describe, expect, it } from "vitest";

const { buildNpmAllTimeMetric, getNpmFirstPublishedDay, sumNpmDownloadRows } = await import(
  "../scripts/public-adoption-stats-utils.mjs"
);

describe("public adoption npm all-time stats", () => {
  it("sums daily downloads when the range reaches the first published version", () => {
    expect(
      buildNpmAllTimeMetric(
        {
          start: "2026-01-01",
          end: "2026-01-03",
          downloads: [{ downloads: 4 }, { downloads: 7 }, { downloads: 2 }],
        },
        "2026-02-01",
      ),
    ).toMatchObject({ downloads: 13, coverage: "complete" });
  });

  it("does not label a rolling API response as all time", () => {
    expect(
      buildNpmAllTimeMetric(
        { start: "2026-02-01", end: "2026-08-27", downloads: [{ downloads: 42 }] },
        "2025-02-01",
      ),
    ).toMatchObject({ downloads: null, coverage: "partial" });
  });

  it("finds the first version date and safely handles malformed rows", () => {
    expect(
      getNpmFirstPublishedDay({
        time: { created: "2026-02-03T00:00:00Z", modified: "2026-08-27T00:00:00Z", "0.5.1": "2026-02-05T00:00:00Z", "0.5.0": "2026-02-01T00:00:00Z" },
      }),
    ).toBe("2026-02-01");
    expect(sumNpmDownloadRows([{ downloads: 5 }, { downloads: null }, {}, { downloads: 3 }])).toBe(8);
  });
});
