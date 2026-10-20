import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function dockerNpmCommand(filename: string, prefix: string): string[] {
  const line = readFileSync(filename, "utf8")
    .split("\n")
    .find((value) => value.startsWith(`RUN npm ${prefix}`));
  if (!line) throw new Error(`${filename} has no npm ${prefix} preparation step`);
  return line.slice("RUN npm ".length).trim().split(/\s+/);
}

function runNpm(directory: string, args: string[], ignoreScripts: boolean) {
  return spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [...args, "--offline", "--no-audit", "--no-fund"],
    {
      cwd: directory,
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 20_000,
      env: {
        ...process.env,
        npm_config_ignore_scripts: String(ignoreScripts),
        npm_config_cache: path.join(directory, "npm-cache"),
        npm_config_userconfig: path.join(directory, "empty.npmrc"),
      },
    },
  );
}

describe("Docker dependency lifecycle preparation", () => {
  it.each(["Dockerfile", "Dockerfile.node"])(
    "%s installs its manifest-only layer without running the absent root postinstall",
    (filename) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "cowork-docker-install-"));
      try {
        const postinstall = JSON.parse(readFileSync("package.json", "utf8")).scripts.postinstall;
        const manifest = {
          name: "docker-install-fixture",
          version: "1.0.0",
          scripts: { postinstall },
        };
        writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
        writeFileSync(
          path.join(directory, "package-lock.json"),
          JSON.stringify({
            name: manifest.name,
            version: manifest.version,
            lockfileVersion: 3,
            packages: {
              "": { name: manifest.name, version: manifest.version, hasInstallScript: true },
            },
          }),
        );
        writeFileSync(path.join(directory, "empty.npmrc"), "");

        // Exactly like the first COPY layer: the repository script and .npmrc do not exist.
        const result = runNpm(directory, dockerNpmCommand(filename, "ci"), false);

        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("the Node image explicitly prepares both native addons despite the repository script policy", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cowork-docker-native-"));
    try {
      writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({
          name: "docker-native-fixture",
          version: "1.0.0",
          dependencies: { "better-sqlite3": "1.0.0", "node-pty": "1.0.0" },
        }),
      );
      writeFileSync(path.join(directory, "empty.npmrc"), "");
      for (const name of ["better-sqlite3", "node-pty"]) {
        const addon = path.join(directory, "node_modules", name);
        mkdirSync(addon, { recursive: true });
        writeFileSync(
          path.join(addon, "package.json"),
          JSON.stringify({
            name,
            version: "1.0.0",
            scripts: { install: "node install.cjs" },
          }),
        );
        writeFileSync(
          path.join(addon, "install.cjs"),
          'require("node:fs").writeFileSync(require("node:path").join(__dirname, "prepared"), process.versions.modules);',
        );
      }

      const result = runNpm(directory, dockerNpmCommand("Dockerfile.node", "rebuild"), true);

      expect(result.status, result.stdout + result.stderr).toBe(0);
      for (const name of ["better-sqlite3", "node-pty"]) {
        const marker = path.join(directory, "node_modules", name, "prepared");
        expect(existsSync(marker), `${name} install lifecycle was not invoked`).toBe(true);
        expect(readFileSync(marker, "utf8")).toBe(process.versions.modules);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
