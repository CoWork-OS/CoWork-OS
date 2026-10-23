import { describe, expect, it } from "vitest";
import { NotCheckedLedger } from "../not-checked-ledger";
import { deriveToolCoverage, deriveToolDataAsOf } from "../runtime/tool-outcome";
import { buildToolResultEnvelope } from "../runtime/tool-result-envelope";

describe("tool coverage", () => {
  it("reads partial coverage from the fields tools already return", () => {
    expect(
      deriveToolCoverage("grep", {
        success: true,
        truncated: true,
        truncationReason: "regex time budget exceeded",
      }),
    ).toEqual({ status: "partial", reason: "regex time budget exceeded" });
    expect(deriveToolCoverage("list_directory", { files: [], truncated: true })).toEqual({
      status: "partial",
      reason: "the folder has more entries than were listed",
    });
    expect(deriveToolCoverage("glob", { scanTruncated: true, truncated: true })?.status).toBe(
      "partial",
    );
    expect(
      deriveToolCoverage("web_search", { results: [], metadata: { filteredOutCount: 3 } }),
    ).toEqual({ status: "partial", reason: "3 results were removed by the domain policy" });
    expect(deriveToolCoverage("gmail_search", { next_page_token: "abc" })?.status).toBe("partial");
    expect(
      deriveToolCoverage("mcp_crm_search", { coverage: { status: "unknown", reason: "x" } }),
    ).toEqual({ status: "unknown", reason: "x" });
  });

  it("says complete only when the tool does, and nothing when it does not say", () => {
    expect(deriveToolCoverage("grep", { success: true, truncated: false })).toEqual({
      status: "complete",
    });
    expect(deriveToolCoverage("web_search", { results: [{ url: "x" }] })).toBeUndefined();
    expect(deriveToolCoverage("grep", { success: false, truncated: true })).toBeUndefined();
  });

  it("keeps data time separate from query time", () => {
    expect(deriveToolDataAsOf({ lastModified: "2026-10-01T00:00:00Z" })).toBe(
      Date.parse("2026-10-01T00:00:00Z"),
    );
    expect(deriveToolDataAsOf({ content: "x" })).toBeUndefined();
    const envelope = buildToolResultEnvelope({
      toolUseId: "t",
      toolName: "grep",
      status: "success",
      result: { success: true, truncated: true, modified: "2026-10-01T00:00:00Z" },
    });
    expect(envelope.coverage?.status).toBe("partial");
    expect(envelope.dataAsOf).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(envelope.queriedAt).toEqual(expect.any(Number));
  });
});

describe("Not checked block", () => {
  it("lists a partial search and settles it when the same scope is searched completely", () => {
    const ledger = new NotCheckedLedger();
    ledger.recordCoverage(
      "grep",
      { pattern: "invoice", path: "src" },
      { status: "partial", reason: "results were cut off at the tool's limit" },
    );
    expect(ledger.render()).toBe(
      [
        "Not checked:",
        '- grep for "invoice" in src: results were cut off at the tool\'s limit',
        "A missing result from these checks does not mean the thing is absent.",
      ].join("\n"),
    );
    ledger.recordCoverage("grep", { pattern: "invoice", path: "src" }, { status: "complete" });
    expect(ledger.render()).toBe("");
  });

  it("lists checks the runtime refused to run, bounded", () => {
    const ledger = new NotCheckedLedger();
    ledger.recordBlocked("web_search", { query: "q3 prices" }, "web_search budget exhausted: 8/8.");
    expect(ledger.render()).toContain(
      '- web_search for "q3 prices": not run: web_search budget exhausted: 8/8.',
    );
    for (let index = 0; index < 30; index += 1) {
      ledger.recordCoverage("grep", { pattern: `p${index}` }, { status: "partial", reason: "r" });
    }
    expect(ledger.list()).toHaveLength(20);
    expect(ledger.render()).toContain("- and 14 more");
  });
});
