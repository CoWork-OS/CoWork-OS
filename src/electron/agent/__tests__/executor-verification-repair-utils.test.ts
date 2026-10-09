import { describe, expect, it } from "vitest";
import {
  decideVerificationRepair,
  extractVerificationFindings,
  isBlockingVerificationVerdict,
  mentionsOfficeArtifact,
} from "../executor-verification-repair-utils";

const base = {
  failureReason: "",
  isFinalVerification: true,
  isRecheckStep: false,
  repairPassesUsed: 0,
  priorRepairAttemptInStep: false,
  budgetAvailable: true,
};

describe("decideVerificationRepair", () => {
  it("repairs a blocking final verification with concrete findings", () => {
    expect(
      decideVerificationRepair({
        ...base,
        verdictText:
          "FAIL_BLOCKING — O PDF tem 3 páginas, não 2; a secção «Decisões em aberto» fica dividida.",
      }),
    ).toEqual({
      repair: true,
      findings: "O PDF tem 3 páginas, não 2; a secção «Decisões em aberto» fica dividida.",
    });
  });

  it("reads the verdict from the recorded step error when the reply is not available", () => {
    const decision = decideVerificationRepair({
      ...base,
      verdictText: "",
      failureReason:
        "Verification failed: FAIL_BLOCKING — The Teams row has no direct source link.",
    });
    expect(decision).toEqual({
      repair: true,
      findings: "The Teams row has no direct source link.",
    });
  });

  it.each([
    ["WARN_NON_BLOCKING — the heading could be larger.", "not_blocking_verdict"],
    ["PENDING_USER_ACTION — confirm the client's legal name.", "not_blocking_verdict"],
    ["The workbook looks incomplete.", "not_blocking_verdict"],
    [
      "FAIL_BLOCKING — The user must provide the client's VAT number.",
      "needs_user_or_external_access",
    ],
    [
      "FAIL_BLOCKING — The vendor page could not be fetched (403 Forbidden).",
      "needs_user_or_external_access",
    ],
    ["FAIL_BLOCKING — Sign-in required to open the shared drive.", "needs_user_or_external_access"],
  ])("does not repair %j", (verdictText, reason) => {
    expect(decideVerificationRepair({ ...base, verdictText })).toEqual({ repair: false, reason });
  });

  it("allows one repair pass per task and none from the re-check step", () => {
    const verdictText = "FAIL_BLOCKING — The PDF has 3 pages.";
    expect(decideVerificationRepair({ ...base, verdictText, repairPassesUsed: 1 })).toEqual({
      repair: false,
      reason: "repair_already_used",
    });
    expect(decideVerificationRepair({ ...base, verdictText, isRecheckStep: true })).toEqual({
      repair: false,
      reason: "recheck_step",
    });
  });

  it("does not repair mid-plan checks, out-of-budget tasks, or empty findings", () => {
    const verdictText = "FAIL_BLOCKING — The PDF has 3 pages.";
    expect(decideVerificationRepair({ ...base, verdictText, isFinalVerification: false })).toEqual({
      repair: false,
      reason: "not_final_verification",
    });
    expect(decideVerificationRepair({ ...base, verdictText, budgetAvailable: false })).toEqual({
      repair: false,
      reason: "budget_exhausted",
    });
    expect(decideVerificationRepair({ ...base, verdictText: "FAIL_BLOCKING" })).toEqual({
      repair: false,
      reason: "no_findings",
    });
  });
});

describe("verification verdict helpers", () => {
  it("recognizes FAIL_BLOCKING in a reply or a step error, including markdown emphasis", () => {
    expect(isBlockingVerificationVerdict("**FAIL_BLOCKING** — missing totals")).toBe(true);
    expect(isBlockingVerificationVerdict("Verification failed: FAIL_BLOCKING: x")).toBe(true);
    expect(isBlockingVerificationVerdict("Verification failed: missing artifact")).toBe(false);
    expect(isBlockingVerificationVerdict("OK")).toBe(false);
  });

  it("strips the protocol token and failure prefix from findings", () => {
    expect(
      extractVerificationFindings("Verification failed: FAIL_BLOCKING: Totals are wrong."),
    ).toBe("Totals are wrong.");
    expect(extractVerificationFindings("**FAIL_BLOCKING** - Totals are wrong.")).toBe(
      "Totals are wrong.",
    );
  });

  it("detects Office and PDF deliverables", () => {
    expect(mentionsOfficeArtifact(["Create Northstar-pilot-costs.xlsx"])).toBe(true);
    expect(mentionsOfficeArtifact(["Save a matching PDF"])).toBe(true);
    expect(mentionsOfficeArtifact(["Write notes.md", undefined])).toBe(false);
  });
});
