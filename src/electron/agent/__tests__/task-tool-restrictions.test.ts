import { describe, it, expect } from "vitest";
import {
  promptDerivedToolRestrictions,
  SCRIPTING_MUTATION_TOOLS,
  taskForbidsScripting,
} from "../task-tool-restrictions";

describe("task-stated tool restrictions", () => {
  it.each([
    "Do not use scripting to make the edit; the change must use native_app UI control.",
    "No scripting may MAKE the edit. Scripting readback is allowed.",
    "Edit the layer without scripting.",
    "Never use any application scripts for this.",
    "don't use AppleScript, just the UI",
    "You must not use ExtendScript.",
  ])("detects a no-scripting restriction: %s", (prompt) => {
    expect(taskForbidsScripting(prompt)).toBe(true);
    expect(promptDerivedToolRestrictions(prompt)).toEqual([...SCRIPTING_MUTATION_TOOLS]);
  });
  it.each([
    "Edit the existing PSD in Photoshop and save revised.psd.",
    "Use AppleScript to rename the Finder window.",
    "Write a deployment script and run it.",
    "Describe the scripting options Photoshop offers.",
  ])("leaves ordinary requests unrestricted: %s", (prompt) => {
    expect(taskForbidsScripting(prompt)).toBe(false);
    expect(promptDerivedToolRestrictions(prompt)).toEqual([]);
  });
  it("keeps read-only readback tools available", () => {
    expect(SCRIPTING_MUTATION_TOOLS).not.toContain("local_photoshop_read");
    expect(SCRIPTING_MUTATION_TOOLS).not.toContain("native_application_inspect");
  });
});
