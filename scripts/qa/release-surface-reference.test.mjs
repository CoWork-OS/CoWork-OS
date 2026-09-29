import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderReleaseSurfaceReference,
  validateReleaseSurfaceManifests,
} from "../generate-release-surface-reference.mjs";

const root = resolve(import.meta.dirname, "../..");
const manifests = ["v0.5.54.json", "unreleased.json"].map((name) =>
  JSON.parse(readFileSync(resolve(root, "docs/release-surfaces", name), "utf8")),
);

test("stable and development manifests preserve release-specific labels and routes", () => {
  assert.deepEqual(validateReleaseSurfaceManifests(manifests, "0.5.54"), []);

  const reference = renderReleaseSurfaceReference(manifests);
  assert.match(
    reference,
    /v0\.5\.54 stable \| Smart \(Do in development\) \/ Chat \(Ask in development\)/,
  );
  assert.match(reference, /Unreleased development \| Ask \/ Do/);
  assert.match(reference, /Standard: Main sidebar > Mission Control/);
  assert.match(reference, /Calm: not available/);
  assert.match(reference, /Calm: More > Mission Control/);
});

test("a package version bump requires a matching stable surface snapshot", () => {
  assert.ok(
    validateReleaseSurfaceManifests(manifests, "0.5.55").some((error) =>
      error.includes("stable manifest for package version v0.5.55"),
    ),
  );
});

test("every release keeps the existing chat and smart runtime values", () => {
  for (const manifest of manifests) {
    assert.deepEqual(manifest.interactionChoices.map((choice) => choice.runtimeValue).sort(), [
      "chat",
      "smart",
    ]);
  }
});
