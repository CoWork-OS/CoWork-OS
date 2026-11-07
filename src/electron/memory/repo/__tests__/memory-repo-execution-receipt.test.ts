import { describe, expect, it } from "vitest";
import type {
  TaskVerificationEvidenceBundle,
  VerificationEvidenceEntry,
} from "../../../../shared/types";
import {
  buildMemoryExecutionReceipt,
  MEMORY_EXECUTION_DETAIL_CHARS,
  MEMORY_EXECUTION_MAX_CHECKS,
} from "../memory-repo-execution-receipt";

const passed: VerificationEvidenceEntry = {
  kind: "shell_command",
  ok: true,
  detail: "Verification passed: npm run test:memory",
  capturedAt: 1_800_000_000_000,
};

function build(entries: VerificationEvidenceEntry[]) {
  return buildMemoryExecutionReceipt({
    status: "completed",
    terminalStatus: "ok",
    evidenceBundle: { entries },
  });
}

describe("memory execution receipts", () => {
  it("keeps only scoped runtime observations, without assistant claims or tool output", () => {
    const receipt = build([
      { ...passed, stdout: "assistant claims everything is deployed" } as VerificationEvidenceEntry,
      {
        ...passed,
        kind: "file_exists",
        detail: 'All required files exist (existence only): "report.md"',
      },
      { ...passed, kind: "http_head", detail: "HTTP 200 for https://example.test/health" },
      { ...passed, kind: "none", detail: "No verification criteria matched" },
      { ...passed, kind: "grep_absent", detail: "Pattern not found (good)" },
    ]);
    expect(receipt).toEqual({
      version: 1,
      checks: [
        { kind: passed.kind, detail: passed.detail, capturedAt: passed.capturedAt },
        {
          kind: "file_exists",
          detail: 'All required files exist (existence only): "report.md"',
          capturedAt: passed.capturedAt,
        },
        {
          kind: "http_head",
          detail: "HTTP 200 for https://example.test/health",
          capturedAt: passed.capturedAt,
        },
      ],
    });
  });

  it.each(["FAIL", "PARTIAL", "UNKNOWN"])(
    "rejects final %s verification",
    (verificationVerdict) => {
      expect(
        buildMemoryExecutionReceipt({
          status: "completed",
          terminalStatus: "ok",
          verificationVerdict: verificationVerdict as "FAIL",
          evidenceBundle: { entries: [passed] },
        }),
      ).toBeUndefined();
    },
  );

  it.each(["partial_success", "failed", "needs_user_action"] as const)(
    "rejects final %s completion",
    (terminalStatus) => {
      expect(
        buildMemoryExecutionReceipt({
          status: "completed",
          terminalStatus,
          verificationVerdict: "PASS",
          evidenceBundle: { entries: [passed] },
        }),
      ).toBeUndefined();
    },
  );

  it("rejects unfinished tasks, missing checks, and bundles with failures outside the output cap", () => {
    expect(
      buildMemoryExecutionReceipt({
        status: "executing",
        terminalStatus: "ok",
        evidenceBundle: { entries: [passed] },
      }),
    ).toBeUndefined();
    expect(
      buildMemoryExecutionReceipt({ status: "completed", terminalStatus: "ok" }),
    ).toBeUndefined();
    expect(build([])).toBeUndefined();
    expect(build([{ ...passed, kind: "none" }])).toBeUndefined();
    expect(build([{ ...passed, kind: "grep_absent" }])).toBeUndefined();
    expect(
      build([
        ...Array.from({ length: MEMORY_EXECUTION_MAX_CHECKS }, () => passed),
        { ...passed, ok: false },
      ]),
    ).toBeUndefined();
    expect(
      buildMemoryExecutionReceipt({
        status: "completed",
        terminalStatus: "ok",
        evidenceBundle: { entries: [null] } as unknown as TaskVerificationEvidenceBundle,
      }),
    ).toBeUndefined();
  });

  it("redacts secrets and omits private, no-memory, invalid-time and overlong details", () => {
    const receipt = build([
      {
        ...passed,
        detail: "Verification passed: CHECK_TOKEN=abcdefghijklmnopqrstuvwxyz123456 npm test",
      },
      { ...passed, detail: "Verification passed: <private>secret workflow</private>" },
      { ...passed, detail: "<no-memory>Verification passed: internal check</no-memory>" },
      { ...passed, detail: "x".repeat(MEMORY_EXECUTION_DETAIL_CHARS + 1) },
      { ...passed, capturedAt: Number.NaN },
      { ...passed, capturedAt: 0 },
    ]);
    expect(receipt?.checks).toHaveLength(1);
    expect(receipt?.checks[0].detail).toContain("[REDACTED_SECRET]");
    expect(receipt?.checks[0].detail).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(
      build(Array.from({ length: MEMORY_EXECUTION_MAX_CHECKS + 5 }, () => passed))?.checks,
    ).toHaveLength(MEMORY_EXECUTION_MAX_CHECKS);
  });
});
