import { describe, expect, it } from "vitest";

import { isGitPluginUrl } from "../plugin-store-install";

describe("isGitPluginUrl", () => {
  it("detects git URLs for known git install formats", () => {
    expect(isGitPluginUrl("git@github.com:owner/repo.git")).toBe(true);
    expect(isGitPluginUrl("github:owner/repo")).toBe(true);
    expect(isGitPluginUrl("https://github.com/owner/repo")).toBe(true);
    expect(isGitPluginUrl("https://github.com/owner/repo.git")).toBe(true);
  });

  it("does not misclassify manifest URLs that include github path segments", () => {
    expect(
      isGitPluginUrl("https://raw.githubusercontent.com/org/repo/main/cowork.plugin.json"),
    ).toBe(false);
    expect(
      isGitPluginUrl("https://api.github.com/repos/org/repo/contents/cowork.plugin.json"),
    ).toBe(false);
    expect(
      isGitPluginUrl("https://example.com/api/cowork.github.com/manifest/cowork.plugin.json"),
    ).toBe(false);
  });

  it("returns false for unsupported strings", () => {
    expect(isGitPluginUrl("")).toBe(false);
    expect(isGitPluginUrl("cowork.pack.tar.gz")).toBe(false);
  });
});
