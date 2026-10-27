import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("setup completes after optional-dependency recovery replaces its installed directory", () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-setup-replaced-")));
  const pkg = path.join(folder, "package");
  fs.mkdirSync(path.join(pkg, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "node_modules", "electron"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "node_modules", "electron", "package.json"), "{}");
  fs.copyFileSync("scripts/setup.mjs", path.join(pkg, "scripts", "setup.mjs"));
  // Simulate npm reifying the installed tarball: the old cwd disappears and the
  // package is recreated at the same pathname. No real dependency/network setup runs.
  fs.writeFileSync(path.join(pkg, "scripts", "setup_native.mjs"), `
import fs from 'node:fs';
import path from 'node:path';
const cwd = process.cwd();
fs.rmSync(cwd, {recursive:true, force:true});
fs.mkdirSync(path.join(cwd, 'scripts'), {recursive:true});
fs.writeFileSync(path.join(cwd, 'scripts', 'install_git_hooks.mjs'),
  "import fs from 'node:fs'; fs.writeFileSync('hooks-completed', 'ok');");
`);
  try {
    const result = spawnSync(process.execPath, [path.join(pkg, "scripts", "setup.mjs")], {
      cwd: pkg,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /uv_cwd|hooks install failed/);
    assert.equal(fs.readFileSync(path.join(pkg, "hooks-completed"), "utf8"), "ok");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
