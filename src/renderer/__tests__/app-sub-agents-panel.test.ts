import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appPath = fileURLToPath(new URL("../App.tsx", import.meta.url));

describe("App sub-agent panel wiring", () => {
  it("closes other side panels when Agents is clicked so the right panel opens now", () => {
    const source = readFileSync(appPath, "utf8");
    const start = source.indexOf("const viewSubAgents = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("}, [", start));
    expect(body).toContain("setSpreadsheetArtifact(null);");
    expect(body).toContain("setBrowserWorkbench(null);");
    expect(body).toContain("setSpawnedAgentSidebar(null);");
    expect(body).toContain("if (sideChat) onCloseSideChat();");
    expect(body).toContain("onViewSubAgents();");
    expect(source).toContain("onViewSubAgents={viewSubAgents}");
  });

  it("drops a child-event load that finishes after the parent task changed", () => {
    const source = readFileSync(appPath, "utf8");
    const start = source.indexOf("// Load historical events from dispatched child tasks");
    const end = source.indexOf("// Re-load when child tasks change", start);
    const effect = source.slice(start, end);
    expect(effect).toContain("let cancelled = false;");
    expect(effect).toMatch(/getTaskEvents\(child\.id\);\s*if \(cancelled\) return;/);
    expect(effect).toMatch(/return \(\) => \{\s*cancelled = true;/);
  });
});
