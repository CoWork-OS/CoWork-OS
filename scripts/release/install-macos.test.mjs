import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Unit tests for scripts/install-macos.sh. The script is sourced (which skips
// main) so individual functions can be exercised on any platform with bash;
// the end-to-end install against a real ZIP runs in
// scripts/smoke-desktop-artifacts.mjs on macOS.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "install-macos.sh");
const platformSupport = JSON.parse(
  readFileSync(join(repoRoot, "src", "shared", "platform-support.json"), "utf8"),
);

// Mirrors electron-builder's latest-mac.yml, including the top-level sha512
// that must not be attributed to the last file entry.
const METADATA = [
  "version: 0.5.60",
  "minimumSystemVersion: 22.0.0",
  "files:",
  "  - url: CoWork-OS-0.5.60-arm64-mac.zip",
  "    sha512: ZIPSHA512==",
  "    size: 354033818",
  "  - url: CoWork-OS-0.5.60-arm64.dmg",
  "    sha512: DMGSHA512==",
  "    size: 353198158",
  "path: CoWork-OS-0.5.60-arm64-mac.zip",
  "sha512: TOPLEVELSHA512==",
  "releaseDate: '2026-10-07T12:00:00.000Z'",
  "",
].join("\n");

function sourced(snippet, args = [], env = {}) {
  const result = spawnSync("bash", ["-c", `source "$0"\n${snippet}`, script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return result;
}

function runScript(args, env = {}) {
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return result;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "install-macos-test-"));
}

test("sourcing the installer does not run it", () => {
  const result = sourced('printf "sourced"');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "sourced");
});

test("--help prints usage and exits 0", () => {
  const result = runScript(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--install-dir DIR/);
});

test("unknown options are rejected before anything runs", () => {
  const result = runScript(["--bogus"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --bogus/);
});

test("platform constants match src/shared/platform-support.json", () => {
  const result = sourced(
    'printf "%s\\n%s\\n%s\\n" "$MIN_MACOS_MAJOR" "$MIN_MACOS_LABEL" "$LAST_MONTEREY_VERSION"',
  );
  assert.equal(result.status, 0, result.stderr);
  const [major, label, lastMonterey] = result.stdout.split("\n");
  assert.equal(major, platformSupport.macos.minimumProductVersion.split(".")[0]);
  assert.equal(label, platformSupport.macos.minimumLabel);
  assert.equal(lastMonterey, platformSupport.macos.lastMontereyCompatibleVersion);
});

test("check_macos_version accepts supported releases only", () => {
  const cases = [
    ["12.7.6", 1],
    ["13.0", 0],
    ["14.6.1", 0],
    ["26.7", 0],
    ["garbage", 1],
    ["", 1],
  ];
  for (const [version, expected] of cases) {
    const result = sourced('check_macos_version "$1"', [version]);
    assert.equal(result.status, expected, `${JSON.stringify(version)}: ${result.stderr}`);
  }
});

test("parse_metadata selects the arm64 ZIP with its own sha512 and size", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "latest-mac.yml");
    writeFileSync(file, METADATA);
    const result = sourced(
      'parse_metadata "$1" arm64\nprintf "%s|%s|%s|%s" "$MD_VERSION" "$MD_ASSET" "$MD_SHA512" "$MD_SIZE"',
      [file],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "0.5.60|CoWork-OS-0.5.60-arm64-mac.zip|ZIPSHA512==|354033818");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parse_metadata tolerates CRLF, quoted values and asset names with spaces", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "latest-mac.yml");
    writeFileSync(
      file,
      [
        'version: "0.5.19"',
        "files:",
        "  - url: CoWork OS-0.5.19-arm64-mac.zip.blockmap",
        "    sha512: BLOCKMAP==",
        "    size: 10",
        "  - url: CoWork OS-0.5.19-arm64-mac.zip",
        "    sha512: 'ZIP=='",
        "    size: 20",
        "",
      ].join("\r\n"),
    );
    const result = sourced(
      'parse_metadata "$1" arm64\nprintf "%s|%s|%s|%s" "$MD_VERSION" "$MD_ASSET" "$MD_SHA512" "$MD_SIZE"',
      [file],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "0.5.19|CoWork OS-0.5.19-arm64-mac.zip|ZIP==|20");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parse_metadata fails for x64 when only an arm64 ZIP is published", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "latest-mac.yml");
    writeFileSync(file, METADATA);
    const result = sourced('parse_metadata "$1" x64', [file]);
    assert.notEqual(result.status, 0);
    const universal = sourced('parse_metadata "$1" x64\nprintf "%s" "$MD_ASSET"', [
      file.replace("latest-mac.yml", "universal.yml"),
    ]);
    assert.notEqual(universal.status, 0, "missing file must fail");
    writeFileSync(
      join(dir, "universal.yml"),
      "version: 1.0.0\nfiles:\n  - url: CoWork-OS-1.0.0-universal-mac.zip\n    sha512: U==\n    size: 5\n",
    );
    for (const arch of ["arm64", "x64"]) {
      const picked = sourced(`parse_metadata "$1" ${arch}\nprintf "%s" "$MD_ASSET"`, [
        join(dir, "universal.yml"),
      ]);
      assert.equal(picked.status, 0, picked.stderr);
      assert.equal(picked.stdout, "CoWork-OS-1.0.0-universal-mac.zip");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release URLs point at GitHub release downloads", () => {
  const result = sourced(
    [
      'metadata_url ""',
      'metadata_url "0.5.60"',
      'asset_url "0.5.60" "CoWork-OS-0.5.60-arm64-mac.zip"',
      'asset_url "0.5.19" "CoWork OS-0.5.19-arm64-mac.zip"',
      'REPO="example/fork"; metadata_url ""',
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "https://github.com/CoWork-OS/CoWork-OS/releases/latest/download/latest-mac.yml",
    "https://github.com/CoWork-OS/CoWork-OS/releases/download/v0.5.60/latest-mac.yml",
    "https://github.com/CoWork-OS/CoWork-OS/releases/download/v0.5.60/CoWork-OS-0.5.60-arm64-mac.zip",
    "https://github.com/CoWork-OS/CoWork-OS/releases/download/v0.5.19/CoWork.OS-0.5.19-arm64-mac.zip",
    "https://github.com/example/fork/releases/latest/download/latest-mac.yml",
  ]);
});

test("verify_sha512 compares electron-builder's base64 digest", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "artifact.bin");
    const bytes = randomBytes(4096);
    writeFileSync(file, bytes);
    const expected = createHash("sha512").update(bytes).digest("base64");

    const ok = sourced('verify_sha512 "$1" "$2"', [file, `  ${expected}\n`]);
    assert.equal(ok.status, 0, ok.stderr);

    const tampered = sourced('verify_sha512 "$1" "$2"', [file, `X${expected.slice(1)}`]);
    assert.equal(tampered.status, 1);

    const empty = sourced('verify_sha512 "$1" ""', [file]);
    assert.equal(empty.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parse_args reads flags and environment equivalents", () => {
  const flags = sourced(
    'parse_args --version v0.5.60 --install-dir /tmp/apps --repo example/fork --no-launch --yes --dry-run\nprintf "%s|%s|%s|%s|%s|%s" "$REQUESTED_VERSION" "$INSTALL_DIR" "$REPO" "$NO_LAUNCH" "$ASSUME_YES" "$DRY_RUN"',
  );
  assert.equal(flags.status, 0, flags.stderr);
  assert.equal(flags.stdout, "0.5.60|/tmp/apps|example/fork|1|1|1");

  const env = sourced(
    'parse_args\nprintf "%s|%s|%s|%s" "$REQUESTED_VERSION" "$INSTALL_DIR" "$NO_LAUNCH" "$ARCHIVE_PATH"',
    [],
    {
      COWORK_INSTALL_VERSION: "0.5.54",
      COWORK_INSTALL_DIR: "/opt/apps",
      COWORK_INSTALL_NO_LAUNCH: "1",
      COWORK_INSTALL_ARCHIVE: "/downloads/app.zip",
    },
  );
  assert.equal(env.status, 0, env.stderr);
  assert.equal(env.stdout, "0.5.54|/opt/apps|1|/downloads/app.zip");

  const badRepo = sourced("parse_args --repo nonsense");
  assert.equal(badRepo.status, 1);
  assert.match(badRepo.stderr, /--repo must look like OWNER\/NAME/);
});

test("--dry-run with local metadata resolves the release without network", (t) => {
  if (process.platform !== "darwin") {
    t.skip("the installer's preflight only runs on macOS");
    return;
  }
  const dir = tempDir();
  try {
    const file = join(dir, "latest-mac.yml");
    writeFileSync(file, METADATA);
    const result = runScript(
      ["--dry-run", "--metadata", file, "--install-dir", join(dir, "Applications")],
      { COWORK_INSTALL_ARCH: "arm64" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would install CoWork OS 0\.5\.60 \(arm64\)/);
    assert.match(
      result.stdout,
      /https:\/\/github\.com\/CoWork-OS\/CoWork-OS\/releases\/download\/v0\.5\.60\/CoWork-OS-0\.5\.60-arm64-mac\.zip/,
    );
    assert.match(result.stdout, /target: {3}.*\/Applications\/CoWork OS\.app/);

    const intel = runScript(["--dry-run", "--metadata", file], { COWORK_INSTALL_ARCH: "x64" });
    assert.equal(intel.status, 1);
    assert.match(intel.stderr, /no Intel \(x64\) macOS build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
