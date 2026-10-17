import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Unit tests for scripts/install-windows.ps1. The script is dot-sourced with
// COWORK_INSTALL_SOURCE_ONLY=1 so its functions can be exercised on any
// platform with PowerShell 7 (pwsh). Skipped when pwsh is not installed.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "install-windows.ps1");
const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

// Mirrors electron-builder's latest.yml for the NSIS target.
const METADATA = [
  "version: 0.5.60",
  "files:",
  "  - url: CoWork-OS-Setup-0.5.60.exe",
  "    sha512: FILESHA512==",
  "    size: 283565018",
  "path: CoWork-OS-Setup-0.5.60.exe",
  "sha512: TOPLEVELSHA512==",
  "releaseDate: '2026-10-07T23:55:51.393Z'",
  "",
].join("\n");

function pwsh(command, env = {}) {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return result;
}

function sourced(snippet) {
  return pwsh(`. '${script}'\n${snippet}`, { COWORK_INSTALL_SOURCE_ONLY: "1" });
}

function runScript(args, env = {}) {
  return pwsh(`& '${script}' ${args}`, env);
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "install-windows-test-"));
}

test("dot-sourcing the installer does not run it", { skip: !hasPwsh }, () => {
  const result = sourced("Write-Output 'sourced'");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "sourced");
});

test("-Help prints usage", { skip: !hasPwsh }, () => {
  const result = runScript("-Help");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /-NoLaunch/);
});

test("metadata parsing reads top-level keys, not file entries", { skip: !hasPwsh }, () => {
  const dir = tempDir();
  try {
    const metadataPath = join(dir, "latest.yml");
    writeFileSync(metadataPath, METADATA);
    const result = sourced(
      `$m = Read-ReleaseMetadata (Get-Content -Raw '${metadataPath}'); "$($m.Version)|$($m.Path)|$($m.Sha512)"`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "0.5.60|CoWork-OS-Setup-0.5.60.exe|TOPLEVELSHA512==");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metadata with an unexpected installer name is rejected", { skip: !hasPwsh }, () => {
  const result = sourced(
    `Read-ReleaseMetadata "version: 1.0.0\`npath: ../evil.exe\`nsha512: X=="`,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Unexpected installer name/);
});

test("SHA-512 check matches electron-builder's base64 digest", { skip: !hasPwsh }, () => {
  const dir = tempDir();
  try {
    const filePath = join(dir, "CoWork-OS-Setup-0.0.1.exe");
    const bytes = randomBytes(4096);
    writeFileSync(filePath, bytes);
    const expected = createHash("sha512").update(bytes).digest("base64");
    const result = sourced(
      `"$(Test-Sha512 '${filePath}' '${expected}')|$(Test-Sha512 '${filePath}' 'wrong==')"`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "True|False");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release URLs follow the GitHub Releases layout", { skip: !hasPwsh }, () => {
  const result = sourced(
    [
      "Get-MetadataUrl 'CoWork-OS/CoWork-OS' ''",
      "Get-MetadataUrl 'CoWork-OS/CoWork-OS' 'v0.5.60'",
      "Get-InstallerUrl 'CoWork-OS/CoWork-OS' '0.5.60' 'CoWork-OS-Setup-0.5.60.exe'",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    "https://github.com/CoWork-OS/CoWork-OS/releases/latest/download/latest.yml",
    "https://github.com/CoWork-OS/CoWork-OS/releases/download/v0.5.60/latest.yml",
    "https://github.com/CoWork-OS/CoWork-OS/releases/download/v0.5.60/CoWork-OS-Setup-0.5.60.exe",
  ]);
});

test("-DryRun with local metadata prints the plan and installs nothing", { skip: !hasPwsh }, () => {
  const dir = tempDir();
  try {
    const metadataPath = join(dir, "latest.yml");
    writeFileSync(metadataPath, METADATA);
    const result = runScript(`-DryRun -Metadata '${metadataPath}'`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Would install CoWork OS 0\.5\.60 from https:\/\/github\.com\/CoWork-OS\/CoWork-OS\/releases\/download\/v0\.5\.60\/CoWork-OS-Setup-0\.5\.60\.exe/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a version that differs from the metadata stops the install", { skip: !hasPwsh }, () => {
  const dir = tempDir();
  try {
    const metadataPath = join(dir, "latest.yml");
    writeFileSync(metadataPath, METADATA);
    const result = runScript(`-DryRun -Version 0.5.59 -Metadata '${metadataPath}'`);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Asked for 0\.5\.59/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed -Repo is rejected before anything runs", { skip: !hasPwsh }, () => {
  const result = runScript("-Repo nope -DryRun");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /-Repo must look like OWNER\/NAME/);
});

test("the app path comes from DisplayIcon, as the per-user NSIS installer writes it", { skip: !hasPwsh }, () => {
  // Values recorded from a real per-user install of CoWork-OS-Setup-0.5.60.exe
  // (Windows 11 on ARM): no InstallLocation, DisplayIcon with an icon index.
  const result = sourced(
    [
      "$e = [pscustomobject]@{ DisplayName = 'CoWork OS 0.5.60'; DisplayIcon = 'C:\\Users\\demo\\AppData\\Local\\Programs\\cowork-os\\CoWork OS.exe,0' }",
      "Get-ExePathFromUninstallEntry $e",
      "$q = [pscustomobject]@{ DisplayIcon = '\"C:\\Program Files\\CoWork OS\\CoWork OS.exe\"' }",
      "Get-ExePathFromUninstallEntry $q",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    "C:\\Users\\demo\\AppData\\Local\\Programs\\cowork-os\\CoWork OS.exe",
    "C:\\Program Files\\CoWork OS\\CoWork OS.exe",
  ]);
});

test("InstallLocation is used when there is no DisplayIcon", { skip: !hasPwsh }, () => {
  const result = sourced(
    [
      "$e = [pscustomobject]@{ InstallLocation = 'C:\\Apps\\CoWork OS' }",
      "Get-ExePathFromUninstallEntry $e",
      "$none = [pscustomobject]@{ DisplayName = 'CoWork OS' }",
      "if ($null -eq (Get-ExePathFromUninstallEntry $none)) { 'none' }",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  const [fromLocation, empty] = result.stdout.trim().split(/\r?\n/);
  assert.match(fromLocation, /^C:\\Apps\\CoWork OS[\\/]CoWork OS\.exe$/);
  assert.equal(empty, "none");
});
