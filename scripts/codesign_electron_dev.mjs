#!/usr/bin/env node
/**
 * Optionally signs the local node_modules Electron.app for development.
 *
 * By default this script does not sign. It can be invoked manually:
 *   COWORK_CODESIGN_ENABLE=1 node scripts/codesign_electron_dev.mjs
 *
 * Configure the signing identity explicitly with either:
 *   COWORK_CODESIGN_IDENTITY  env var  (full name or SHA-1 hash)
 *   .cowork/dev-codesign.json          {"identity": "<full name or SHA-1 hash>"} (gitignored)
 *
 * Signing every dev launch with the same identity keeps macOS Keychain access to
 * "CoWork OS Safe Storage" stable across rebuilds; an ad-hoc signature changes
 * with every rebuild, which can cost the app access to its encrypted settings.
 * Use the same team as release builds so dev and packaged apps share that access.
 *
 * If signing is explicitly enabled and no identity is configured, the script
 * applies an ad-hoc signature. It intentionally does not auto-select Apple
 * Development identities from the user's keychain, because that can sign local
 * dev binaries with the wrong developer account.
 *
 * Set  COWORK_CODESIGN_SKIP=1  to skip signing entirely (CI, Linux, etc.).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ELECTRON_APP = path.resolve(
  import.meta.dirname,
  "..",
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
);

const ENTITLEMENTS = path.resolve(import.meta.dirname, "..", "build", "entitlements.mac.plist");

function log(msg) {
  process.stdout.write(`[codesign-dev] ${msg}\n`);
}

export const LOCAL_CODESIGN_CONFIG = path.resolve(
  import.meta.dirname,
  "..",
  ".cowork",
  "dev-codesign.json",
);

export function readLocalIdentity(configPath = LOCAL_CODESIGN_CONFIG) {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof config?.identity === "string" && config.identity.trim()
      ? config.identity.trim()
      : null;
  } catch {
    return null;
  }
}

export function detectIdentity(env = process.env, configPath = LOCAL_CODESIGN_CONFIG) {
  return env.COWORK_CODESIGN_IDENTITY?.trim() || readLocalIdentity(configPath);
}

export function isSigningEnabled(env = process.env, configPath = LOCAL_CODESIGN_CONFIG) {
  const raw = String(env.COWORK_CODESIGN_ENABLE || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw) || Boolean(detectIdentity(env, configPath));
}

function isSignatureValid() {
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", ELECTRON_APP], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function checkCurrentSignature() {
  const result = spawnSync("codesign", ["-dvvv", ELECTRON_APP], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if ((result.status ?? 1) !== 0) {
    return "unknown";
  }

  try {
    const details = `${result.stdout || ""}${result.stderr || ""}`;
    if (!isSignatureValid()) return "invalid";
    if (details.includes("Signature=adhoc")) return "adhoc";
    const teamMatch = details.match(/TeamIdentifier=(\S+)/);
    if (teamMatch && teamMatch[1] !== "not" && teamMatch[1] !== "not set") {
      return "signed";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function selectSigningPlan(currentSig, identity, signingEnabled = false) {
  if (currentSig === "invalid") {
    return {
      action: "sign",
      message: identity
        ? `Electron.app signature is invalid; signing with: ${identity}`
        : "Electron.app signature is invalid; applying an ad-hoc development signature.",
      signingIdentity: identity || "-",
      timestamp: Boolean(identity),
      useEntitlements: Boolean(identity),
    };
  }

  if (!signingEnabled) {
    return {
      action: "skip",
      message:
        "Skipping Electron.app development signing. Set COWORK_CODESIGN_IDENTITY or add .cowork/dev-codesign.json to sign with a stable identity.",
    };
  }

  if (!identity && currentSig === "adhoc") {
    return {
      action: "skip",
      message: "Electron.app is already ad-hoc signed — skipping.",
    };
  }

  return {
    action: "sign",
    message: identity
      ? `Signing Electron.app with: ${identity}`
      : currentSig === "signed"
        ? "Replacing existing team signature with an ad-hoc development signature."
        : "No signing identity configured; applying an ad-hoc development signature.",
    signingIdentity: identity || "-",
    timestamp: Boolean(identity),
    useEntitlements: Boolean(identity),
  };
}

export function main(env = process.env) {
  if (env.COWORK_CODESIGN_SKIP === "1") {
    log("Skipping (COWORK_CODESIGN_SKIP=1).");
    return 0;
  }

  if (process.platform !== "darwin") {
    log("Skipping on non-macOS platform.");
    return 0;
  }

  if (!existsSync(ELECTRON_APP)) {
    log(`Electron.app not found at ${ELECTRON_APP} — skipping.`);
    return 0;
  }

  const currentSig = checkCurrentSignature();
  const identity = detectIdentity(env);
  const plan = selectSigningPlan(currentSig, identity, isSigningEnabled(env));
  log(plan.message);

  if (plan.action === "skip") {
    return 0;
  }

  const entitlementsArgs =
    plan.useEntitlements && existsSync(ENTITLEMENTS) ? ["--entitlements", ENTITLEMENTS] : [];
  const timestampArgs = plan.timestamp ? ["--timestamp"] : [];

  try {
    execFileSync(
      "codesign",
      [
        "--force",
        "--deep",
        "--sign",
        plan.signingIdentity,
        ...entitlementsArgs,
        ...timestampArgs,
        ELECTRON_APP,
      ],
      { stdio: "inherit", timeout: 60_000 },
    );
    log("Done — Electron.app signed successfully.");
  } catch (err) {
    log(`Signing failed: ${err.message}`);
    log("Development will still work, but EDR may flag the unsigned binary.");
  }

  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
