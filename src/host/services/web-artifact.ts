import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { WEB_API_VERSION } from "../../shared/host-api/contracts";

interface WebArtifactManifest {
  apiVersion?: unknown;
  appVersion?: unknown;
  assets?: unknown;
}

/** Reject a stale or incomplete browser bundle before exposing its routes. */
export function verifyWebArtifact(webDirectory: string, appVersion: string): void {
  let artifact: WebArtifactManifest;
  try {
    artifact = JSON.parse(
      readFileSync(path.join(webDirectory, "web-manifest.json"), "utf8"),
    ) as WebArtifactManifest;
  } catch {
    throw new Error("Browser application build manifest is missing or invalid.");
  }

  if (
    artifact.apiVersion !== WEB_API_VERSION ||
    artifact.appVersion !== appVersion ||
    !Array.isArray(artifact.assets) ||
    artifact.assets.length === 0 ||
    !artifact.assets.some((asset) => typeof asset === "string" && asset.endsWith(".js"))
  ) {
    throw new Error("Browser application build does not match the host protocol and version.");
  }

  try {
    const root = realpathSync(webDirectory);
    if (!statSync(path.join(root, "index.html")).isFile()) throw new Error("Missing index");
    for (const asset of artifact.assets) {
      if (typeof asset !== "string" || !asset.startsWith("assets/")) {
        throw new Error("Invalid asset path");
      }
      const resolved = realpathSync(path.join(root, asset));
      if (!resolved.startsWith(`${root}${path.sep}`) || !statSync(resolved).isFile()) {
        throw new Error("Asset outside browser build");
      }
    }
  } catch {
    throw new Error("Browser application build is missing required assets.");
  }
}
