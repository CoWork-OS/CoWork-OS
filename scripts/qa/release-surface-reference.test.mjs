import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

function checkReference(t, reference) {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), "cowork-release-surface-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = resolve(directory, "scripts/generate-release-surface-reference.mjs");
  const manifestsDirectory = resolve(directory, "docs/release-surfaces");
  mkdirSync(resolve(directory, "scripts"), { recursive: true });
  mkdirSync(manifestsDirectory, { recursive: true });
  copyFileSync(resolve(root, "scripts/generate-release-surface-reference.mjs"), script);
  writeFileSync(resolve(directory, "package.json"), JSON.stringify({ version: "0.5.54" }));
  for (const manifest of manifests) {
    writeFileSync(
      resolve(manifestsDirectory, manifest.version + ".json"),
      JSON.stringify(manifest),
    );
  }
  writeFileSync(resolve(directory, "docs/release-surface-reference.md"), reference);
  return spawnSync(process.execPath, [script, "--check"], { cwd: directory, encoding: "utf8" });
}

test("reference freshness check accepts LF and Windows CRLF checkouts", (t) => {
  const reference = renderReleaseSurfaceReference(manifests);
  for (const ending of ["\n", "\r\n"]) {
    const result = checkReference(t, reference.replace(/\n/g, ending));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Release surface reference is current/);
  }
});

test("reference freshness check still rejects stale content with either line ending", (t) => {
  const reference = renderReleaseSurfaceReference(manifests);
  const stale = reference.replace("Smart", "Stale");
  assert.notEqual(stale, reference);
  for (const ending of ["\n", "\r\n"]) {
    const result = checkReference(t, stale.replace(/\n/g, ending));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /release-surface-reference\.md is stale/);
  }
});
