"use strict";

const os = require("node:os");
const policy = require("../src/shared/platform-support.json");

function compareVersions(left, right) {
  const normalize = (value) =>
    String(value)
      .replace(/^v/, "")
      .replace(/-/g, ".")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const leftParts = normalize(left);
  const rightParts = normalize(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function getLauncherPlatformCompatibility(options = {}) {
  const platform = options.platform || process.platform;
  const release = options.release || os.release();
  const targetVersion = options.targetVersion;
  if (platform !== "darwin") return { supported: true };

  const macos = policy.macos;
  if (compareVersions(targetVersion, macos.lastMontereyCompatibleVersion) <= 0) {
    return { supported: true };
  }

  const currentDarwinMajor = Number.parseInt(String(release).split(".")[0] || "", 10);
  const minimumDarwinMajor = Number.parseInt(macos.minimumDarwinVersion.split(".")[0], 10);
  if (Number.isFinite(currentDarwinMajor) && currentDarwinMajor >= minimumDarwinMajor) {
    return { supported: true };
  }

  const reason = Number.isFinite(currentDarwinMajor)
    ? `CoWork OS ${targetVersion} requires ${macos.minimumLabel} or later. This Mac is running an older macOS release.`
    : `CoWork OS ${targetVersion} requires ${macos.minimumLabel} or later, but this Mac's system version could not be verified.`;

  return {
    supported: false,
    message: [
      reason,
      `CoWork OS ${macos.lastMontereyCompatibleVersion} is the final Monterey-compatible release.`,
      "Your existing CoWork data will not be removed.",
      "To reinstall the compatible npm release, run:",
      `  npm install -g cowork-os@${macos.lastMontereyCompatibleVersion}`,
    ].join("\n"),
  };
}

module.exports = {
  compareVersions,
  getLauncherPlatformCompatibility,
  policy,
};
