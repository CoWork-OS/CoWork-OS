import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ANDROID_BRIDGE } from "../android-bridge";

function run(caseName: string) {
  return JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      [path.join(__dirname, "android-bridge-harness.py")],
      {
        input: JSON.stringify({ bridge: ANDROID_BRIDGE, case: caseName }),
        encoding: "utf8",
        timeout: 10_000,
      },
    ),
  );
}

describe("trusted Android worker guards", () => {
  it("allows caret paint changes only for typing into the same focused native text field", () => {
    const value = run("typing_caret");
    expect(value.observation.typingDigest).toBeTruthy();
    expect(value.result.receipt.status).toBe("completed");
    expect(value.inputCalls).toEqual(["input.text"]);
  });
  it.each([
    "typing_surrounding_change",
    "typing_target_change",
    "typing_focus_lost",
    "typing_text_changed",
    "typing_opaque_change",
    "tap_caret_change",
  ])("refuses changed visual or typing context: %s", (caseName) => {
    const value = run(caseName);
    expect(value.result).toMatchObject({
      notDispatched: true,
      error: expect.stringContaining("stale_snapshot"),
    });
    expect(value.inputCalls).toEqual([]);
  });
  it("refuses changed pixels even when the opaque accessibility tree is unchanged", () => {
    const value = run("changed_pixels");
    expect(value.result).toMatchObject({
      notDispatched: true,
      error: expect.stringContaining("stale_snapshot"),
    });
    expect(value.inputCalls).toEqual([]);
    expect(value.receiptExists).toBe(false);
  });
  it.each(["xml_error", "xml_malformed", "xml_missing_attribute"])(
    "requires handoff when secure-field inspection returns %s",
    (caseName) => {
      const value = run(caseName);
      expect(value.observation).toMatchObject({ securityKnown: false, texts: [], elements: [] });
      expect(value.observation.imageBase64).toBeTruthy();
      expect(value.result).toMatchObject({
        notDispatched: true,
        error: expect.stringContaining("Screen safety unavailable"),
      });
      expect(value.inputCalls).toEqual([]);
    },
  );
  it("returns an approved screenshot when the accessibility tree is busy, without enabling input", () => {
    const value = run("busy");
    expect(value.observation).toMatchObject({
      treeAvailable: false,
      observationWarning: expect.stringContaining("screenshot-only"),
    });
    expect(Buffer.from(value.observation.imageBase64, "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(value.inputCalls).toEqual([]);
  });
  it("still refuses secure screens", () => {
    const value = run("password");
    expect(value.observation).toMatchObject({ secure: true, texts: [], elements: [] });
    expect(value.inputCalls).toEqual([]);
  });
  it("dispatches an unchanged safe screenshot exactly once", () => {
    const value = run("unchanged");
    expect(value.result.receipt.status).toBe("completed");
    expect(value.inputCalls).toEqual(["input.tap"]);
  });
  it("allows an explicitly approved Home command despite changing screen pixels", () => {
    const value = run("home_changed_pixels");
    expect(value.result.receipt.status).toBe("completed");
    expect(value.inputCalls).toEqual(["nav.home"]);
  });
});
