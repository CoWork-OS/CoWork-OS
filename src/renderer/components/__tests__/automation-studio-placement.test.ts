import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");
const settingsSource = readFileSync(
  fileURLToPath(new URL("../Settings.tsx", import.meta.url)),
  "utf8",
);
const studioSource = readFileSync(
  fileURLToPath(new URL("../AutomationStudioPanel.tsx", import.meta.url)),
  "utf8",
);

describe("Automation Studio placement", () => {
  it("mounts Studio as a main-screen destination instead of a Settings panel", () => {
    expect(appSource).toContain('| "automations"');
    expect(appSource).toContain('currentView === "automations"');
    expect(appSource).toContain("<AutomationStudioPanel");
    expect(settingsSource).not.toContain("AutomationStudioPanel");
  });

  it("keeps the enable-disable lifecycle and conditional branches in the main Studio", () => {
    expect(studioSource).toContain("async function deactivateFlow()");
    expect(studioSource).toContain('"Turn off"');
    expect(studioSource).toContain('sourcePort: "false"');
    expect(studioSource).toContain("No branch");
  });
});
