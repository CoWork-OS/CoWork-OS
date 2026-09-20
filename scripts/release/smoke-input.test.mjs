import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { electronPresent } from "../setup.mjs";

test("setup detects hoisted Electron for scoped package installs", () => {
  const directory = mkdtempSync(join(tmpdir(), "cowork-setup-electron-"));
  try {
    const scopedPackage = join(directory, "node_modules", "@cowork-os", "cowork-os");
    const electronPackage = join(directory, "node_modules", "electron");
    mkdirSync(electronPackage, { recursive: true });
    writeFileSync(join(electronPackage, "package.json"), "{}\n");
    assert.equal(electronPresent(scopedPackage), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const name of ["cowork-os", "@cowork-os/cowork-os"]) {
  test(
    `saved ${name} tarball survives a failed install smoke check`,
    { skip: process.platform === "win32" },
    () => {
      const directory = mkdtempSync(join(tmpdir(), "cowork-smoke-input-"));
      try {
        const tarball = join(directory, "retained.tgz");
        const log = join(directory, "npm-calls");
        writeFileSync(tarball, "unchanged retained bytes");
        writeFileSync(
          join(directory, "npm"),
          '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SMOKE_TEST_LOG"\nif [ "$1" = "run" ]; then exit 19; fi\nexit 0\n',
          { mode: 0o755 },
        );
        const env = {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          COWORK_RELEASE_TARBALL: tarball,
          COWORK_RELEASE_PACKAGE_NAME: name,
          SMOKE_TEST_LOG: log,
        };
        delete env.npm_execpath;
        const result = spawnSync(process.execPath, [resolve("scripts/release-smoke-install.mjs")], {
          env,
          encoding: "utf8",
        });
        assert.notEqual(result.status, 0);
        assert.match(
          readFileSync(log, "utf8"),
          new RegExp(`run --prefix node_modules/${name} setup`),
        );
        assert.doesNotMatch(readFileSync(log, "utf8"), /^pack\b/m);
        assert.equal(readFileSync(tarball, "utf8"), "unchanged retained bytes");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}
