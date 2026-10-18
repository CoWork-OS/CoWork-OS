import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkRendererBundle, verifyRendererBundleArtifacts } from "./check-renderer-bundles.mjs";

test("bundle gate rejects an oversized optional chunk as well as an entry", () => {
  const optional = { fileName: "assets/optional.js", bytes: 500_001, isEntry: false };
  assert.deepEqual(checkRendererBundle({ chunks: [optional] }), [optional]);
  assert.deepEqual(checkRendererBundle({ chunks: [{ ...optional, isEntry: true }] }), [
    { ...optional, isEntry: true },
  ]);
});

test("bundle gate accepts the unchanged limit and accounts for separately emitted worker assets", () => {
  assert.deepEqual(
    checkRendererBundle({
      chunks: [{ fileName: "assets/app.js", bytes: 500_000 }],
      javascriptAssets: [{ fileName: "assets/elk-worker.min.js", bytes: 1_594_464 }],
    }),
    [],
  );
});

test("bundle gate cannot pass on a missing or malformed build inventory", () => {
  for (const report of [
    undefined,
    {},
    { chunks: [] },
    { chunks: [{ fileName: "broken", bytes: NaN }] },
    { chunks: [{ fileName: "broken", bytes: -1 }] },
  ]) {
    assert.throws(() => checkRendererBundle(report), /inventory/);
  }
});

function fixture(t) {
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "cowork-bundle-gate-"));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  const source = "console.log('fixture');";
  writeFileSync(path.join(outputDirectory, "app.js"), source);
  const report = {
    target: "renderer",
    outputDirectory,
    chunks: [
      {
        fileName: "app.js",
        bytes: Buffer.byteLength(source),
        sha256: createHash("sha256").update(source).digest("hex"),
      },
    ],
    javascriptAssets: [],
    publicScripts: [],
  };
  return { report, options: { target: "renderer", outputDirectory } };
}

test("artifact gate accepts a report bound to the actual output", (t) => {
  const { report, options } = fixture(t);
  assert.doesNotThrow(() => verifyRendererBundleArtifacts(report, options));
});

test("artifact gate rejects another target or a temporary analysis output", (t) => {
  const { report, options } = fixture(t);
  assert.throws(
    () => verifyRendererBundleArtifacts({ ...report, target: "web" }, options),
    /target/,
  );
  assert.throws(
    () =>
      verifyRendererBundleArtifacts(
        { ...report, outputDirectory: path.join(options.outputDirectory, "analysis") },
        options,
      ),
    /output directory/,
  );
});

test("artifact gate rejects a mutated script even when its byte count stays the same", (t) => {
  const { report, options } = fixture(t);
  writeFileSync(path.join(options.outputDirectory, "app.js"), "console.log('mutated');");
  assert.throws(() => verifyRendererBundleArtifacts(report, options), /differs/);
});

test("artifact gate rejects missing, duplicate, escaping, and unlisted scripts", (t) => {
  const { report, options } = fixture(t);
  assert.throws(
    () =>
      verifyRendererBundleArtifacts(
        { ...report, chunks: [...report.chunks, ...report.chunks] },
        options,
      ),
    /Duplicate/,
  );
  assert.throws(
    () =>
      verifyRendererBundleArtifacts(
        { ...report, chunks: [{ ...report.chunks[0], fileName: "../escape.js" }] },
        options,
      ),
    /Invalid script path/,
  );
  writeFileSync(path.join(options.outputDirectory, "unlisted.js"), "export {}; ");
  assert.throws(() => verifyRendererBundleArtifacts(report, options), /incomplete or stale/);
  rmSync(path.join(options.outputDirectory, "unlisted.js"));
  rmSync(path.join(options.outputDirectory, "app.js"));
  assert.throws(() => verifyRendererBundleArtifacts(report, options), /incomplete or stale/);
});
