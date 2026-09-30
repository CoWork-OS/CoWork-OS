#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);
const timeoutMs = 180_000;

function redact(value, secrets = []) {
  let result = String(value ?? "");
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHost({ base, descriptorPath, child, output }) {
  const deadline = Date.now() + timeoutMs;
  let descriptor;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Packaged host exited before readiness (${child.exitCode ?? child.signalCode}): ${redact(output())}`,
      );
    }
    try {
      descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
      if (descriptor.pid !== child.pid || descriptor.url !== base.replace(/^http/, "ws")) {
        throw new Error("Packaged host wrote a connection descriptor for another process or URL.");
      }
      const [health, application, manifest] = await Promise.all([
        fetch(`${base}/health`),
        fetch(`${base}/app/`),
        fetch(`${base}/app/web-manifest.json`),
      ]);
      if (health.ok && application.ok && manifest.ok) {
        const body = await application.text();
        const webManifest = await manifest.json();
        assert.match(body, /<script/i, "The packaged browser app did not return its entry HTML.");
        assert.equal(typeof webManifest.buildId, "string");
        assert(webManifest.buildId.length > 0);
        return descriptor;
      }
      lastError = `health=${health.status}, app=${application.status}, manifest=${manifest.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Packaged browser host did not become ready (${lastError}): ${redact(output())}`);
}

function requestPairingCode(descriptor) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "bin", "coworkctl.js"), "--url", descriptor.url, "call", "web.pair"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      env: { ...process.env, COWORK_CONTROL_PLANE_TOKEN: descriptor.token },
    },
  );
  if (result.error || result.status !== 0) {
    throw result.error || new Error("Packaged browser pairing request failed.");
  }
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true, "Packaged host rejected the pairing request.");
  assert.equal(typeof response.payload?.code, "string");
  return response.payload.code;
}

async function stopHost(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function runBrowser(base, pairingCode) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.COWORK_WEB_UI_BROWSER_EXECUTABLE
      ? { executablePath: process.env.COWORK_WEB_UI_BROWSER_EXECUTABLE }
      : {}),
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(12_000);
    const failures = [];
    page.on("pageerror", (error) => failures.push(`${error.name}: ${error.message}`));
    await page.goto(`${base}/app/`, { waitUntil: "networkidle" });
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("button", { name: "Skip onboarding" }).click();
    await page.getByText("Yes, I understand", { exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Inbox", exact: true }).waitFor({ state: "visible" });
    const text = await page.locator("body").innerText();
    assert.doesNotMatch(
      text,
      /Run on your host|Recent activity|Workspace files/,
      "The packaged app served the legacy dashboard instead of the shared application.",
    );
    assert.deepEqual(failures, [], "The packaged browser UI raised runtime errors.");
  } finally {
    await browser.close();
  }
}

async function main() {
  assert.equal(process.platform, "darwin", "This smoke currently targets a packaged macOS app.");
  const appBundle = path.resolve(
    process.env.COWORK_WEB_DESKTOP_APP || path.join(root, "release", "mac-arm64", "CoWork OS.app"),
  );
  const executable = path.join(appBundle, "Contents", "MacOS", "CoWork OS");
  await fs.access(executable);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-packaged-desktop-web-"));
  const profile = path.join(tempRoot, "profile");
  const workspace = path.join(tempRoot, "workspace");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const descriptorPath = path.join(profile, "control-plane-local.json");
  const headless = process.env.COWORK_WEB_DESKTOP_HEADLESS !== "0";
  await fs.mkdir(workspace, { recursive: true });

  const hostEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^COWORK_LLM_/i.test(name) &&
        !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name),
    ),
  );
  const child = spawn(
    executable,
    [...(headless ? ["--headless"] : []), "--enable-control-plane", "--user-data-dir", profile],
    {
      cwd: root,
      env: {
        ...hostEnv,
        // This host always uses a fresh disposable profile. Avoid invoking the
        // user's macOS Keychain or waiting on an ad-hoc-signature trust prompt.
        COWORK_DISABLE_OS_KEYCHAIN: "1",
        COWORK_USER_DATA_DIR: profile,
        COWORK_PROFILE: "default",
        COWORK_HEADLESS: headless ? "1" : "0",
        COWORK_WEB_ENABLED: "1",
        COWORK_WEB_PUBLIC_ORIGIN: "",
        COWORK_WEB_TRUSTED_PROXY_ADDRESSES: "",
        COWORK_CONTROL_PLANE_HOST: "127.0.0.1",
        COWORK_CONTROL_PLANE_PORT: String(port),
        COWORK_BOOTSTRAP_WORKSPACE_PATH: workspace,
        COWORK_BOOTSTRAP_WORKSPACE_NAME: "Packaged browser smoke workspace",
        COWORK_IMPORT_ENV_SETTINGS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const capture = (chunk) => {
    const text = chunk.toString();
    output = (output + text).slice(-32_000);
    if (process.env.COWORK_WEB_SMOKE_VERBOSE === "1") process.stdout.write(text);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  let descriptor;

  try {
    descriptor = await waitForHost({
      base,
      descriptorPath,
      child,
      output: () => redact(output, [descriptor?.token]),
    });
    assert.equal(typeof descriptor.token, "string");
    assert(descriptor.token.length > 0);
    const code = requestPairingCode(descriptor);
    await runBrowser(base, code);
    console.log(
      "Packaged macOS Electron browser smoke passed: app assets, authenticated pairing, shared CoWork UI.",
    );
  } finally {
    await stopHost(child);
    if (process.env.COWORK_WEB_KEEP_SMOKE_PROFILE === "1") {
      console.error(`Preserved disposable packaged-host profile at ${tempRoot}`);
    } else {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

await main();
