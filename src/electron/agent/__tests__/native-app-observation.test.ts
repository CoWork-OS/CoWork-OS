import { describe, it, expect } from "vitest";
import {
  buildNativeActionLedger,
  nativeObservationTarget,
  summarizeNativeObservation,
} from "../native-app-observation";

const log = (payload: Record<string, unknown>) => ({
  payload: { kind: "native_app_attempt", ...payload },
});

describe("native action ledger", () => {
  it("is empty without native attempts", () => {
    expect(buildNativeActionLedger([{ payload: { message: "other" } }])).toBe("");
  });
  it("uses each attempt's final status and flags preservation exceptions and unresolved effects", () => {
    const ledger = buildNativeActionLedger([
      log({ attemptId: "1", status: "dispatching", action: "launch" }),
      log({
        attemptId: "1",
        status: "acknowledged",
        preservation: {
          frontmostUnchanged: false,
          pointerUnchanged: true,
          globalInput: false,
          clipboardUsed: false,
          before: { frontmostPid: 1 },
          after: { frontmostPid: 2 },
        },
      }),
      log({ attemptId: "2", status: "dispatching", action: "set_value", pid: 7, windowId: 8 }),
      log({ attemptId: "2", status: "outcome_unknown", code: "outcome_unknown" }),
      log({ attemptId: "3", status: "dispatching", action: "press", pid: 7, windowId: 8 }),
      log({ attemptId: "3", status: "not_dispatched", code: "user_conflict" }),
    ]);
    expect(ledger).toContain(
      "- launch: acknowledged; frontmost changed by the user from pid 1 to 2, not to the target, pointer unchanged",
    );
    expect(ledger).toContain("- set_value pid=7 window=8: outcome_unknown (outcome_unknown)");
    expect(ledger).toContain("- press pid=7 window=8: not_dispatched (user_conflict)");
    expect(ledger).toContain("untouched: 1; with an exception: 0; unresolved: 1.");
  });
  it("attributes pointer movement to the user only with physical mouse events", () => {
    const moved = (physical: [number, number]) =>
      buildNativeActionLedger([
        log({
          attemptId: "1",
          status: "acknowledged",
          action: "press",
          preservation: {
            frontmostUnchanged: true,
            pointerUnchanged: false,
            globalInput: false,
            clipboardUsed: false,
            before: { frontmostPid: 3, physicalMouseEvents: physical[0] },
            after: { frontmostPid: 3, physicalMouseEvents: physical[1] },
          },
        }),
      ]);
    expect(moved([10, 14])).toContain("pointer moved by the user's physical mouse, not by CoWork");
    expect(moved([10, 14])).toContain("untouched: 1; with an exception: 0");
    expect(moved([10, 10])).toContain("pointer MOVED without physical mouse events");
    expect(moved([10, 10])).toContain("untouched: 0; with an exception: 1");
  });
});

describe("native snapshot observation boundary", () => {
  it("ignores malformed element rows while preserving valid and nonsecure evidence", () => {
    const snapshot = {
      pid: 42,
      windowId: 100,
      snapshotId: "snapshot",
      elements: [
        null,
        "malformed",
        { role: "AXWindow", title: "Workspace" },
        { role: "AXTextField", secure: true, value: "PRIVATE_VALUE" },
        { role: "AXStaticText", value: "Observed text" },
      ],
    };
    expect(nativeObservationTarget("native_app", snapshot)).toEqual({ pid: 42, windowId: 100 });
    const summary = summarizeNativeObservation("native_app", snapshot);
    expect(summary).toContain("Observed text");
    expect(summary).not.toContain("PRIVATE_VALUE");
    expect(summary).not.toContain("malformed");
  });
  it.each([
    null,
    42,
    { pid: "42", windowId: 100 },
    { pid: 42, windowId: 100, snapshotId: "s", elements: [null] },
  ])("rejects invalid snapshot metadata: %s", (result) => {
    expect(nativeObservationTarget("native_app", result)).toBeUndefined();
    expect(summarizeNativeObservation("native_app", result)).toBeNull();
  });
});
