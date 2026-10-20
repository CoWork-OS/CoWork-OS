import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone skill catalog generation", () => {
  it("runs with the supported Node runtime and resolves skills beside its script", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cowork-skill-catalog-"));
    try {
      mkdirSync(path.join(root, "scripts"));
      mkdirSync(path.join(root, "resources", "skills"), { recursive: true });
      const script = path.join(root, "scripts", "generate-skill-catalog.ts");
      copyFileSync("scripts/generate-skill-catalog.ts", script);
      const skill = {
        id: "fixture-skill",
        name: "Fixture skill",
        description: "Catalog fixture",
        metadata: { version: "1.2.3" },
      };
      writeFileSync(
        path.join(root, "resources", "skills", "fixture-skill.json"),
        JSON.stringify(skill),
      );

      // Run from another working directory: authoring paths belong to the script's repository.
      const output = execFileSync(process.execPath, [script], {
        cwd: os.tmpdir(),
        encoding: "utf8",
      });

      expect(output).toContain("Generated catalog with 1 skills");
      const catalog = JSON.parse(readFileSync(path.join(root, "registry", "catalog.json"), "utf8"));
      expect(catalog.skills).toMatchObject([{ id: "fixture-skill", version: "1.2.3" }]);
      expect(
        JSON.parse(
          readFileSync(path.join(root, "registry", "skills", "fixture-skill.json"), "utf8"),
        ),
      ).toEqual(skill);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
