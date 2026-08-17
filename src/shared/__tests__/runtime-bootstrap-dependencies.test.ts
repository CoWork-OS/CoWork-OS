import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packageJsonPath = path.resolve(process.cwd(), "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

describe("runtime bootstrap dependencies", () => {
  it("keeps Electron bootstrap packages in production dependencies", () => {
    expect(packageJson.dependencies?.electron).toBeTruthy();
    expect(packageJson.dependencies?.["@electron/rebuild"]).toBeTruthy();
    expect(packageJson.devDependencies?.electron).toBeUndefined();
  });

  it("keeps the ordinary build independent from the networked Numbat build", () => {
    expect(packageJson.scripts?.build).not.toContain("numbat:build");
    expect(packageJson.scripts?.["build:with-numbat"]).toContain("numbat:build");
    expect(packageJson.scripts?.package).toContain("build:with-numbat");
  });
});
