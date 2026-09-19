import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainSourcePath = fileURLToPath(new URL("../main.ts", import.meta.url));

describe("main window chrome", () => {
  it("keeps macOS traffic lights in the custom title-bar row", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("trafficLightPosition: { x: 18, y: 18 }");
    expect(source).not.toContain("trafficLightPosition: { x: 18, y: 36 }");
  });
});
