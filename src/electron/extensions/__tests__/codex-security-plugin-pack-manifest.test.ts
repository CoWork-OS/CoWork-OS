import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

import { validateManifest } from "../loader";

const MANIFEST_PATH = path.resolve(
  process.cwd(),
  "resources",
  "plugin-packs",
  "codex-security",
  "cowork.plugin.json",
);

describe("Codex Security plugin pack", () => {
  it("validates the bundled manifest and exposes directory-backed skills", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

    expect(validateManifest(manifest)).toBe(true);
    expect(manifest.name).toBe("codex-security");
    expect(manifest.skillDirectories.map((skill: { id: string }) => skill.id)).toEqual(
      expect.arrayContaining([
        "codex-security:security-scan",
        "codex-security:security-diff-scan",
        "codex-security:deep-security-scan",
        "codex-security:validation",
      ]),
    );
    for (const skill of manifest.skillDirectories as Array<{ path: string }>) {
      expect(
        fs.existsSync(
          path.resolve(path.dirname(MANIFEST_PATH), skill.path, "SKILL.md"),
        ),
      ).toBe(true);
    }
  });
});
