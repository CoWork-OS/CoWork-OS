import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, lstat, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

export const TARGETS = Object.freeze([
  Object.freeze({ id: "npm", name: "cowork-os", registry: "https://registry.npmjs.org" }),
  Object.freeze({
    id: "github",
    name: "@cowork-os/cowork-os",
    registry: "https://npm.pkg.github.com",
  }),
]);

const MAX_REDIRECTS = 3;
const VERIFY_ATTEMPTS = 5;
const VERIFY_DELAY_MS = 500;
const GITHUB_DOWNLOAD_HOSTS = new Set([
  "codeload.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "pkg-containers.githubusercontent.com",
  "pkg-npm.githubusercontent.com",
  "raw.githubusercontent.com",
]);

function fail(message) {
  throw new Error(message);
}

function trustedUrl(value, { registryHost, allowDownload = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("Registry response contains an invalid URL");
  }
  if (url.protocol !== "https:") fail("Registry URLs must use HTTPS");
  if (url.username || url.password || url.port)
    fail("Registry URL contains forbidden credentials or port");
  if (
    registryHost &&
    url.hostname !== registryHost &&
    !(allowDownload && GITHUB_DOWNLOAD_HOSTS.has(url.hostname))
  ) {
    fail(`Registry response points to an untrusted host: ${url.hostname}`);
  }
  return url;
}

function validateTarget(entry) {
  if (
    !TARGETS.some(
      (target) =>
        target.id === entry?.id && target.name === entry.name && target.registry === entry.registry,
    )
  ) {
    fail("Unexpected package or registry target");
  }
  if (
    typeof entry.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version)
  ) {
    fail("Invalid package version");
  }
}

async function request(
  url,
  { token, fetchImpl, registryHost, allowDownload = false, accept = "application/json" },
) {
  let current = trustedUrl(url, { registryHost, allowDownload });
  let authorization = token && current.hostname === registryHost ? `Bearer ${token}` : undefined;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const headers = { accept };
    if (authorization) headers.authorization = authorization;
    let response;
    try {
      response = await fetchImpl(current.href, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Registry request failed or timed out");
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirect === MAX_REDIRECTS) fail("Registry redirect limit exceeded");
      const location = response.headers?.get?.("location");
      if (!location) fail("Registry redirect has no location");
      const next = trustedUrl(new URL(location, current).href, { registryHost, allowDownload });
      if (next.hostname !== current.hostname) authorization = undefined;
      current = next;
      continue;
    }
    return response;
  }
  fail("Registry request failed");
}

function parseIntegrity(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/=]+$/.test(value))
    fail("Invalid SHA512 integrity");
  const encoded = value.slice("sha512-".length);
  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64");
  } catch {
    fail("Invalid SHA512 integrity");
  }
  if (decoded.length !== 64 || decoded.toString("base64") !== encoded)
    fail("Invalid SHA512 integrity");
  return encoded;
}

async function verifyTarball(entry, tarball, options) {
  const response = await request(tarball, {
    ...options,
    accept: "application/octet-stream",
    allowDownload: true,
  });
  if (response.status !== 200) fail(`Tarball request returned HTTP ${response.status}`);
  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new Error("Could not read registry tarball");
  }
  if (bytes.byteLength !== entry.size) fail("Registry tarball size does not match bundle");
  const actual = createHash("sha512").update(bytes).digest("base64");
  if (actual !== parseIntegrity(entry.integrity))
    fail("Registry tarball integrity does not match bundle");
}

/** Return only absent or matching; all uncertainty and malformed responses throw. */
export async function inspectRegistry(entry, { token, fetchImpl = globalThis.fetch } = {}) {
  validateTarget(entry);
  if (typeof fetchImpl !== "function") fail("fetch implementation is required");
  const registry = trustedUrl(entry.registry);
  const packageUrl = `${registry.origin}/${encodeURIComponent(entry.name)}`;
  const response = await request(packageUrl, { token, fetchImpl, registryHost: registry.hostname });
  if (response.status === 404) fail("Registry package lookup returned an indeterminate 404");
  if (response.status !== 200) fail(`Registry package lookup returned HTTP ${response.status}`);
  let packument;
  try {
    packument = await response.json();
  } catch {
    fail("Registry package metadata is malformed");
  }
  if (
    !packument ||
    typeof packument !== "object" ||
    Array.isArray(packument) ||
    packument.name !== entry.name ||
    !packument.versions ||
    typeof packument.versions !== "object" ||
    Array.isArray(packument.versions)
  ) {
    fail("Registry package metadata is malformed");
  }
  const published = packument.versions[entry.version];
  if (published === undefined) return "absent";
  if (
    !published ||
    published.name !== entry.name ||
    published.version !== entry.version ||
    !published.dist ||
    published.dist.integrity !== entry.integrity ||
    typeof published.dist.tarball !== "string"
  ) {
    fail("Registry version does not match bundle");
  }
  await verifyTarball(entry, published.dist.tarball, {
    token,
    fetchImpl,
    registryHost: registry.hostname,
  });
  return "matching";
}

async function defaultPublish({ entry, directory, token, distTag }) {
  if (!token) fail("A registry publication token is required");
  const file = join(resolve(directory), entry.filename);
  const args = [
    "publish",
    file,
    "--registry",
    entry.registry,
    "--ignore-scripts",
    "--tag",
    distTag,
  ];
  if (entry.id === "npm") args.splice(5, 0, "--access", "public");
  const temp = await mkdtemp(join(tmpdir(), "cowork-publish-"));
  const npmrc = join(temp, ".npmrc");
  const host = new URL(entry.registry).host;
  const scopeConfig = entry.name.startsWith("@")
    ? `${entry.name.split("/")[0]}:registry=${entry.registry}\n`
    : "";
  await writeFile(npmrc, scopeConfig + "//" + host + "/:_authToken=${NODE_AUTH_TOKEN}\n", {
    mode: 0o600,
  });
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn("npm", args, {
        cwd: temp,
        timeout: 120_000,
        stdio: "ignore",
        env: {
          ...process.env,
          NPM_CONFIG_USERCONFIG: npmrc,
          npm_config_userconfig: npmrc,
          NODE_AUTH_TOKEN: token,
        },
      });
      child.once("error", () => reject(new Error("npm publish could not start")));
      child.once("close", (code) =>
        code === 0 ? resolvePromise() : reject(new Error(`npm publish failed (${code})`)),
      );
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function verifyLocal(entry, directory) {
  const file = join(resolve(directory), entry.filename);
  if (
    basename(entry.filename) !== entry.filename ||
    entry.filename.includes("..") ||
    (await lstat(file)).isSymbolicLink()
  )
    fail("Invalid local bundle filename");
  const info = await stat(file);
  if (!info.isFile() || info.size !== entry.size) fail("Local bundle size does not match manifest");
  const bytes = await readFile(file);
  if (createHash("sha512").update(bytes).digest("base64") !== parseIntegrity(entry.integrity))
    fail("Local bundle integrity does not match manifest");
  return file;
}

export async function publishPackage(
  entry,
  {
    directory,
    token,
    fetchImpl = globalThis.fetch,
    publishImpl = defaultPublish,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    distTag = "latest",
  } = {},
) {
  validateTarget(entry);
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(distTag)) fail("Invalid publication distribution tag");
  await verifyLocal(entry, directory);
  const before = await inspectRegistry(entry, { token, fetchImpl });
  if (before === "matching") return { status: "skipped", id: entry.id, version: entry.version };
  let publishError;
  try {
    await publishImpl({ entry, directory, token, distTag });
  } catch (error) {
    publishError = error;
  }
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    try {
      if ((await inspectRegistry(entry, { token, fetchImpl })) === "matching")
        return { status: "published", id: entry.id, version: entry.version };
    } catch {
      /* A transient lookup or delayed publication remains unverified. */
    }
    if (attempt + 1 < VERIFY_ATTEMPTS) await sleep(VERIFY_DELAY_MS * (attempt + 1));
  }
  if (publishError) throw new Error("Publication failed and could not be verified");
  throw new Error("Publication could not be verified");
}

export async function verifyPackages(entries, options = {}) {
  const results = [];
  for (const entry of entries)
    results.push({ id: entry.id, status: await inspectRegistry(entry, options) });
  return results;
}

export async function runCli({
  argv = process.argv,
  env = process.env,
  readBundleImpl,
  fetchImpl = globalThis.fetch,
  publishImpl,
  sleep,
  log = console.log,
} = {}) {
  const command = argv[2];
  if (command !== "publish" && command !== "verify")
    fail("Usage: registry-publication.mjs <publish|verify>");
  const { readBundle } = readBundleImpl
    ? { readBundle: readBundleImpl }
    : await import("./package-bundle.mjs");
  const directory = env.RELEASE_BUNDLE_DIR || "release";
  const manifest = await readBundle(directory, { tag: env.RELEASE_TAG, sha: env.RELEASE_SHA });
  if (!TARGETS.some((target) => target.id === env.RELEASE_TARGET))
    fail("RELEASE_TARGET must be npm or github");
  const selected = manifest.packages.filter((entry) => entry.id === env.RELEASE_TARGET);
  if (!selected.length) fail("No release package matches RELEASE_TARGET");
  const token = env.NODE_AUTH_TOKEN;
  for (const entry of selected) {
    const result =
      command === "verify"
        ? { status: await inspectRegistry(entry, { token, fetchImpl }) }
        : await publishPackage(entry, {
            directory,
            token,
            fetchImpl,
            publishImpl,
            sleep,
            distTag: env.RELEASE_DIST_TAG || "latest",
          });
    if (command === "verify" && result.status !== "matching")
      fail(`Verification failed for ${entry.id}`);
    log(`${result.status} ${entry.id} ${entry.name}@${entry.version}`);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href)
  runCli().catch((error) => {
    console.error(`Registry publication failed: ${error.message}`);
    process.exitCode = 1;
  });
