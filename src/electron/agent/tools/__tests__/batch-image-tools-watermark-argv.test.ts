/**
 * The watermark helper shells out to ImageMagick with paths that come from tool
 * arguments, so both its primary call and its ImageMagick 7 fallback must pass
 * argv arrays rather than building a command string. A previous version of the
 * fallback used `exec` with `JSON.stringify`-quoted paths; JSON.stringify is
 * not a shell-quoting function (it leaves `$` and backticks intact, which
 * /bin/sh expands inside double quotes), which made it command injection.
 *
 * This file mocks child_process module-wide, so it is kept separate from
 * batch-image-tools.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  execFile: [] as Array<{ file: string; args: string[] }>,
  exec: [] as string[],
  failBinaries: new Set<string>(),
}));

vi.mock("child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.execFile.push({ file, args });
    if (calls.failBinaries.has(file)) {
      const error = new Error(`spawn ${file} ENOENT`) as Error & { code: string };
      error.code = "ENOENT";
      callback(error, "", "");
      return;
    }
    callback(null, "", "");
  },
  exec: (
    command: string,
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.exec.push(command);
    callback(null, "", "");
  },
}));

const { BatchImageTools } = await import("../batch-image-tools");

describe("BatchImageTools watermark command construction", () => {
  const tempDirs: string[] = [];

  // A filename containing a shell substitution and a backtick pair. Both
  // survive JSON.stringify's double-quoting, so if this ever reaches /bin/sh
  // they would be expanded.
  const INJECTION = "logo$(id)`id`.png";

  function setup(watermarkName: string) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-wm-argv-"));
    tempDirs.push(rootDir);

    const input = path.join(rootDir, "input.png");
    const watermark = path.join(rootDir, watermarkName);
    fs.writeFileSync(input, "image-bytes", "utf8");
    fs.writeFileSync(watermark, "watermark-bytes", "utf8");

    const tools = new BatchImageTools(
      {
        id: "ws-1",
        name: "workspace",
        path: rootDir,
        permissions: { read: true, write: true, allowedPaths: [] },
      } as never,
      { logEvent: () => undefined } as never,
      "task-1",
    );

    return { tools, input, watermark, rootDir };
  }

  beforeEach(() => {
    calls.execFile.length = 0;
    calls.exec.length = 0;
    calls.failBinaries.clear();
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const next = tempDirs.pop();
      if (next) fs.rmSync(next, { recursive: true, force: true });
    }
  });

  it("passes the watermark path as a single argv element to composite", async () => {
    const { tools, input, watermark } = setup(INJECTION);

    await tools.batchProcess({
      inputPaths: [input],
      operations: [{ type: "watermark", watermarkPath: watermark }],
    });

    expect(calls.exec).toEqual([]);
    const composite = calls.execFile.find((call) => call.file === "composite");
    expect(composite).toBeDefined();
    expect(composite!.args).toContain(watermark);
  });

  it("uses argv form for the ImageMagick 7 fallback when composite is missing", async () => {
    const { tools, input, watermark } = setup(INJECTION);
    calls.failBinaries.add("composite");

    await tools.batchProcess({
      inputPaths: [input],
      operations: [{ type: "watermark", watermarkPath: watermark }],
    });

    // No shell was involved at any point.
    expect(calls.exec).toEqual([]);

    const magick = calls.execFile.find((call) => call.file === "magick");
    expect(magick).toBeDefined();
    expect(magick!.args[0]).toBe("composite");
    // The injection payload survives intact as one argument rather than being
    // split, quoted, or expanded.
    expect(magick!.args).toContain(watermark);
    expect(magick!.args.filter((arg) => arg.includes("$(id)"))).toHaveLength(1);
  });

  it("never falls back to a shell, even when both binaries are missing", async () => {
    const { tools, input, watermark } = setup(INJECTION);
    calls.failBinaries.add("composite");
    calls.failBinaries.add("magick");

    await tools.batchProcess({
      inputPaths: [input],
      operations: [{ type: "watermark", watermarkPath: watermark }],
    });

    expect(calls.exec).toEqual([]);
    expect(calls.execFile.map((call) => call.file)).toEqual(["composite", "magick"]);
  });

  it("delivers the path byte-for-byte, with no shell quoting applied", async () => {
    const { tools, input, watermark } = setup(INJECTION);
    calls.failBinaries.add("composite");

    await tools.batchProcess({
      inputPaths: [input],
      operations: [{ type: "watermark", watermarkPath: watermark }],
    });

    const magick = calls.execFile.find((call) => call.file === "magick");
    // Exactly the path — not JSON.stringify's `"..."` wrapping.
    expect(magick!.args).toContain(watermark);
    expect(magick!.args.some((arg) => arg.startsWith('"'))).toBe(false);
  });
});
