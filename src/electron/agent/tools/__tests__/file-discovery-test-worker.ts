// Exercise the actual worker from source, including in tests that run before a build.
import { vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { buildSync } from "esbuild";
const directory = mkdtempSync(path.join(tmpdir(), "cowork-discovery-test-"));
export const workerPath = path.join(directory, "worker.cjs");
buildSync({
  entryPoints: [path.resolve("src/electron/agent/tools/file-discovery-worker.ts")],
  outfile: workerPath,
  platform: "node",
  format: "cjs",
  bundle: true,
  packages: "external",
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
vi.mock("../file-discovery-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../file-discovery-client")>();
  return { ...actual, fileDiscoveryService: new actual.FileDiscoveryService({ workerPath }) };
});
