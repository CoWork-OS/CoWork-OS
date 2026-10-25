import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../MainContent.tsx", import.meta.url)), "utf8");

describe("composer children keyed by the task", () => {
  it("keeps sibling keys unique so the recovery card does not pile up copies", () => {
    // Both render inside the composer's input container. With the same key React kept
    // orphaned copies of the Session recovery card after an interrupted turn resumed.
    expect(source).toContain("key={`session-recovery:${task.id}`}");
    expect(source).toContain("key={`queued-messages:${task.id}`}");
    const composer = source.slice(source.indexOf("className={`input-container"));
    expect(composer.match(/key=\{task\.id\}/g) ?? []).toEqual([]);
  });
});
