import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { CustomSkill } from "../../../shared/types";
import lineageIndex from "../bundled-skill-lineage.json";
import { computeSkillManifestDigest, isStaleBundledSnapshot } from "../skill-lineage";

const BUNDLED_DIR = path.join(__dirname, "../../../../resources/skills");

function readBundled(id: string): CustomSkill {
  return JSON.parse(fs.readFileSync(path.join(BUNDLED_DIR, `${id}.json`), "utf-8"));
}

describe("bundled skill lineage", () => {
  it("records the current version of every bundled skill", () => {
    // Same invariant as `build-bundled-skill-lineage.mjs --check`, computed with the
    // runtime digest, so the script and the loader cannot drift apart.
    const skills = (lineageIndex as { skills: Record<string, string[]> }).skills;
    const missing = fs
      .readdirSync(BUNDLED_DIR)
      .filter((file) => file.endsWith(".json") && !file.endsWith(".security.json"))
      .filter((file) => file !== "build-mode.json")
      .map((file) => readBundled(path.basename(file, ".json")))
      .filter(
        (manifest) => !(skills[manifest.id] || []).includes(computeSkillManifestDigest(manifest)),
      );
    expect(missing.map((manifest) => manifest.id)).toEqual([]);
  });

  it("recognises the January sample skill an early app version wrote to the managed folder", () => {
    const legacySample: CustomSkill = {
      id: "code-review",
      name: "Code Review",
      description: "Review code for best practices and potential issues",
      icon: "🔍",
      category: "Development",
      prompt:
        "Please review the code in {{path}} and provide feedback on:\n- Code quality and best practices\n- Potential bugs or issues\n- Performance considerations\n- Security concerns\n- Suggestions for improvement\n\nBe constructive and specific in your feedback.",
      parameters: [
        {
          name: "path",
          type: "string",
          description: "Path to the file or folder to review",
          required: true,
          default: ".",
        },
      ],
      enabled: true,
      filePath: "/profile/cowork-os/skills/code-review.json",
    };

    expect(isStaleBundledSnapshot(legacySample, readBundled("code-review"))).toBe(true);
  });

  it("ignores app-added fields and key order but not content edits", () => {
    const bundled = readBundled("code-review");
    const reordered = Object.fromEntries(Object.entries(bundled).reverse()) as CustomSkill;

    expect(
      isStaleBundledSnapshot(
        { ...reordered, source: "managed", filePath: "/x.json", enabled: false },
        bundled,
      ),
    ).toBe(true);
    expect(
      isStaleBundledSnapshot({ ...bundled, prompt: `${bundled.prompt}\nMine.` }, bundled),
    ).toBe(false);
    expect(isStaleBundledSnapshot({ ...bundled, id: "other" }, bundled)).toBe(false);
  });
});
