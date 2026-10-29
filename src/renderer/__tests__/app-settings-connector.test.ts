import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appPath = fileURLToPath(new URL("../App.tsx", import.meta.url));

describe("App Settings connector request", () => {
  it("clears the connector a notice opened once Settings is left", () => {
    const source = readFileSync(appPath, "utf8");

    // Settings opens the profile for initialConnector each time it mounts.
    expect(source).toContain("initialConnector={settingsConnector}");
    const leaveSettings = source.match(
      /useEffect\(\(\) => \{\s*if \(currentView !== "settings"\) \{([^}]*)\}\s*\}, \[currentView\]\);/,
    );
    expect(leaveSettings?.[1]).toContain("setSettingsConnector(undefined);");
  });
});
