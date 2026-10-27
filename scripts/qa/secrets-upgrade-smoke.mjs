#!/usr/bin/env node
/**
 * Upgrade check for stored secrets on the real OS keychain (macOS Keychain, Windows DPAPI,
 * Linux Secret Service). A previous release saves a provider API key on a disposable
 * profile, then this build opens the same profile:
 *
 *   1. baseline: saves the API key; the secret is sealed by the OS keychain directly.
 *   2. current, first start: creates the data key (key file and database copy), moves every
 *      secret onto it, reads the API key, and logs no safeStorage deprecation warning.
 *   3. current again: nothing is left to move.
 *   4. CLI (app directories only): `cowork run` reaches the provider with the right key.
 *   5. key file deleted: the next start restores it from the database copy.
 *   6. rollback: the baseline opens the upgraded profile. It cannot read the secrets, and it
 *      must leave them as they are.
 *   7. upgrade again: this build reads the API key.
 *
 * A target is a packaged app (a macOS .app bundle or the app's executable) or an app
 * directory with its own node_modules/electron (a built checkout or an installed npm
 * package). The current target defaults to this checkout.
 *
 *   node scripts/qa/secrets-upgrade-smoke.mjs --baseline <target> [--current <target>]
 *     [--out <dir>] [--electron-arg=<switch> ...] [--expect=keychain|app] [--skip-cli]
 *
 * `--expect=app` is for a machine without an OS keychain (Linux without a Secret Service):
 * secrets stay sealed by the app key and no data key may be created. Each step's log, the
 * results (results.json) and a copy of the database stay in the output directory. A fake
 * OpenAI-compatible provider listens on 127.0.0.1; nothing leaves the machine.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { values: options } = parseArgs({
  options: {
    baseline: { type: "string" },
    current: { type: "string", default: root },
    out: { type: "string" },
    "electron-arg": { type: "string", multiple: true, default: [] },
    expect: { type: "string", default: "keychain" },
    "skip-cli": { type: "boolean", default: false },
  },
});
if (!options.baseline) {
  console.error("Usage: secrets-upgrade-smoke.mjs --baseline <target> [--current <target>]");
  process.exit(2);
}
if (!["keychain", "app"].includes(options.expect)) {
  console.error("--expect is keychain or app");
  process.exit(2);
}
const expectKeychain = options.expect === "keychain";
const out = path.resolve(
  options.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "cowork-secrets-upgrade-")),
);
const profile = path.join(out, "profile");
fs.mkdirSync(profile, { recursive: true });
const { _electron } = createRequire(path.join(root, "package.json"))("playwright");

const API_KEY = "sk-secrets-upgrade-5531";
const DATA_KEY_CATEGORY = "__safe_storage_data_key__";
const keyFile = path.join(profile, "safe-storage-key.json");

/** How to launch a target: its executable, the arguments before Electron switches, and an app dir. */
function launchSpec(target) {
  const resolved = path.resolve(target);
  if (resolved.endsWith(".app")) {
    const macos = path.join(resolved, "Contents", "MacOS");
    const [binary] = fs.readdirSync(macos);
    return { executablePath: path.join(macos, binary), appArgs: [], appDir: null };
  }
  if (fs.statSync(resolved).isDirectory()) {
    const electron = createRequire(path.join(resolved, "package.json"))("electron");
    return { executablePath: electron, appArgs: [resolved], appDir: resolved };
  }
  return { executablePath: resolved, appArgs: [], appDir: null };
}
const baseline = launchSpec(options.baseline);
const current = launchSpec(options.current);

// Loopback fake provider: records the Authorization header of every chat request.
const authHeaders = [];
const server = createServer(async (req, res) => {
  if (req.url?.endsWith("/models")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "upgrade-model" }] }));
    return;
  }
  for await (const _chunk of req);
  authHeaders.push(req.headers.authorization || "");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "r",
      model: "upgrade-model",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "UPGRADE_OK" },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const env = {
  ...process.env,
  NODE_ENV: "production",
  COWORK_USER_DATA_DIR: profile,
  COWORK_IMPORT_ENV_SETTINGS: "0",
  COWORK_BACKGROUND_AUTOSTART: "0",
  COWORK_DEV_BRAND_APP: "0",
  ELECTRON_RUN_AS_NODE: "",
};

function summarizeLog(log) {
  return {
    logCaptured: /SecureSettingsRepository initialized/.test(log),
    deprecationWarnings: (log.match(/safeStorage\.[a-zA-Z]+' is deprecated/g) || []).length,
    movedToDataKey: (log.match(/Re-encrypted [a-z ]+ with the data key/g) || []).length,
    legacyReads: (log.match(/still sealed by the OS keychain directly/g) || []).length,
    keyCreated: /Created the data key that seals secrets/.test(log),
    keyUnreadable: /secrets data key is sealed by an OS keychain/.test(log),
  };
}

const results = {};

async function runApp(label, spec, fn) {
  const app = await _electron.launch({
    executablePath: spec.executablePath,
    args: [...options["electron-arg"], ...spec.appArgs],
    cwd: spec.appDir ?? path.dirname(spec.executablePath),
    timeout: 180_000,
    env,
  });
  let log = "";
  app.process().stdout?.on("data", (d) => (log += d));
  app.process().stderr?.on("data", (d) => (log += d));
  try {
    await app.evaluate(({ shell }) => {
      shell.openExternal = async () => {};
    });
    const backend = await app
      .evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend?.() ?? null)
      .catch(() => null);
    let page;
    for (let i = 0; i < 400 && !page; i++) {
      page = app.windows().find((w) => w.url().includes("/renderer/index.html"));
      if (!page) await new Promise((r) => setTimeout(r, 300));
    }
    if (!page) throw new Error(`${label}: the main window never opened`);
    await page.waitForFunction(() => !!window.electronAPI?.getLLMSettings, null, {
      timeout: 120_000,
    });
    await page.waitForTimeout(5000);
    const api = (name, ...args) =>
      page.evaluate(({ name, args }) => window.electronAPI[name](...args), { name, args });
    results[label] = { ...(await fn(api)), ...(backend ? { linuxBackend: backend } : {}) };
  } catch (error) {
    results[label] = { error: String(error?.stack || error) };
  } finally {
    await app.close().catch(() => {});
    fs.writeFileSync(path.join(out, `${label}.log`), log);
  }
  Object.assign(results[label], summarizeLog(log));
}

/** Read the profile's database through a copy (the app's WAL holds the latest pages). */
function readDatabase(fn) {
  const copy = path.join(out, "check.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${copy}${suffix}`, { force: true });
    const from = path.join(profile, `cowork-os.db${suffix}`);
    if (fs.existsSync(from)) fs.copyFileSync(from, `${copy}${suffix}`);
  }
  const db = new DatabaseSync(copy);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** How each stored secret is sealed: "data-key", "keychain" (OS directly) or "app". */
function sealedBy(encrypted) {
  if (encrypted.startsWith("app2:")) return "app";
  if (!encrypted.startsWith("os:")) return "other";
  const head = Buffer.from(encrypted.slice(3), "base64").subarray(0, 4).toString("latin1");
  return head === "ck1:" ? "data-key" : "keychain";
}

function inspectProfile() {
  return readDatabase((db) => {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name),
    );
    const rows = db
      .prepare("SELECT category, encrypted_data FROM secure_settings WHERE category <> ?")
      .all(DATA_KEY_CATEGORY);
    const keyRow = db
      .prepare("SELECT encrypted_data FROM secure_settings WHERE category = ?")
      .get(DATA_KEY_CATEGORY);
    const canary = tables.has("secure_settings_keychain_canary")
      ? db.prepare("SELECT encrypted_data FROM secure_settings_keychain_canary WHERE id = 1").get()
      : undefined;
    const backups = tables.has("secure_settings_unreadable_backup")
      ? db.prepare("SELECT COUNT(*) AS n FROM secure_settings_unreadable_backup").get().n
      : 0;
    const sealing = {};
    for (const row of rows) {
      const kind = sealedBy(row.encrypted_data);
      sealing[kind] = (sealing[kind] ?? 0) + 1;
    }
    return {
      secrets: rows.length,
      sealing,
      llmSealedBy: sealedBy(rows.find((row) => row.category === "llm")?.encrypted_data ?? ""),
      canarySealedBy: canary ? sealedBy(canary.encrypted_data) : null,
      dataKeyInDatabase: keyRow?.encrypted_data.startsWith("key:") ?? false,
      dataKeyFile: fs.existsSync(keyFile),
      unreadableBackups: backups,
      fingerprint: JSON.stringify(rows.map((row) => [row.category, row.encrypted_data])),
    };
  });
}

const readKey = async (api) => (await api("getLLMSettings"))?.openaiCompatible?.apiKey ?? null;
const keyReads = async (api) => ({ apiKeyRead: (await readKey(api)) === API_KEY });

// 1. The previous release saves a provider API key.
await runApp("1-baseline", baseline, async (api) => {
  const appearance = await api("getAppearanceSettings");
  await api("saveAppearanceSettings", {
    ...appearance,
    onboardingCompleted: true,
    disclaimerAccepted: true,
  });
  await api("saveLLMSettings", {
    providerType: "openai-compatible",
    modelKey: "upgrade-model",
    openaiCompatible: { baseUrl, model: "upgrade-model", apiKey: API_KEY },
  });
  return keyReads(api);
});
Object.assign(results["1-baseline"], inspectProfile());

// 2-3. This build opens the profile, twice.
await runApp("2-current", current, keyReads);
Object.assign(results["2-current"], inspectProfile());
await runApp("3-current-again", current, keyReads);
Object.assign(results["3-current-again"], inspectProfile());

// 4. The CLI on the upgraded profile (it needs the app directory's bin/).
const cliEntry = current.appDir && path.join(current.appDir, "bin", "cowork-cli.js");
if (!options["skip-cli"] && cliEntry && fs.existsSync(cliEntry)) {
  const before = authHeaders.length;
  const cli = spawn(
    process.execPath,
    [cliEntry, "run", "--prompt", "Reply with UPGRADE_OK.", "--cwd", out],
    { cwd: current.appDir, env },
  );
  let cliLog = "";
  cli.stdout.on("data", (d) => (cliLog += d));
  cli.stderr.on("data", (d) => (cliLog += d));
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      cli.kill("SIGTERM");
      resolve("timeout");
    }, 240_000);
    cli.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  fs.writeFileSync(path.join(out, "4-cli.log"), cliLog);
  const sent = authHeaders.slice(before);
  results["4-cli"] = {
    exit,
    providerCalls: sent.length,
    sentRightKey: sent.length > 0 && sent.every((h) => h === `Bearer ${API_KEY}`),
    ...summarizeLog(cliLog),
  };
}

// 5. The key file is lost; the database copy restores it.
const sealedKey = fs.existsSync(keyFile)
  ? JSON.parse(fs.readFileSync(keyFile, "utf8")).sealed
  : null;
if (sealedKey) fs.rmSync(keyFile);
await runApp("5-key-file-lost", current, keyReads);
Object.assign(results["5-key-file-lost"], inspectProfile(), {
  keyFileRestored:
    !!sealedKey &&
    fs.existsSync(keyFile) &&
    JSON.parse(fs.readFileSync(keyFile, "utf8")).sealed === sealedKey,
});

// 6-7. Roll back to the baseline, then upgrade again.
const beforeRollback = inspectProfile();
await runApp("6-rollback", baseline, keyReads);
Object.assign(results["6-rollback"], inspectProfile());
results["6-rollback"].secretsUntouched =
  results["6-rollback"].fingerprint === beforeRollback.fingerprint;
await runApp("7-upgrade-again", current, keyReads);
Object.assign(results["7-upgrade-again"], inspectProfile());

server.close();
for (const step of Object.values(results)) delete step.fingerprint;

// Every expectation, by step.
const checks = [];
const check = (step, name, ok) => checks.push({ step, name, ok: !!ok });
const r = results;
check("1-baseline", "saved and read the API key", r["1-baseline"].apiKeyRead);
check(
  "1-baseline",
  expectKeychain ? "sealed it with the OS keychain" : "sealed it with the app key",
  r["1-baseline"].llmSealedBy === (expectKeychain ? "keychain" : "app"),
);
for (const step of ["2-current", "3-current-again", "5-key-file-lost", "7-upgrade-again"]) {
  check(step, "read the API key", r[step].apiKeyRead);
  check(step, "log captured", r[step].logCaptured);
  check(step, "no safeStorage deprecation warning", r[step].deprecationWarnings === 0);
  check(step, "no secret read through the synchronous keychain call", r[step].legacyReads === 0);
  if (expectKeychain) {
    check(
      step,
      "every secret sealed with the data key",
      r[step].sealing["data-key"] === r[step].secrets,
    );
    check(step, "keychain canary sealed with the data key", r[step].canarySealedBy === "data-key");
    check(
      step,
      "data key in the database and the key file",
      r[step].dataKeyInDatabase && r[step].dataKeyFile,
    );
  } else {
    check(step, "no data key created", !r[step].dataKeyInDatabase && !r[step].dataKeyFile);
    check(step, "secrets still sealed with the app key", r[step].sealing.app === r[step].secrets);
  }
}
if (expectKeychain) {
  check("2-current", "created the data key", r["2-current"].keyCreated);
  check("2-current", "moved the secrets onto it", r["2-current"].movedToDataKey > 0);
  check("3-current-again", "nothing left to move", r["3-current-again"].movedToDataKey === 0);
  check(
    "5-key-file-lost",
    "key file restored from the database",
    r["5-key-file-lost"].keyFileRestored,
  );
  check("6-rollback", "baseline cannot read the moved secret", !r["6-rollback"].apiKeyRead);
}
check("6-rollback", "secrets left as they were", r["6-rollback"].secretsUntouched);
check("6-rollback", "nothing archived as unreadable", r["6-rollback"].unreadableBackups === 0);
if (r["4-cli"]) {
  check("4-cli", "sent the right key to the provider", r["4-cli"].sentRightKey);
  check("4-cli", "no safeStorage deprecation warning", r["4-cli"].deprecationWarnings === 0);
}
for (const [step, result] of Object.entries(results)) {
  if (result.error) check(step, `ran without error: ${result.error.split("\n")[0]}`, false);
}

const summary = {
  platform: `${process.platform}-${process.arch}`,
  expect: options.expect,
  baseline: options.baseline,
  current: options.current,
  results,
  failed: checks.filter((c) => !c.ok),
};
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(summary, null, 2));
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.step}: ${c.name}`);
console.log(
  `\n${checks.length - summary.failed.length}/${checks.length} checks passed; evidence in ${out}`,
);
process.exit(summary.failed.length === 0 ? 0 : 1);
