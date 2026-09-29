import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyWebArtifact } from "../web-artifact";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directoryWithManifest(manifest?: unknown): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cowork-web-artifact-"));
  directories.push(directory);
  writeFileSync(path.join(directory, "index.html"), "<html></html>");
  if (manifest !== undefined) {
    writeFileSync(path.join(directory, "web-manifest.json"), JSON.stringify(manifest));
  }
  return directory;
}

describe("web artifact verification", () => {
  it("accepts a matching browser build with JavaScript", () => {
    const directory = directoryWithManifest({
      apiVersion: 1,
      appVersion: "1.2.3",
      assets: ["assets/index-abc123.js", "assets/index-abc123.css"],
    });
    const assets = path.join(directory, "assets");
    mkdirSync(assets);
    writeFileSync(path.join(assets, "index-abc123.js"), "export {};");
    writeFileSync(path.join(assets, "index-abc123.css"), "body{}");
    expect(() => verifyWebArtifact(directory, "1.2.3")).not.toThrow();
  });

  it("rejects missing, stale, or incomplete browser builds", () => {
    expect(() => verifyWebArtifact(directoryWithManifest(), "1.2.3")).toThrow(
      "manifest is missing or invalid",
    );
    for (const manifest of [
      { apiVersion: 2, appVersion: "1.2.3", assets: ["bundle.js"] },
      { apiVersion: 1, appVersion: "1.2.2", assets: ["bundle.js"] },
      { apiVersion: 1, appVersion: "1.2.3", assets: [] },
    ]) {
      expect(() => verifyWebArtifact(directoryWithManifest(manifest), "1.2.3")).toThrow(
        "does not match",
      );
    }
    expect(() =>
      verifyWebArtifact(
        directoryWithManifest({
          apiVersion: 1,
          appVersion: "1.2.3",
          assets: ["assets/missing.js"],
        }),
        "1.2.3",
      ),
    ).toThrow("missing required assets");
  });
});
