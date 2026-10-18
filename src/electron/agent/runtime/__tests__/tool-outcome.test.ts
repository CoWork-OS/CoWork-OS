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

  it("reports a timed-out or disconnected write as an unknown outcome, not an error", () => {
    for (const message of [
      "Tool write_file timed out after 30s",
      "socket hang up",
      "MCP transport closed",
    ]) {
      expect(
        normalizeToolOutcome(undefined, new Error(message), { effect: "write" }),
      ).toMatchObject({
        status: "unknown",
        retryable: false,
        reason: expect.stringMatching(/^outcome_unknown/),
      });
    }
    expect(
      normalizeToolOutcome(undefined, new Error("stopped"), { effect: "unknown", aborted: true }),
    ).toMatchObject({ status: "unknown" });
    expect(
      normalizeToolOutcome({ status: "timeout" }, undefined, { effect: "write" }),
    ).toMatchObject({ status: "unknown" });
  });

  it("keeps the old handling for reads and for definite write failures", () => {
    expect(
      normalizeToolOutcome(undefined, new Error("Tool read_file timed out after 30s"), {
        effect: "read",
      }),
    ).toMatchObject({ status: "error" });
    expect(
      normalizeToolOutcome(undefined, new Error("Path is outside the workspace"), {
        effect: "write",
      }),
    ).toMatchObject({ status: "error" });
    expect(normalizeToolOutcome({ status: "timeout" })).toMatchObject({ status: "error" });
  });
});
