import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cssPath = fileURLToPath(new URL("../../../styles/index.css", import.meta.url));
const timelineCss = readFileSync(cssPath, "utf8");

describe("StepFeed layout styles", () => {
  it("reserves a dedicated column for the step timestamp", () => {
    expect(timelineCss).toMatch(/\.step-feed-card \.event-header\s*\{[\s\S]*display:\s*grid;/);
    expect(timelineCss).toMatch(
      /\.step-feed-card \.event-header\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/,
    );
    expect(timelineCss).toMatch(/\.step-feed-card \.event-time\s*\{[\s\S]*align-self:\s*start;/);
  });

  it("allows long step titles and details to wrap inside the reserved content area", () => {
    expect(timelineCss).toMatch(/\.step-feed-card \.event-title\s*\{[\s\S]*white-space:\s*normal;/);
    expect(timelineCss).toMatch(/\.step-feed-card \.event-title\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
    expect(timelineCss).toMatch(
      /\.step-feed-card \.event-title > \*,[\s\S]*\.step-feed-card \.event-title > p,[\s\S]*\.step-feed-card \.event-title li\s*\{/,
    );
    expect(timelineCss).toMatch(/\.step-feed-card \.event-details\s*\{[\s\S]*max-width:\s*100%;/);
  });

  it("keeps step cards compact inside expanded action blocks", () => {
    expect(timelineCss).toMatch(/\.action-block-content\s*\{[\s\S]*padding:\s*0 8px 6px;/);
    expect(timelineCss).toMatch(/\.action-block-events\s*\{[\s\S]*margin-top:\s*2px;/);
    expect(timelineCss).toMatch(
      /\.action-block-events > \.step-feed-card\s*\{[\s\S]*padding:\s*2px 0;/,
    );
    expect(timelineCss).toMatch(/\.step-feed-card \.event-details\s*\{[\s\S]*margin-top:\s*4px;/);
    expect(timelineCss).toMatch(/\.step-feed-card \.inline-document-header\s*\{[\s\S]*display:\s*none;/);
    expect(timelineCss).toMatch(/\.step-feed-card \.inline-document-markdown,[\s\S]*\.step-feed-card \.inline-document-content\s*\{[\s\S]*padding:\s*0;/);
    expect(timelineCss).toMatch(/\.step-feed-card \.edit-diff-preview\s*\{[\s\S]*padding:\s*2px 0;/);
  });
});
