import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Match Vite's unchanged default 500 kB advisory, measured in emitted bytes.
export const MAX_CHUNK_BYTES = 500_000;

export function checkRendererBundle(report) {
  if (!report || !Array.isArray(report.chunks) || report.chunks.length === 0) {
    throw new Error("Missing emitted chunk inventory; build the target before checking it.");
  }
  for (const chunk of report.chunks) {
    if (
      !chunk ||
      typeof chunk.fileName !== "string" ||
      !Number.isSafeInteger(chunk.bytes) ||
      chunk.bytes < 0
    ) {
      throw new Error("Invalid emitted chunk inventory.");
    }
  }
  return report.chunks.filter((chunk) => chunk.bytes > MAX_CHUNK_BYTES);
}

/** A temporary/stale report must never stand in for the artifacts being shipped. */
export function verifyRendererBundleArtifacts(report, { target, outputDirectory }) {
  if (report.target !== target) throw new Error("Bundle report target does not match.");
  if (path.resolve(report.outputDirectory ?? "") !== path.resolve(outputDirectory)) {
    throw new Error("Bundle report output directory does not match the build target.");
  }
  const expected = new Map();
  for (const entry of [
    ...report.chunks,
    ...(report.javascriptAssets ?? []),
    ...(report.publicScripts ?? []),
  ]) {
    if (expected.has(entry.fileName))
      throw new Error(`Duplicate script in inventory: ${entry.fileName}`);
    const file = path.resolve(outputDirectory, entry.fileName);
    if (!file.startsWith(path.resolve(outputDirectory) + path.sep))
      throw new Error("Invalid script path in inventory.");
    expected.set(entry.fileName, entry);
  }
  const actual = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) actual.push(file);
    }
  };
  walk(outputDirectory);
  if (actual.length !== expected.size)
    throw new Error("Emitted script inventory is incomplete or stale.");
  for (const file of actual) {
    const name = path.relative(outputDirectory, file).split(path.sep).join("/");
    const entry = expected.get(name);
    if (!entry) throw new Error(`Unlisted emitted script: ${name}`);
    const source = readFileSync(file);
    if (
      entry.bytes !== source.byteLength ||
      entry.sha256 !== createHash("sha256").update(source).digest("hex")
    ) {
      throw new Error(`Emitted script differs from its bundle report: ${name}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    let failed = false;
    for (const target of process.argv.slice(2).length
      ? process.argv.slice(2)
      : ["renderer", "web"]) {
      if (!["renderer", "web"].includes(target)) throw new Error(`Unknown target: ${target}`);
      const report = JSON.parse(
        readFileSync(new URL(`../../tmp/qa/bundle-build-${target}.json`, import.meta.url), "utf8"),
      );
      const oversized = checkRendererBundle(report);
      verifyRendererBundleArtifacts(report, {
        target,
        outputDirectory: path.resolve(import.meta.dirname, `../../dist/${target}`),
      });
      if (oversized.length) {
        failed = true;
        console.error(`[bundle-size] ${target}: ${oversized.length} chunks exceed 500 kB`);
        for (const chunk of oversized) console.error(`  ${chunk.fileName}: ${chunk.bytes} bytes`);
      } else {
        const largest = Math.max(...report.chunks.map((chunk) => chunk.bytes));
        console.log(
          `[bundle-size] ${target}: ${report.chunks.length} chunks, largest ${largest} bytes; within 500 kB`,
        );
      }
      for (const asset of report.javascriptAssets ?? []) {
        console.log(
          `[bundle-size] ${target} emitted script asset: ${asset.fileName}, ${asset.bytes} bytes (${asset.gzipBytes} gzip); accounted separately from ESM chunks`,
        );
      }
    }
    if (failed) process.exitCode = 1;
  } catch (error) {
    console.error(`[bundle-size] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
