import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  readBundle,
  validateManifest,
  validatePackageTarball,
  extractBundleArchive,
  verifyEvidence,
  prepareBundle,
  restoreBundle,
} from "./package-bundle.mjs";

const execFile = promisify(execFileCallback);
const required = [
  "dist/electron/electron/main.js",
  "dist/renderer/index.html",
  "dist/cli/cli/main.js",
  "bin/cowork.js",
  "bin/cowork-cli.js",
  "bin/coworkctl.js",
  "bin/coworkd.js",
  "bin/coworkd-node.js",
  "tsconfig.cli.json",
  "tsconfig.electron.json",
];
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bundle-test-"));
  const root = join(dir, "package");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "cowork-os", version: "1.2.3" }),
  );
  for (const path of required) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), "x");
  }
  const tgz = join(dir, "cowork-os-1.2.3.tgz");
  await execFile("tar", ["-czf", tgz, "-C", dir, "package"]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@cowork-os/cowork-os", version: "1.2.3" }),
  );
  const github = join(dir, "cowork-os-1.2.3-github.tgz");
  await execFile("tar", ["-czf", github, "-C", dir, "package"]);
  return { dir, tgz, github };
}
function manifest(npm, github, overrides = {}) {
  const meta = (file) => {
    const bytes = readFileSync(file);
    return {
      size: bytes.length,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
  };
  return {
    schemaVersion: 1,
    tag: "v1.2.3",
    version: "1.2.3",
    sourceSha: "a".repeat(40),
    sourceRunId: 10,
    sourceRunAttempt: 1,
    packages: [
      {
        id: "npm",
        name: "cowork-os",
        registry: "https://registry.npmjs.org",
        version: "1.2.3",
        filename: "cowork-os-1.2.3.tgz",
        ...meta(npm),
      },
      {
        id: "github",
        name: "@cowork-os/cowork-os",
        registry: "https://npm.pkg.github.com",
        version: "1.2.3",
        filename: "cowork-os-1.2.3-github.tgz",
        ...meta(github),
      },
    ],
    ...overrides,
  };
}

test("readBundle validates a real package tarball and manifest", async () => {
  const { dir, tgz, github } = await fixture();
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(tgz, github)));
    assert.doesNotThrow(() => readBundle(dir, { tag: "v1.2.3", sha: "a".repeat(40) }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects manifest tag, path, and package checksum mismatches", async () => {
  const { dir, tgz, github } = await fixture();
  try {
    assert.throws(
      () => validateManifest(manifest(tgz, github, { tag: "v9.9.9" }), { tag: "v1.2.3" }),
      /tag mismatch/,
    );
    assert.throws(
      () =>
        validateManifest(
          manifest(tgz, github, {
            packages: [
              { ...manifest(tgz, github).packages[0], filename: "../escape.tgz" },
              manifest(tgz, github).packages[1],
            ],
          }),
          { tag: "v1.2.3" },
        ),
      /unsafe/,
    );
    assert.throws(
      () => validatePackageTarball(tgz, { name: "@cowork-os/cowork-os", version: "1.2.3" }),
      /name\/version/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects corrupted package bytes and unsafe outer archive entries", async () => {
  const { dir, tgz, github } = await fixture();
  try {
    const expected = manifest(tgz, github);
    const corrupted = join(dir, "cowork-os-1.2.3.tgz");
    writeFileSync(corrupted, Buffer.concat([readFileSync(tgz), Buffer.from("corrupt")]));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(expected));
    assert.throws(() => readBundle(dir, { tag: "v1.2.3", sha: "a".repeat(40) }), /checksum/);
    const payload = join(dir, "payload");
    mkdirSync(payload);
    writeFileSync(join(payload, "manifest.json"), "{}");
    writeFileSync(join(payload, "extra.tgz"), "x");
    const unsafe = join(dir, "unsafe.tar.gz");
    await execFile("tar", ["-czf", unsafe, "-C", payload, "manifest.json", "extra.tgz"]);
    assert.throws(
      () => extractBundleArchive(unsafe, join(dir, "out")),
      /invalid|manifest|package|unexpected/,
    );
    const links = join(dir, "links");
    mkdirSync(links);
    writeFileSync(join(links, "manifest.json"), "{}");
    const link = join(links, "link.tgz");
    await execFile("ln", ["-s", "manifest.json", link]);
    const linked = join(dir, "linked.tar.gz");
    await execFile("tar", ["-czf", linked, "-C", links, "manifest.json", "link.tgz"]);
    assert.throws(
      () => extractBundleArchive(linked, join(dir, "link-out")),
      /link|special|unexpected/,
    );
    const hard = join(links, "hard.tgz");
    await execFile("ln", [join(links, "manifest.json"), hard]);
    const hardArchive = join(dir, "hard.tar.gz");
    await execFile("tar", ["-czf", hardArchive, "-C", links, "manifest.json", "hard.tgz"]);
    assert.throws(
      () => extractBundleArchive(hardArchive, join(dir, "hard-out")),
      /link|special|unexpected/,
    );
    assert.ok(github);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyEvidence accepts an in-progress origin run with all required jobs successful", async () => {
  const { dir, tgz, github } = await fixture();
  const originalFetch = globalThis.fetch;
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(tgz, github)));
    globalThis.fetch = async (url) => {
      if (String(url).includes("/git/ref/tags/"))
        return new Response(JSON.stringify({ object: { type: "commit", sha: "a".repeat(40) } }), {
          status: 200,
        });
      if (String(url).includes("/releases/tags/"))
        return new Response(
          JSON.stringify({ id: 4, tag_name: "v1.2.3", draft: true, assets: [] }),
          { status: 200 },
        );
      if (String(url).includes("/attempts/1") && !String(url).includes("/jobs"))
        return new Response(
          JSON.stringify({
            head_sha: "a".repeat(40),
            head_branch: "v1.2.3",
            path: ".github/workflows/release.yml",
            event: "push",
            status: "in_progress",
            repository: { full_name: "owner/repo" },
          }),
          { status: 200 },
        );
      return new Response(
        JSON.stringify({
          total_count: 5,
          jobs: [
            "Prepare registry packages",
            "Hardening Release Gate",
            "Release (macos-latest)",
            "Release (windows-latest)",
            "Release Linux server package",
          ].map((name) => ({
            name,
            status: "completed",
            conclusion: "success",
            head_sha: "a".repeat(40),
          })),
        }),
        { status: 200 },
      );
    };
    await assert.doesNotReject(() =>
      verifyEvidence({
        sourceSha: "a".repeat(40),
        tag: "v1.2.3",
        repository: "owner/repo",
        token: "test",
        bundleDir: dir,
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyEvidence rejects a moved tag SHA and failed prerequisite job", async () => {
  const { dir, tgz, github } = await fixture();
  const originalFetch = globalThis.fetch;
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(tgz, github)));
    globalThis.fetch = async (url) => {
      if (String(url).includes("/git/ref/tags/"))
        return new Response(JSON.stringify({ object: { type: "commit", sha: "b".repeat(40) } }), {
          status: 200,
        });
      if (String(url).includes("/releases/tags/"))
        return new Response(
          JSON.stringify({ id: 4, tag_name: "v1.2.3", draft: true, assets: [] }),
          { status: 200 },
        );
      return new Response(
        JSON.stringify(
          String(url).includes("/jobs")
            ? {
                jobs: [
                  {
                    name: "Prepare registry packages",
                    conclusion: "failure",
                    head_sha: "a".repeat(40),
                  },
                ],
              }
            : { head_sha: "b".repeat(40), path: ".github/workflows/release.yml", event: "push" },
        ),
        { status: 200 },
      );
    };
    await assert.rejects(
      () =>
        verifyEvidence({
          sourceSha: "a".repeat(40),
          tag: "v1.2.3",
          repository: "owner/repo",
          token: "test",
          bundleDir: dir,
        }),
      /match|incomplete|tag/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const uploadMode of ["success", "lost response", "conflict matching", "conflict different"]) {
  test(`prepare upload ${uploadMode}: readback and reuse`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bundle-cwd-"));
    const output = mkdtempSync(join(tmpdir(), "bundle-out-"));
    const replay = mkdtempSync(join(tmpdir(), "bundle-replay-"));
    const pkgRoot = join(cwd, "dist");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "cowork-os",
        version: "1.2.3",
        files: ["dist", "bin", "tsconfig.cli.json", "tsconfig.electron.json"],
      }),
    );
    for (const path of required) {
      mkdirSync(join(cwd, path, ".."), { recursive: true });
      writeFileSync(join(cwd, path), "fixture");
    }
    const originalFetch = globalThis.fetch;
    let uploaded;
    let uploadCount = 0;
    let restored;
    const tag = "v1.2.3";
    const sha = "a".repeat(40);
    const assetName = `registry-packages-1.2.3-${sha}.tar.gz`;
    const fetchImpl = async (url, options = {}) => {
      const href = String(url);
      if (href.includes("/git/ref/tags/"))
        return new Response(JSON.stringify({ object: { type: "commit", sha } }), { status: 200 });
      if (href.includes("/releases/tags/"))
        return new Response(
          JSON.stringify({
            id: 7,
            tag_name: tag,
            draft: true,
            upload_url: "https://uploads.github.com/repos/o/r/releases/7/assets{?name,label}",
            assets: uploaded
              ? [{ id: 8, name: assetName, state: "uploaded", size: uploaded.length }]
              : [],
          }),
          { status: 200 },
        );
      if (
        href.startsWith("https://registry.npmjs.org/") ||
        href.startsWith("https://npm.pkg.github.com/")
      )
        return new Response(
          JSON.stringify({
            name: href.includes("npm.pkg") ? "@cowork-os/cowork-os" : "cowork-os",
            versions: {},
          }),
          { status: 200 },
        );
      if (href.includes("/assets/8"))
        return new Response(uploaded, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      if (href.includes("uploads.github.com")) {
        uploadCount++;
        uploaded = Buffer.from(options.body);
        if (uploadMode === "lost response") throw new Error("response lost");
        if (uploadMode === "conflict different") {
          uploaded[0] ^= 1;
          return new Response(null, { status: 422 });
        }
        if (uploadMode === "conflict matching") return new Response(null, { status: 422 });
        return new Response(
          JSON.stringify({ id: 8, name: assetName, state: "uploaded", size: uploaded.length }),
          { status: 201 },
        );
      }
      throw new Error(`unexpected mock URL ${href}`);
    };
    try {
      const prepare = () =>
        prepareBundle({
          cwd,
          outputDir: output,
          tag,
          sourceSha: sha,
          runId: 10,
          attempt: 1,
          repository: "o/r",
          token: "fake",
          npmToken: "fake",
          fetchImpl,
        });
      if (uploadMode === "conflict different") {
        await assert.rejects(prepare, /conflict/);
        return;
      }
      const first = await prepare();
      assert.equal(first.reused, false);
      assert.equal(uploadCount, 1);
      assert.ok(uploaded?.length);
      const second = await prepareBundle({
        cwd: join(cwd, "does-not-exist"),
        outputDir: replay,
        tag,
        sourceSha: sha,
        runId: 10,
        attempt: 1,
        repository: "o/r",
        token: "fake",
        npmToken: "fake",
        fetchImpl,
      });
      assert.equal(second.reused, true);
      assert.equal(uploadCount, 1);
      assert.deepEqual(
        readFileSync(join(replay, "manifest.json")),
        readFileSync(join(output, "manifest.json")),
      );
      restored = mkdtempSync(join(tmpdir(), "bundle-restore-"));
      const result = await restoreBundle({
        tag,
        sourceSha: sha,
        bundleDir: restored,
        repository: "o/r",
        token: "fake",
        npmToken: "fake",
        fetchImpl,
      });
      assert.equal(result.restored, true);
      assert.deepEqual(
        readFileSync(join(restored, "manifest.json")),
        readFileSync(join(output, "manifest.json")),
      );
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
      rmSync(replay, { recursive: true, force: true });
      if (restored) rmSync(restored, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  "later smoke succeeds",
  "later smoke fails",
  "original platform fails",
  "wrong origin tag",
]) {
  test(`recovery evidence: ${scenario}`, async () => {
    const { dir, tgz, github } = await fixture();
    try {
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(tgz, github)));
      const sha = "a".repeat(40);
      const run = {
        head_sha: sha,
        head_branch: scenario === "wrong origin tag" ? "v9.9.9" : "v1.2.3",
        path: ".github/workflows/release.yml",
        event: "push",
        status: "in_progress",
        run_attempt: 2,
        repository: { full_name: "owner/repo" },
      };
      const jobs = (attempt) =>
        [
          "Hardening Release Gate",
          "Release (macos-latest)",
          "Release (windows-latest)",
          "Release Linux server package",
          "Prepare registry packages",
        ].map((name) => ({
          name,
          head_sha: sha,
          status: "completed",
          conclusion:
            (name === "Prepare registry packages" &&
              (attempt === 1 || scenario === "later smoke fails")) ||
            (name === "Hardening Release Gate" &&
              attempt === 1 &&
              scenario === "original platform fails")
              ? "failure"
              : "success",
        }));
      const fetchImpl = async (url) => {
        const href = String(url);
        let body;
        if (href.includes("/git/ref/tags/")) body = { object: { type: "commit", sha } };
        else if (href.includes("/releases/tags/"))
          body = { id: 4, tag_name: "v1.2.3", draft: true, assets: [] };
        else if (href.includes("/jobs?"))
          body = { total_count: 5, jobs: jobs(href.includes("/attempts/1/") ? 1 : 2) };
        else body = run;
        return new Response(JSON.stringify(body));
      };
      const check = () =>
        verifyEvidence({
          sourceSha: sha,
          tag: "v1.2.3",
          repository: "owner/repo",
          token: "fake",
          bundleDir: dir,
          fetchImpl,
        });
      if (scenario === "later smoke succeeds") await assert.doesNotReject(check);
      else await assert.rejects(check, /incomplete|does not match/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("missing bundle permits only authenticated first preparation with both versions absent", async () => {
  const context = {
    tag: "v1.2.3",
    sourceSha: "a".repeat(40),
    repository: "owner/repo",
    token: "fake",
    npmToken: "fake",
  };
  let registryReads = 0;
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/git/ref/tags/"))
      return new Response(JSON.stringify({ object: { type: "commit", sha: context.sourceSha } }));
    if (href.includes("/releases/tags/"))
      return new Response(
        JSON.stringify({ id: 4, tag_name: context.tag, draft: true, assets: [] }),
      );
    registryReads++;
    return new Response(
      JSON.stringify({
        name: href.includes("npm.pkg.github.com") ? "@cowork-os/cowork-os" : "cowork-os",
        versions: {},
      }),
    );
  };
  await assert.rejects(() => restoreBundle({ ...context, fetchImpl }), /not found/);
  await assert.rejects(
    () => restoreBundle({ ...context, fetchImpl, allowMissing: true, runAttempt: 2 }),
    /cannot be rebuilt/,
  );
  assert.equal(registryReads, 0);
  assert.deepEqual(
    await restoreBundle({ ...context, fetchImpl, allowMissing: true, runAttempt: 1 }),
    { restored: false },
  );
  assert.equal(registryReads, 2);
  const denied = async (url) =>
    String(url).includes("api.github.com") ? fetchImpl(url) : new Response(null, { status: 404 });
  await assert.rejects(
    () => restoreBundle({ ...context, fetchImpl: denied, allowMissing: true, runAttempt: 1 }),
    /indeterminate 404/,
  );
});
