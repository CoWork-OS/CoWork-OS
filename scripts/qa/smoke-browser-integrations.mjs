#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const root = process.cwd();
const requestedEntry = process.env.COWORK_WEB_INTEGRATION_SMOKE_DAEMON_ENTRY;
const runtime =
  process.env.COWORK_WEB_INTEGRATION_SMOKE_RUNTIME ||
  (requestedEntry && path.basename(requestedEntry) === "coworkd.js" ? "electron" : "node");
if (runtime !== "node" && runtime !== "electron") {
  throw new Error("COWORK_WEB_INTEGRATION_SMOKE_RUNTIME must be node or electron.");
}
const daemonEntry = requestedEntry
  ? path.resolve(root, requestedEntry)
  : path.join(root, "dist/daemon/daemon/main.js");
const electronExecutable = runtime === "electron" ? require("electron") : undefined;
const electronMainEntry = path.join(root, "dist/electron/electron/main.js");
const controlCliPath = path.join(root, "bin/coworkctl.js");
const manifestPath = path.join(root, "dist/web/web-manifest.json");
const channelSecret = "synthetic-browser-channel-secret-replacement";
const accountSecret = "synthetic-browser-managed-account-secret";

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

function createSkillFixture(slug) {
  const body = `---\nname: Synthetic Browser Import\nslug: ${slug}\ndescription: Disposable localhost browser-host acceptance fixture.\n---\n# Synthetic Browser Import\n\nThis local fixture verifies host-side Skill Store import. It does not contact a provider or send messages.\n`;
  const server = http.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/synthetic-skill.md") {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      resolve({
        url: `http://127.0.0.1:${address.port}/synthetic-skill.md`,
        close: () =>
          new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

async function callControlPlane(url, token, method) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [controlCliPath, "--url", url, "call", method],
    {
      cwd: root,
      env: { ...process.env, COWORK_CONTROL_PLANE_TOKEN: token },
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, `Control Plane ${method} failed`);
  return result.payload;
}

async function rpc(base, cookie, csrfToken, apiVersion, method, params, operationKey) {
  const response = await fetch(`${base}/api/web/v1/rpc`, {
    method: "POST",
    headers: {
      Origin: base,
      Cookie: cookie,
      "X-CoWork-CSRF": csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apiVersion,
      type: "request",
      id: randomUUID(),
      method,
      params,
      ...(operationKey ? { operationKey } : {}),
    }),
  });
  assert.equal(response.status, 200, `${method} HTTP ${response.status}`);
  const frame = await response.json();
  assert.equal(frame.error, undefined, `${method}: ${frame.error?.message ?? "RPC error"}`);
  return frame.result;
}

async function callDesktop(base, session, manifest, cookie, name, args = [], operationKey) {
  return rpc(
    base,
    cookie,
    session.csrfToken,
    manifest.apiVersion,
    `desktop.${name}`,
    { args },
    operationKey,
  );
}

async function pairBrowserSession({ base, port, token, manifest, pairingCode }) {
  const pairing = pairingCode
    ? { code: pairingCode }
    : await callControlPlane(`ws://127.0.0.1:${port}`, token, "web.pair");
  assert.equal(typeof pairing.code, "string");
  const pair = await fetch(`${base}/api/web/v1/session/pair`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ code: pairing.code }),
  });
  assert.equal(pair.status, 200);
  const cookie = pair.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  const response = await fetch(`${base}/api/web/v1/session/bootstrap`, {
    headers: { Cookie: cookie, Origin: base },
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.apiVersion, manifest.apiVersion);
  return { cookie, session };
}

function startHost({ runtime: hostRuntime, daemonPath, profile, workspace, port, rootDir }) {
  const base = `http://127.0.0.1:${port}`;
  const hostEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^COWORK_LLM_/i.test(name) &&
        !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name),
    ),
  );
  delete hostEnv.ELECTRON_RUN_AS_NODE;
  const childEnv = {
    ...hostEnv,
    COWORK_USER_DATA_DIR: profile,
    COWORK_PROFILE: "default",
    COWORK_WEB_ENABLED: "1",
    COWORK_WEB_PUBLIC_ORIGIN: "",
    COWORK_WEB_TRUSTED_PROXY_ADDRESSES: "",
    COWORK_CONTROL_PLANE_HOST: "127.0.0.1",
    COWORK_CONTROL_PLANE_PORT: String(port),
    COWORK_CONTROL_PLANE_TOKEN: "",
    COWORK_BOOTSTRAP_WORKSPACE_PATH: workspace,
    COWORK_BOOTSTRAP_WORKSPACE_NAME: "Browser integration acceptance workspace",
    COWORK_IMPORT_ENV_SETTINGS: "0",
    COWORK_DISABLE_OS_KEYCHAIN: "1",
  };
  const args = [
    "--headless",
    "--enable-control-plane",
    "--print-control-plane-token",
    "--no-import-env-settings",
    "--user-data-dir",
    profile,
  ];
  // Electron must receive the package root so app.getAppPath() resolves the
  // shipped web assets and manifests. The package entry maps to the compiled main.
  const child = spawn(
    hostRuntime === "electron" ? electronExecutable : process.execPath,
    hostRuntime === "electron" ? [rootDir, ...args] : [daemonPath, ...args],
    {
      cwd: rootDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return { child, base, port, profile, runtime: hostRuntime };
}

async function runInHostRuntime(hostRuntime, source, profile) {
  const electron = hostRuntime === "electron";
  const runtimeEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^COWORK_LLM_/i.test(name) &&
        !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name),
    ),
  );
  return execFileAsync(electron ? electronExecutable : process.execPath, ["-e", source], {
    cwd: root,
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    env: {
      ...runtimeEnv,
      COWORK_USER_DATA_DIR: profile,
      COWORK_DISABLE_OS_KEYCHAIN: "1",
      ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  });
}

async function queryProfile(hostRuntime, profile, queries) {
  const databasePath = path.join(profile, "cowork-os.db");
  const source = `
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(databasePath)}, { readonly: true, fileMustExist: true });
    try {
      const output = ${JSON.stringify(queries)}.map(({ sql, params }) => db.prepare(sql).all(...params));
      process.stdout.write(JSON.stringify(output));
    } finally { db.close(); }
  `;
  const { stdout } = await runInHostRuntime(hostRuntime, source, profile);
  return JSON.parse(stdout);
}

async function readControlPlaneToken(profile, port) {
  const filePath = path.join(profile, "control-plane-local.json");
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new Error(
      "The disposable host has not written its local Control Plane pairing file yet.",
    );
  }
  if (
    payload?.url !== `ws://127.0.0.1:${port}` ||
    typeof payload?.token !== "string" ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(payload.token)
  ) {
    throw new Error("The disposable host local pairing file is invalid.");
  }
  return payload.token;
}

async function waitForReady(host) {
  if (host.runtime === "node") {
    let output = "";
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Disposable Node host start timed out.")),
        60_000,
      );
      const onData = (chunk) => {
        output = (output + chunk.toString()).slice(-128_000);
        const match = output.match(/\[Daemon\] Control Plane token: ([A-Za-z0-9_-]+)/)?.[1];
        if (match && output.includes("[Daemon] Browser app enabled.")) {
          clearTimeout(timer);
          host.child.stdout.off("data", onData);
          host.child.stderr.off("data", onData);
          resolve(match);
        }
      };
      host.child.stdout.on("data", onData);
      host.child.stderr.on("data", onData);
      host.child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Disposable Node host exited with ${code}: ${output.replace(/Control Plane token: \S+/, "Control Plane token: [redacted]").slice(-3_000)}`,
          ),
        );
      });
    });
    const pairing = await callControlPlane(`ws://127.0.0.1:${host.port}`, token, "web.pair");
    return { token, pairingCode: pairing.code };
  }

  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (host.child.exitCode !== null || host.child.signalCode !== null) {
      throw new Error("Disposable Electron host exited before Browser app startup completed.");
    }
    try {
      const token = await readControlPlaneToken(host.profile, host.port);
      const appResponse = await fetch(`${host.base}/app/`);
      if (appResponse.ok) {
        const pairing = await callControlPlane(`ws://127.0.0.1:${host.port}`, token, "web.pair");
        return { token, pairingCode: pairing.code };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Disposable Electron host did not expose the Browser app in 60s${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

async function stopHost(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function main() {
  await fs.access(runtime === "electron" ? electronMainEntry : daemonEntry);
  await fs.access(manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert(Number.isSafeInteger(manifest.apiVersion));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-web-integrations-"));
  const profile = path.join(temp, "profile");
  const workspace = path.join(temp, "workspace");
  await fs.mkdir(workspace);
  const slug = `synthetic-browser-import-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const fixture = await createSkillFixture(slug);
  const port = await freePort();
  const hostOptions = {
    runtime,
    daemonPath: daemonEntry,
    profile,
    workspace,
    port,
    rootDir: root,
  };
  let host = startHost(hostOptions);
  let channelId;
  let accountId;
  let skillInstalled = false;

  try {
    let ready = await waitForReady(host);
    let token = ready.token;
    let paired = await pairBrowserSession({
      base: host.base,
      port,
      token,
      manifest,
      pairingCode: ready.pairingCode,
    });
    const desktop = (name, args = [], key) =>
      callDesktop(host.base, paired.session, manifest, paired.cookie, name, args, key);
    for (const method of [
      "installSkillFromUrl",
      "getSkillInstallProgress",
      "uninstallSkill",
      "upsertManagedAccount",
      "listManagedAccounts",
      "removeManagedAccount",
      "getGatewayChannels",
      "addGatewayChannel",
      "updateGatewayChannel",
      "disableGatewayChannel",
      "removeGatewayChannel",
    ]) {
      assert(
        paired.session.desktopMethods?.[method],
        `Missing browser integration method ${method}`,
      );
    }

    const account = await desktop(
      "upsertManagedAccount",
      [
        {
          provider: "synthetic-browser-acceptance",
          label: "Disposable managed account",
          status: "draft",
          secrets: { apiToken: accountSecret },
        },
      ],
      randomUUID(),
    );
    accountId = account.account.id;
    assert.equal(account.account.status, "draft");
    assert(
      !JSON.stringify(account).includes(accountSecret),
      "Account secret escaped its write call",
    );

    const added = await desktop(
      "addGatewayChannel",
      [
        {
          type: "telegram",
          name: "Disposable disabled browser channel",
          botToken: "synthetic-browser-channel-secret-initial",
          securityMode: "pairing",
        },
      ],
      randomUUID(),
    );
    channelId = added.id;
    assert.equal(added.enabled, false, "The acceptance channel must remain disabled");
    assert(!JSON.stringify(added).includes("synthetic-browser-channel-secret-initial"));
    assert.deepEqual(
      await desktop(
        "updateGatewayChannel",
        [{ id: channelId, config: { botToken: channelSecret, groupRoutingMode: "mentionsOnly" } }],
        randomUUID(),
      ),
      { updated: true },
    );
    await desktop("disableGatewayChannel", [channelId], randomUUID());
    const channelDto = (await desktop("getGatewayChannels")).find((item) => item.id === channelId);
    assert.equal(channelDto.enabled, false);
    assert.equal(channelDto.credentialConfigured, true);
    assert.equal(channelDto.config.groupRoutingMode, "mentionsOnly");
    assert(!JSON.stringify(channelDto).includes(channelSecret));

    const accountList = await desktop("listManagedAccounts");
    assert(accountList.accounts.some((item) => item.id === accountId));
    assert(!JSON.stringify(accountList).includes(accountSecret));
    const [channelRows, accountRows] = await queryProfile(runtime, profile, [
      { sql: "SELECT config FROM channels WHERE id = ?", params: [channelId] },
      {
        sql: "SELECT encrypted_data FROM secure_settings WHERE category = ?",
        params: ["plugin:managed-accounts"],
      },
    ]);
    const rawChannelConfig = channelRows[0]?.config;
    assert.equal(typeof rawChannelConfig, "string");
    assert(rawChannelConfig.startsWith("enc:repo:v1:"));
    assert(!rawChannelConfig.includes(channelSecret));
    assert(!rawChannelConfig.includes("synthetic-browser-channel-secret-initial"));
    const rawAccount = accountRows[0]?.encrypted_data;
    assert.equal(typeof rawAccount, "string");
    assert(!rawAccount.includes(accountSecret));

    const install = await desktop("installSkillFromUrl", [fixture.url], randomUUID());
    assert.equal(
      install.success,
      true,
      `Synthetic skill import failed: ${install.error || "unknown"}`,
    );
    assert.equal(install.skill.id, slug);
    assert(!JSON.stringify(install).includes(fixture.url));
    assert(!JSON.stringify(install).includes("# Synthetic Browser Import"));
    assert.deepEqual(await desktop("getSkillInstallProgress"), {
      status: "completed",
      progress: 100,
      message: "Skill installed",
    });
    skillInstalled = true;

    await stopHost(host.child);
    host = startHost(hostOptions);
    ready = await waitForReady(host);
    token = ready.token;
    paired = await pairBrowserSession({
      base: host.base,
      port,
      token,
      manifest,
      pairingCode: ready.pairingCode,
    });
    const afterRestart = (name, args = []) =>
      callDesktop(host.base, paired.session, manifest, paired.cookie, name, args, randomUUID());
    const restartedChannels = await afterRestart("getGatewayChannels");
    const restartedChannel = restartedChannels.find((item) => item.id === channelId);
    assert(restartedChannel, "Channel config did not survive host restart");
    assert.equal(restartedChannel.enabled, false);
    assert.equal(restartedChannel.credentialConfigured, true);
    assert.equal(restartedChannel.config.groupRoutingMode, "mentionsOnly");
    assert(!JSON.stringify(restartedChannel).includes(channelSecret));
    const restartedAccounts = await afterRestart("listManagedAccounts");
    assert(restartedAccounts.accounts.some((item) => item.id === accountId));
    assert(!JSON.stringify(restartedAccounts).includes(accountSecret));
    const restartedSkills = await afterRestart("getSkillStatus");
    assert(restartedSkills.skills.some((item) => item.id === slug && item.source === "managed"));

    const removedSkill = await afterRestart("uninstallSkill", [slug]);
    assert.equal(removedSkill.success, true);
    skillInstalled = false;
    const removedAccount = await afterRestart("removeManagedAccount", [accountId]);
    assert.equal(removedAccount.removed, true);
    accountId = undefined;
    const removedChannel = await afterRestart("removeGatewayChannel", [channelId]);
    assert.equal(removedChannel.removed, true);
    channelId = undefined;

    process.stdout.write(
      `Disposable browser integration acceptance passed on the ${runtime} host: generic Web RPC installed a localhost skill fixture, exposed bounded install progress, performed managed-account credential CRUD, saved a disabled gateway channel, verified runtime-matched encrypted storage and redacted readback, and recovered account/channel/skill state after a host restart. No provider accounts were created and no channel was enabled or used to send messages.\n`,
    );
  } finally {
    await stopHost(host.child);
    await fixture.close();
    if (skillInstalled || channelId || accountId) {
      process.stderr.write(
        "Disposable integration acceptance ended before all host records could be cleaned; removing the isolated profile directory.\n",
      );
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
