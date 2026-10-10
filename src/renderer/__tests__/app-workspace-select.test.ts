import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appPath = fileURLToPath(new URL("../App.tsx", import.meta.url));

describe("App composer folder selection", () => {
  it("does not restore the chosen folder's last task", () => {
    const source = readFileSync(appPath, "utf8");

    const start = source.indexOf("const handleSelectWorkspace = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("setCurrentWorkspace(workspace);", start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    expect(body).toContain("restoredSelectionWorkspaceRef.current = workspace.id;");
    expect(body).toContain("selectionRestorationSettledWorkspaceRef.current = workspace.id;");
  });
});
