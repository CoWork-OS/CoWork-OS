import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readConfinedFileSync, writeConfinedFileSync } from "../confined-file";
import {
  pinProjectRoot,
  projectPath,
  writeProjectOutput,
} from "../../../../connectors/comfyui-mcp/src/project-files";
const dirs: string[] = [];

it("rejects output ancestors or the pinned root replaced while a download is pending", async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "comfy-download-")));
  dirs.push(base);
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, "outputs"));
  const getRoot = pinProjectRoot(root);
  const file = projectPath(getRoot(), path.join(root, "outputs/result.png"));
  const downloaded = await Promise.resolve(Buffer.from("image"));
  fs.rmdirSync(path.join(root, "outputs"));
  fs.symlinkSync(outside, path.join(root, "outputs"));
  expect(() => writeProjectOutput(getRoot(), file, downloaded)).toThrow(/symbolic link/);
  expect(fs.readdirSync(outside)).toEqual([]);
  fs.renameSync(root, path.join(base, "old-project"));
  fs.symlinkSync(outside, root);
  expect(getRoot).toThrow(/root changed/);
});
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
it.each(["leaf", "ancestor"])(
  "refuses %s symlinks for confined reads and writes and ComfyUI outputs",
  (kind) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "confined-files-")));
    dirs.push(base);
    const root = path.join(base, "project");
    const outside = path.join(base, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.md"), "outside");
    const relative = kind === "leaf" ? "secret.md" : "linked/secret.md";
    fs.symlinkSync(
      kind === "leaf" ? path.join(outside, "secret.md") : outside,
      path.join(root, kind === "leaf" ? "secret.md" : "linked"),
    );
    expect(() => readConfinedFileSync(root, relative)).toThrow(/symbolic link/);
    expect(() => writeConfinedFileSync(root, relative, "bad")).toThrow(/symbolic link/);
    expect(() => writeProjectOutput(root, path.join(root, relative), Buffer.from("bad"))).toThrow(
      /symbolic link/,
    );
    expect(() => projectPath(root, path.join(root, relative))).toThrow(/symbolic link/);
    expect(fs.readFileSync(path.join(outside, "secret.md"), "utf8")).toBe("outside");
  },
);
it("creates ordinary directories and safely replaces ordinary files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "confined-normal-"));
  dirs.push(root);
  writeConfinedFileSync(root, "docs/notes.md", "first");
  writeConfinedFileSync(root, "docs/notes.md", "second");
  expect(readConfinedFileSync(root, "docs/notes.md")).toBe("second");
  writeProjectOutput(root, path.join(root, "outputs/result.png"), Buffer.from("first"));
  writeProjectOutput(root, path.join(root, "outputs/result.png"), Buffer.from("second"));
  expect(fs.readFileSync(path.join(root, "outputs/result.png"), "utf8")).toBe("second");
  expect(() => writeConfinedFileSync(root, "../escape.md", "bad")).toThrow(/outside/);
});
