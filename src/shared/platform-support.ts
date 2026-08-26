import platformSupportJson from "./platform-support.json";

export interface PlatformCompatibility {
  supported: boolean;
  minimumSystemVersion?: string;
  minimumSystemLabel?: string;
  lastCompatibleVersion?: string;
  unsupportedReason?: string;
  recoveryCommand?: string;
}

export const PLATFORM_SUPPORT = platformSupportJson;

export function compareVersions(left: string, right: string): number {
  const normalize = (value: string): number[] =>
    value
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

export function getUpdatePlatformCompatibility(options: {
  platform: NodeJS.Platform | string;
  release: string;
  targetVersion: string;
}): PlatformCompatibility {
  const { platform, release, targetVersion } = options;
  if (platform !== "darwin") return { supported: true };

  const macos = PLATFORM_SUPPORT.macos;
  if (compareVersions(targetVersion, macos.lastMontereyCompatibleVersion) <= 0) {
    return { supported: true };
  }

  const currentDarwinMajor = Number.parseInt(release.split(".")[0] || "", 10);
  const minimumDarwinMajor = Number.parseInt(macos.minimumDarwinVersion.split(".")[0], 10);
  if (Number.isFinite(currentDarwinMajor) && currentDarwinMajor >= minimumDarwinMajor) {
    return { supported: true };
  }

  const unsupportedReason = Number.isFinite(currentDarwinMajor)
    ? `CoWork OS ${targetVersion} requires ${macos.minimumLabel} or later. This Mac is running an older macOS release.`
    : `CoWork OS ${targetVersion} requires ${macos.minimumLabel} or later, but this Mac's system version could not be verified.`;

  return {
    supported: false,
    minimumSystemVersion: macos.minimumProductVersion,
    minimumSystemLabel: macos.minimumLabel,
    lastCompatibleVersion: macos.lastMontereyCompatibleVersion,
    unsupportedReason: `${unsupportedReason} CoWork OS ${macos.lastMontereyCompatibleVersion} is the final Monterey-compatible release. Your existing CoWork data will not be removed.`,
    recoveryCommand: `npm install -g cowork-os@${macos.lastMontereyCompatibleVersion}`,
  };
}
