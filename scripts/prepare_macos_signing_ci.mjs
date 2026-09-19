#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fail(message) {
  process.stderr.write(`[macos-signing] ${message}\n`);
  process.exit(1);
}

function hasValue(value) {
  return Boolean(String(value || "").trim());
}

function appendGithubEnv(name, value) {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) return;
  fs.appendFileSync(githubEnv, `${name}=${value}\n`);
}

function writeKeyFile(contents, suffix = ".p8") {
  const dir = process.env.RUNNER_TEMP || os.tmpdir();
  const filePath = path.join(dir, `cowork-apple-api-key-${Date.now()}${suffix}`);
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  appendGithubEnv("APPLE_API_KEY", filePath);
  return filePath;
}

function prepareAppleApiKey() {
  const base64Key = String(process.env.APPLE_API_KEY_BASE64 || "").trim();
  if (base64Key) {
    const decoded = Buffer.from(base64Key, "base64").toString("utf8");
    if (!decoded.includes("BEGIN PRIVATE KEY")) {
      fail("APPLE_API_KEY_BASE64 did not decode to an App Store Connect private key.");
    }
    return writeKeyFile(decoded);
  }

  const keyContents = String(process.env.APPLE_API_KEY_CONTENT || "").trim();
  if (keyContents) {
    if (!keyContents.includes("BEGIN PRIVATE KEY")) {
      fail("APPLE_API_KEY_CONTENT is set but does not look like an App Store Connect private key.");
    }
    return writeKeyFile(`${keyContents}\n`);
  }

  const keyPath = String(process.env.APPLE_API_KEY || "").trim();
  if (keyPath) {
    if (keyPath.includes("BEGIN PRIVATE KEY")) {
      return writeKeyFile(`${keyPath}\n`);
    }
    if (!fs.existsSync(keyPath)) {
      fail(
        "APPLE_API_KEY is set but does not point to a file. In GitHub Actions, use APPLE_API_KEY_BASE64 or APPLE_API_KEY_CONTENT.",
      );
    }
    return keyPath;
  }

  return null;
}

function hasSigningIdentity() {
  return hasValue(process.env.CSC_LINK) || hasValue(process.env.CSC_NAME);
}

function hasAppleIdNotarization() {
  return (
    hasValue(process.env.APPLE_ID) &&
    hasValue(process.env.APPLE_APP_SPECIFIC_PASSWORD) &&
    hasValue(process.env.APPLE_TEAM_ID)
  );
}

function hasApiKeyNotarization() {
  const keyPath = prepareAppleApiKey();
  return (
    Boolean(keyPath) &&
    hasValue(process.env.APPLE_API_KEY_ID) &&
    hasValue(process.env.APPLE_API_ISSUER)
  );
}

function hasKeychainProfileNotarization() {
  return hasValue(process.env.APPLE_KEYCHAIN_PROFILE);
}

function main() {
  if (!hasSigningIdentity()) {
    fail(
      [
        "macOS release builds must be Developer ID signed.",
        "Configure CSC_LINK (+ CSC_KEY_PASSWORD) or CSC_NAME before publishing a macOS release.",
      ].join("\n"),
    );
  }

  if (!hasAppleIdNotarization() && !hasApiKeyNotarization() && !hasKeychainProfileNotarization()) {
    fail(
      [
        "macOS release builds must be notarized.",
        "Configure APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID,",
        "or APPLE_API_KEY_BASE64/APPLE_API_KEY_CONTENT + APPLE_API_KEY_ID + APPLE_API_ISSUER,",
        "or APPLE_KEYCHAIN_PROFILE.",
      ].join("\n"),
    );
  }

  process.stdout.write(
    "[macos-signing] Developer ID signing and notarization inputs are configured.\n",
  );
}

main();
