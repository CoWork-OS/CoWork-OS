import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const settingsSource = readFileSync(
  fileURLToPath(new URL("../Settings.tsx", import.meta.url)),
  "utf8",
);
const settingsStyles = readFileSync(
  fileURLToPath(new URL("../settings.css", import.meta.url)),
  "utf8",
);
const normalizedSettingsSource = settingsSource.replace(/\s+/g, " ");

describe("Jev settings experience", () => {
  it("keeps Jev optional and separate from the chat model", () => {
    expect(normalizedSettingsSource).toContain("Use Jev for automatic agent-team selection");
    expect(normalizedSettingsSource).toContain("not replace your chat model");
    expect(normalizedSettingsSource).toContain("Available in CoWork today");
    expect(normalizedSettingsSource).toContain("Team composition");
    expect(normalizedSettingsSource).toContain("Enable optional JEV harness");
    expect(normalizedSettingsSource).toContain("Contextual tool review");
    expect(normalizedSettingsSource).toContain("Observation never changes permissions");
    expect(normalizedSettingsSource).toContain('<option value="active">Active</option>');
    expect(normalizedSettingsSource).toContain(
      "hard policy, permissions, and security remain authoritative",
    );
  });

  it("makes team selection dependent on the Jev feature toggle", () => {
    expect(normalizedSettingsSource).toContain("disabled={!jevEnabled}");
    expect(normalizedSettingsSource).toContain(
      "Enable Jev decision support to turn on automatic team selection.",
    );
  });

  it("shows an in-context save action and detailed connection metadata", () => {
    expect(normalizedSettingsSource).toContain('className: "jev-settings-save-bar"');
    expect(normalizedSettingsSource).toContain("jevTestResult.model");
    expect(normalizedSettingsSource).toContain("jevTestResult.latencyMs");
    expect(normalizedSettingsSource).toContain(
      "Jev reuses the OpenRouter API key from AI &amp; Models",
    );
    expect(normalizedSettingsSource).not.toContain("API key configured above");
    expect(settingsStyles).toContain(".jev-settings-save-bar");
    expect(settingsStyles).toContain("position: sticky");
  });
});
