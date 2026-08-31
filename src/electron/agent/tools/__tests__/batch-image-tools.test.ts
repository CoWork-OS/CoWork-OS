import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BatchImageTools } from "../batch-image-tools";

describe("BatchImageTools", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const next = tempDirs.pop();
      if (next) {
        fs.rmSync(next, { recursive: true, force: true });
      }
    }
  });

  it("rejects reading input files outside the workspace when no allowed path is configured", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-batch-image-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-batch-image-outside-"));
    tempDirs.push(rootDir, outsideDir);

    const outsideImage = path.join(outsideDir, "outside.png");
    fs.writeFileSync(outsideImage, "not-an-image-but-readable", "utf8");

    const tools = new BatchImageTools(
      {
        id: "ws-1",
        name: "workspace",
        path: rootDir,
        permissions: { read: true, write: true, allowedPaths: [] },
      } as any,
      { logEvent: () => undefined } as any,
      "task-1",
    );

    await expect(
      tools.batchProcess({
        inputPaths: [outsideImage],
        operations: [{ type: "convert", format: "png" }],
      }),
    ).rejects.toThrow("inside the workspace or an approved Allowed Path");
  });

  it("rejects output directories outside the workspace when no allowed path is configured", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-batch-image-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-batch-image-outside-"));
    tempDirs.push(rootDir, outsideDir);

    const insideImage = path.join(rootDir, "inside.png");
    fs.writeFileSync(insideImage, "not-an-image-but-readable", "utf8");

    const tools = new BatchImageTools(
      {
        id: "ws-1",
        name: "workspace",
        path: rootDir,
        permissions: { read: true, write: true, allowedPaths: [] },
      } as any,
      { logEvent: () => undefined } as any,
      "task-1",
    );

    await expect(
      tools.batchProcess({
        inputPaths: [insideImage],
        operations: [{ type: "convert", format: "png" }],
        outputDir: outsideDir,
      }),
    ).rejects.toThrow("Output path must be inside the workspace or an approved Allowed Path");
  });

  it("rejects inputs denied by the active access profile", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-batch-image-"));
    tempDirs.push(rootDir);

    const deniedImage = path.join(rootDir, "private.png");
    fs.writeFileSync(deniedImage, "not-an-image-but-readable", "utf8");

    const tools = new BatchImageTools(
      {
        id: "ws-1",
        name: "workspace",
        path: rootDir,
        permissions: {
          read: true,
          write: true,
          allowedPaths: [],
          accessFilesystemRules: [{ path: deniedImage, access: "deny" }],
        },
      } as any,
      { logEvent: () => undefined } as any,
      "task-1",
    );

    await expect(
      tools.batchProcess({
        inputPaths: [deniedImage],
        operations: [{ type: "convert", format: "png" }],
      }),
    ).rejects.toThrow("denied by the active access profile");
  });
});
