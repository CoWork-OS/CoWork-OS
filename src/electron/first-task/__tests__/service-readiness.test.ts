import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

import { checkReleaseBriefRuntime } from "../service";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("sample workspace readiness", () => {
  it("checks bundled inputs and writes in the launch root without leaving a task workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "first-task-ready-"));
    roots.push(root);
    await checkReleaseBriefRuntime(root);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rejects a symlinked launch root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "first-task-ready-"));
    const alias = `${root}-alias`;
    roots.push(root, alias);
    await fs.symlink(root, alias);
    await expect(checkReleaseBriefRuntime(alias)).rejects.toThrow("Temp workspace root must not be a symlink");
  });
});
