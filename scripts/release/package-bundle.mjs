#!/usr/bin/env node
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
export const REGISTRIES = {
  npm: "https://registry.npmjs.org",
  github: "https://npm.pkg.github.com",
};
export const PACKAGE_NAMES = { npm: "cowork-os", github: "@cowork-os/cowork-os" };
export const REQUIRED_FILES = [
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

const fail = (message) => {
  throw new Error(message);
};
const sha512 = (data) => createHash("sha512").update(data).digest("base64");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const safeName = (name) =>
  typeof name === "string" &&
  name.length > 0 &&
  !name.includes("\\") &&
  !name.startsWith("/") &&
  !name.includes("..") &&
  /^[A-Za-z0-9._@+-]+$/.test(name);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function validateContext({ tag, sourceSha, repository, token }) {
  if (typeof tag !== "string" || !tag.startsWith("v") || !VERSION.test(tag.slice(1)))
    fail("invalid release tag");
  if (typeof sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(sourceSha))
    fail("invalid release source SHA");
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    fail("invalid GitHub repository");
  if (!token) fail("GH_TOKEN is required");
}

function safeDirectory(directory) {
  if (typeof directory !== "string" || !directory) fail("bundle directory is required");
  mkdirSync(directory, { recursive: true });
  if (!lstatSync(directory).isDirectory()) fail("bundle directory must not be a symlink");
}

function regularFile(file) {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export function validateManifest(manifest, { tag, sha } = {}) {
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.tag !== "string" ||
    !manifest.tag.startsWith("v") ||
    !VERSION.test(manifest.tag.slice(1))
  )
    fail("invalid bundle manifest tag");
  if (tag && manifest.tag !== tag) fail(`bundle tag mismatch: ${manifest.tag} != ${tag}`);
  if (!VERSION.test(manifest.version || "") || manifest.version !== manifest.tag.slice(1))
    fail("invalid bundle version");
  if (!/^[0-9a-f]{40}$/i.test(manifest.sourceSha || "")) fail("invalid bundle source SHA");
  if (sha && manifest.sourceSha.toLowerCase() !== sha.toLowerCase())
    fail("bundle source SHA mismatch");
  if (
    !Number.isSafeInteger(manifest.sourceRunId) ||
    manifest.sourceRunId < 1 ||
    !Number.isSafeInteger(manifest.sourceRunAttempt) ||
    manifest.sourceRunAttempt < 1
  )
    fail("invalid source run metadata");
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== 2)
    fail("bundle must contain two packages");
  const ids = new Set();
  const filenames = new Set();
  for (const pkg of manifest.packages) {
    if (!pkg || !["npm", "github"].includes(pkg.id) || ids.has(pkg.id))
      fail("invalid package identity");
    ids.add(pkg.id);
    if (
      pkg.name !== PACKAGE_NAMES[pkg.id] ||
      pkg.registry !== REGISTRIES[pkg.id] ||
      pkg.version !== manifest.version
    )
      fail("package identity/version mismatch");
    if (!safeName(pkg.filename) || !pkg.filename.endsWith(".tgz") || filenames.has(pkg.filename))
      fail("unsafe or duplicate package filename");
    filenames.add(pkg.filename);
    if (
      !Number.isSafeInteger(pkg.size) ||
      pkg.size <= 0 ||
      typeof pkg.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+=*$/.test(pkg.integrity)
    )
      fail("invalid package metadata");
    const hash = Buffer.from(pkg.integrity.slice(7), "base64");
    if (hash.length !== 64 || hash.toString("base64") !== pkg.integrity.slice(7))
      fail("invalid package integrity");
  }
  return manifest;
}

function tarEntries(file) {
  const stdout = execFileSync("tar", ["-tzf", file], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}
function assertNoArchiveLinks(file) {
  const stdout = execFileSync("tar", ["-tvzf", file], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  for (const line of stdout.split("\n")) {
    const type = line.trimStart()[0];
    if (type && type !== "-" && type !== "d")
      fail(`archive contains link or special file: ${line}`);
  }
}
function validateEntries(entries) {
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.split("/").includes(".."))
      fail(`unsafe archive entry: ${entry}`);
  }
}

export function validatePackageTarball(file, expected) {
  const bytes = readFileSync(file);
  const entries = tarEntries(file);
  validateEntries(entries);
  assertNoArchiveLinks(file);
  const temp = mkdtempSync(join(tmpdir(), "cowork-pkg-"));
  try {
    execFileSync("tar", ["-xzf", file, "-C", temp]);
    const roots = readdirSync(temp);
    if (roots.length !== 1 || roots[0] !== "package")
      fail("package tarball must contain package/ only");
    const root = join(temp, "package");
    const stat = lstatSync(root);
    if (!stat.isDirectory()) fail("package root is not a directory");
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (packageJson.name !== expected.name || packageJson.version !== expected.version)
      fail("package name/version mismatch");
    for (const required of REQUIRED_FILES) {
      const target = join(root, required);
      if (!existsSync(target) || !lstatSync(target).isFile())
        fail(`missing required package file: ${required}`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return { size: bytes.length, integrity: `sha512-${sha512(bytes)}` };
}

export function readBundle(directory, { tag, sha } = {}) {
  if (!directory || !lstatSync(directory).isDirectory()) fail("unsafe bundle directory");
  const manifestPath = join(directory, "manifest.json");
  if (!regularFile(manifestPath)) fail("unsafe bundle manifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifest(manifest, { tag, sha });
  for (const pkg of manifest.packages) {
    const path = join(directory, pkg.filename);
    if (!existsSync(path) || !lstatSync(path).isFile())
      fail(`missing bundle package: ${pkg.filename}`);
    const packageBytes = readFileSync(path);
    const packageIntegrity = `sha512-${sha512(packageBytes)}`;
    if (packageBytes.length !== pkg.size || packageIntegrity !== pkg.integrity)
      fail(`bundle package checksum mismatch: ${pkg.filename}`);
    const check = validatePackageTarball(path, { name: pkg.name, version: manifest.version });
    if (check.size !== pkg.size || check.integrity !== pkg.integrity)
      fail(`bundle package checksum mismatch: ${pkg.filename}`);
  }
  return manifest;
}

export function extractBundleArchive(archive, directory) {
  const entries = tarEntries(archive);
  validateEntries(entries);
  assertNoArchiveLinks(archive);
  if (entries.length !== 3 || new Set(entries).size !== 3 || !entries.includes("manifest.json"))
    fail("unexpected bundle entries");
  for (const e of entries)
    if (!safeName(e) || (e !== "manifest.json" && !e.endsWith(".tgz")))
      fail("unexpected bundle entry");
  safeDirectory(directory);
  if (readdirSync(directory).length) fail("bundle extraction directory must be empty");
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  const manifest = readBundle(directory);
  if (manifest.packages.some((p) => !entries.includes(p.filename)))
    fail("bundle filenames do not match manifest");
  return { directory, manifest };
}
function installBundle(stage, target, manifest) {
  safeDirectory(target);
  for (const name of ["manifest.json", ...manifest.packages.map((p) => p.filename)]) {
    const destination = join(target, name);
    try {
      if (!lstatSync(destination).isFile()) fail("unsafe bundle destination");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    copyFileSync(join(stage, name), destination);
  }
}

function manifestFor(version, sourceSha, runId, attempt, files) {
  return {
    schemaVersion: 1,
    tag: `v${version}`,
    version,
    sourceSha,
    sourceRunId: Number(runId),
    sourceRunAttempt: Number(attempt),
    packages: ["npm", "github"].map((id) => ({
      id,
      name: PACKAGE_NAMES[id],
      registry: REGISTRIES[id],
      version,
      filename: files[id].filename,
      size: files[id].size,
      integrity: files[id].integrity,
    })),
  };
}

async function packPackage(cwd, id, version, destination) {
  const { stdout } = await execFile(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    { cwd, maxBuffer: 4 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout)[0];
  if (!safeName(result?.filename)) fail("npm pack returned an unsafe filename");
  const source = join(destination, result.filename);
  const metadata = validatePackageTarball(source, { name: PACKAGE_NAMES[id], version });
  return { filename: result.filename, ...metadata, path: source };
}

function assetNameFor(tag, sourceSha) {
  return `registry-packages-${tag.slice(1)}-${sourceSha}.tar.gz`;
}

// Never forward the GitHub token to a release asset CDN, even on an initial URL.
async function githubResponse(
  url,
  { token, fetchImpl = globalThis.fetch },
  { method = "GET", body, binary = false } = {},
) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const api = current.origin === "https://api.github.com";
    const upload = current.origin === "https://uploads.github.com";
    const cdn = ["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
      current.hostname,
    );
    if (
      current.protocol !== "https:" ||
      current.username ||
      current.password ||
      current.port ||
      (!api && !upload && !(binary && cdn))
    )
      fail("untrusted GitHub endpoint");
    const headers = { accept: binary ? "application/octet-stream" : "application/vnd.github+json" };
    if (api || upload) headers.authorization = `Bearer ${token}`;
    if (body) headers["content-type"] = "application/gzip";
    let response;
    try {
      response = await fetchImpl(current.href, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      fail("GitHub request failed or timed out");
    }
    if (response.status >= 300 && response.status < 400) {
      if (!binary || method !== "GET" || redirects === 3 || !response.headers.get("location"))
        fail("unexpected GitHub redirect");
      current = new URL(response.headers.get("location"), current);
      continue;
    }
    return response;
  }
  fail("GitHub redirect limit exceeded");
}

async function github(apiPath, context) {
  const response = await githubResponse(`https://api.github.com${apiPath}`, context);
  if (response.status !== 200) fail(`GitHub API returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    fail("malformed GitHub response");
  }
}

async function getRelease(context) {
  validateContext(context);
  const { tag, sourceSha, repository } = context;
  const ref = await github(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, context);
  let object = ref.object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
    if (!/^[a-f0-9]{40}$/.test(object.sha || "")) fail("invalid tag object");
    object = (await github(`/repos/${repository}/git/tags/${object.sha}`, context)).object;
  }
  if (object?.type !== "commit" || object.sha !== sourceSha)
    fail("release tag does not point at RELEASE_SHA");
  const release = await github(
    `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    context,
  );
  if (
    release.tag_name !== tag ||
    !Array.isArray(release.assets) ||
    !Number.isSafeInteger(release.id)
  )
    fail("invalid release metadata");
  return release;
}

async function assetBytes(asset, context) {
  if (!Number.isSafeInteger(asset?.id) || asset.id < 1 || asset.state !== "uploaded")
    fail("bundle asset is incomplete");
  const response = await githubResponse(
    `https://api.github.com/repos/${context.repository}/releases/assets/${asset.id}`,
    context,
    { binary: true },
  );
  if (response.status !== 200) fail(`bundle download returned HTTP ${response.status}`);
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    fail("bundle download failed");
  }
  if (bytes.length !== asset.size) fail("bundle asset size mismatch");
  if (
    asset.digest &&
    asset.digest !== `sha256-${sha256(bytes)}` &&
    asset.digest !== `sha256:${sha256(bytes)}`
  )
    fail("bundle asset digest mismatch");
  return bytes;
}

async function restoreAsset(asset, context, bundleDir) {
  const bytes = await assetBytes(asset, context);
  const temp = mkdtempSync(join(tmpdir(), "cowork-bundle-download-"));
  try {
    const archive = join(temp, "bundle.tar.gz");
    writeFileSync(archive, bytes);
    const stage = join(temp, "stage");
    const result = extractBundleArchive(archive, stage);
    readBundle(stage, { tag: context.tag, sha: context.sourceSha });
    installBundle(stage, bundleDir, result.manifest);
    return result.manifest;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function requireFirstPreparation(release, context, runAttempt, npmToken) {
  if (String(runAttempt) !== "1" || release.draft !== true)
    fail("missing bundle cannot be rebuilt during recovery");
  if (
    release.assets.some((asset) =>
      asset.name?.startsWith(`registry-packages-${context.tag.slice(1)}-`),
    )
  )
    fail("conflicting registry bundle exists");
  if (!npmToken) fail("NPM_TOKEN is required to check first publication");
  const { TARGETS, inspectRegistry } = await import("./registry-publication.mjs");
  for (const target of TARGETS) {
    const state = await inspectRegistry(
      { ...target, version: context.tag.slice(1) },
      {
        token: target.id === "npm" ? npmToken : context.token,
        fetchImpl: context.fetchImpl,
      },
    );
    if (state !== "absent") fail("registry version already exists without a retained bundle");
  }
}

export async function prepareBundle({
  cwd = process.cwd(),
  outputDir = process.env.RELEASE_BUNDLE_DIR,
  tag = process.env.RELEASE_TAG,
  sourceSha = process.env.RELEASE_SHA,
  runId = process.env.GITHUB_RUN_ID,
  attempt = process.env.GITHUB_RUN_ATTEMPT,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN,
  npmToken = process.env.NPM_TOKEN,
  fetchImpl = globalThis.fetch,
} = {}) {
  const context = { tag, sourceSha, repository, token, fetchImpl };
  const release = await getRelease(context);
  const name = assetNameFor(tag, sourceSha);
  const existing = release.assets.find((asset) => asset.name === name);
  if (existing) {
    const manifest = await restoreAsset(existing, context, outputDir);
    return { manifest, reused: true };
  }
  await requireFirstPreparation(release, context, attempt, npmToken);
  if (!Number.isSafeInteger(Number(runId)) || Number(runId) < 1) fail("invalid source run ID");
  const original = readFileSync(join(cwd, "package.json"), "utf8");
  const pkg = JSON.parse(original);
  if (pkg.name !== PACKAGE_NAMES.npm || pkg.version !== tag.slice(1))
    fail("checkout package name/version mismatch");
  const stage = mkdtempSync(join(tmpdir(), "cowork-registry-prepare-"));
  try {
    const files = {};
    try {
      files.npm = await packPackage(cwd, "npm", pkg.version, stage);
      writeFileSync(
        join(cwd, "package.json"),
        `${JSON.stringify({ ...pkg, name: PACKAGE_NAMES.github }, null, 2)}\n`,
      );
      files.github = await packPackage(cwd, "github", pkg.version, stage);
    } finally {
      writeFileSync(join(cwd, "package.json"), original);
    }
    const manifest = manifestFor(pkg.version, sourceSha, runId, attempt, files);
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    readBundle(stage, { tag, sha: sourceSha });
    const archive = join(stage, name);
    await execFile("tar", [
      "-czf",
      archive,
      "-C",
      stage,
      "manifest.json",
      ...manifest.packages.map((p) => p.filename),
    ]);
    const bytes = readFileSync(archive);
    // A lost upload response or duplicate-name race is resolved by exact readback.
    try {
      await githubResponse(
        `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        context,
        { method: "POST", body: bytes },
      );
    } catch {
      /* Readback is authoritative; never overwrite or retry the upload blindly. */
    }
    const after = await getRelease(context);
    const uploaded = after.assets.find((asset) => asset.name === name);
    if (!uploaded) fail("bundle upload did not produce a retained asset");
    const remote = await assetBytes(uploaded, context);
    if (!remote.equals(bytes)) fail("bundle upload conflict: retained bytes differ");
    const restored = await restoreAsset(uploaded, context, outputDir);
    return { manifest: restored, reused: false };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function restoreBundle({
  tag = process.env.RELEASE_TAG,
  sourceSha = process.env.RELEASE_SHA,
  bundleDir = process.env.RELEASE_BUNDLE_DIR,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN,
  npmToken = process.env.NPM_TOKEN,
  allowMissing = false,
  runAttempt = process.env.GITHUB_RUN_ATTEMPT,
  fetchImpl = globalThis.fetch,
} = {}) {
  const context = { tag, sourceSha, repository, token, fetchImpl };
  const release = await getRelease(context);
  const asset = release.assets.find((item) => item.name === assetNameFor(tag, sourceSha));
  if (!asset) {
    if (!allowMissing) fail("release bundle asset not found; recovery cannot rebuild it");
    await requireFirstPreparation(release, context, runAttempt, npmToken);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "restored=false\n");
    return { restored: false };
  }
  const manifest = await restoreAsset(asset, context, bundleDir);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "restored=true\n");
  return { restored: true, directory: bundleDir, manifest };
}

const PLATFORM_JOBS = [
  "Hardening Release Gate",
  "Release (macos-latest)",
  "Release (windows-latest)",
  "Release Linux server package",
];

export async function verifyEvidence({
  sourceSha = process.env.RELEASE_SHA,
  tag = process.env.RELEASE_TAG,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN,
  bundleDir = process.env.RELEASE_BUNDLE_DIR,
  fetchImpl = globalThis.fetch,
} = {}) {
  const context = { tag, sourceSha, repository, token, fetchImpl };
  await getRelease(context); // Recheck that the tag was not moved since restore.
  const manifest = readBundle(bundleDir, { tag, sha: sourceSha });
  const base = `/repos/${repository}/actions/runs/${manifest.sourceRunId}`;
  const validateRun = (run) => {
    if (
      run.head_sha !== sourceSha ||
      run.head_branch !== tag ||
      run.path !== ".github/workflows/release.yml" ||
      run.event !== "push" ||
      run.repository?.full_name !== repository
    )
      fail("release evidence does not match source run");
  };
  const origin = await github(`${base}/attempts/${manifest.sourceRunAttempt}`, context);
  validateRun(origin);
  const jobsFor = async (attempt) => {
    const result = await github(`${base}/attempts/${attempt}/jobs?per_page=100`, context);
    if (!Array.isArray(result.jobs) || result.total_count > 100)
      fail("incomplete release job evidence");
    return result.jobs;
  };
  const successful = (jobs, name) =>
    jobs.some(
      (job) =>
        job.name === name &&
        job.head_sha === sourceSha &&
        job.status === "completed" &&
        job.conclusion === "success",
    );
  const originalJobs = await jobsFor(manifest.sourceRunAttempt);
  for (const name of PLATFORM_JOBS)
    if (!successful(originalJobs, name)) fail(`required release job incomplete: ${name}`);
  if (successful(originalJobs, "Prepare registry packages")) return true;
  // A smoke failure after upload can be repaired by rerunning the same run. The
  // original platform gates remain authoritative; only smoke evidence may advance.
  const latest = await github(base, context);
  validateRun(latest);
  if (
    !Number.isSafeInteger(latest.run_attempt) ||
    latest.run_attempt < manifest.sourceRunAttempt ||
    latest.run_attempt > 50
  )
    fail("invalid release attempt history");
  for (let attempt = latest.run_attempt; attempt > manifest.sourceRunAttempt; attempt--) {
    const run = await github(`${base}/attempts/${attempt}`, context);
    validateRun(run);
    if (successful(await jobsFor(attempt), "Prepare registry packages")) return true;
  }
  fail("required release job incomplete: Prepare registry packages");
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === "prepare") {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== process.env.RELEASE_SHA) fail("checkout does not match RELEASE_SHA");
    await prepareBundle();
    return;
  }
  if (command === "verify-evidence") {
    await verifyEvidence();
    return;
  }
  if (command === "restore") {
    await restoreBundle({ allowMissing: argv.includes("--allow-missing") });
    return;
  }
  fail("usage: package-bundle.mjs prepare|restore|verify-evidence");
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
