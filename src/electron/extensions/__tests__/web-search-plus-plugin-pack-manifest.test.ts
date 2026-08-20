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
  "web-search-plus",
  "cowork.plugin.json",
);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

describe("Web Search Plus plugin pack", () => {
  it("validates the bundled manifest and preserves upstream attribution", () => {
    const manifest = readManifest();

    expect(validateManifest(manifest)).toBe(true);
    expect(manifest.name).toBe("web-search-plus");
    expect(manifest.license).toBe("MIT");
    expect(manifest.homepage).toBe("https://github.com/robbyczgw-cla/hermes-web-search-plus");
  });

  it("exposes source-grounded research and extraction workflows", () => {
    const manifest = readManifest();
    const skillIds = manifest.skills.map((skill: { id: string }) => skill.id);
    const commands = new Map(
      manifest.slashCommands.map((command: { name: string; skillId: string }) => [
        command.name,
        command.skillId,
      ]),
    );

    expect(skillIds).toEqual(expect.arrayContaining(["web-research-plus", "web-extract-plus"]));
    expect(commands.get("web-research-plus")).toBe("web-research-plus");
    expect(commands.get("web-extract-plus")).toBe("web-extract-plus");
  });
});
