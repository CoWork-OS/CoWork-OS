import { describe, expect, it } from "vitest";
import { normalizeToolOutcome, toToolEnvelopeStatus } from "../tool-outcome";

describe("normalizeToolOutcome", () => {
  it("normalizes successful envelopes and nested results", () => {
    expect(
      normalizeToolOutcome({
        envelope: { status: "success", structuredData: { value: 42 } },
      }),
    ).toMatchObject({ status: "success", success: true, blocked: false });
  });

  it("treats explicit error signals as errors even when a result is present", () => {
    expect(
      normalizeToolOutcome({
        result: { success: true },
        is_error: true,
        error: "transport failed",
      }),
    ).toMatchObject({ status: "error", success: false, error: "transport failed" });
    expect(toToolEnvelopeStatus("unknown")).toBe("error");
  });

  it("recognizes legacy ok:false failure envelopes", () => {
    expect(normalizeToolOutcome({ ok: false, message: "request failed" })).toMatchObject({
      status: "error",
      success: false,
    });
  });

  it("keeps blocked and cancelled outcomes distinct from ordinary errors", () => {
    expect(normalizeToolOutcome({ status: "denied", reason: "policy" })).toMatchObject({
      status: "blocked",
      blocked: true,
      success: false,
    });
    expect(normalizeToolOutcome({ status: "aborted", retryable: true })).toMatchObject({
      status: "cancelled",
      blocked: false,
      success: false,
      retryable: true,
    });
    expect(normalizeToolOutcome({ status: "forbidden" })).toMatchObject({
      status: "blocked",
      blocked: true,
      success: false,
    });
  });

  it("does not treat queued or running envelopes as completed", () => {
    expect(normalizeToolOutcome({ status: "queued", result: { value: 1 } })).toMatchObject({
      status: "unknown",
      success: false,
    });
    expect(
      normalizeToolOutcome({
        envelope: { status: "success" },
        is_error: true,
        error: "late transport failure",
      }),
    ).toMatchObject({ status: "error", success: false });
  });

  it("does not turn a missing result into a success", () => {
    expect(normalizeToolOutcome(undefined)).toMatchObject({
      status: "unknown",
      success: false,
    });
    expect(normalizeToolOutcome({ tool: "write_file", toolUseId: "call-1" })).toMatchObject({
      status: "unknown",
      success: false,
    });
    expect(normalizeToolOutcome(null, new Error("boom"))).toMatchObject({
      status: "error",
      success: false,
    });
  });
});
