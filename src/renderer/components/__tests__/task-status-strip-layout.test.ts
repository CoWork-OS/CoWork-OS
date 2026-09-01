import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("../MainContent/main-content.css", import.meta.url)),
  "utf8",
);
const component = readFileSync(
  fileURLToPath(new URL("../TaskStatusStrip.tsx", import.meta.url)),
  "utf8",
);

describe("TaskStatusStrip rollout and accessibility styles", () => {
  it("progressively hides the second metric and then all optional compact slots", () => {
    expect(css).toMatch(
      /@container \(max-width: 620px\)[\s\S]*\.task-status-strip-metric\.metric-2,[\s\S]*\.task-status-strip-phase\.phase-2\s*\{[\s\S]*display:\s*none/,
    );
    expect(css).toMatch(
      /@container \(max-width: 460px\)[\s\S]*\.task-status-strip-metric,[\s\S]*\.task-status-strip-phase\s*\{[\s\S]*display:\s*none/,
    );
  });

  it("defines reduced-motion, forced-colors, and coarse-pointer behavior", () => {
    expect(css).toMatch(
      /@media \(pointer: coarse\)[\s\S]*\.task-status-strip[\s\S]*min-height:\s*44px/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.task-status-strip-chevron[\s\S]*transition:\s*none/,
    );
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*\.task-status-strip:focus-visible/);
  });

  it("keeps the drawer a semantic, keyboard-addressable disclosure", () => {
    expect(component).toContain("aria-expanded={open}");
    expect(component).toContain('aria-controls="task-status-drawer"');
    expect(component).toContain('event.key !== "Escape"');
    expect(component).toContain("stripRef.current?.focus()");
    expect(component).toMatch(/task-status-strip-shell[\s\S]*onKeyDown=\{handleDrawerKeyDown\}/);
  });

  it("marks a fallback phase by compact-slot position", () => {
    expect(component).toContain(
      "task-status-strip-phase phase-${model.compactMetricSlots.length + 1}",
    );
  });
});
