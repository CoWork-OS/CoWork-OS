import { existsSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, cpSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const isMac = process.platform === "darwin";
if (!isMac) {
  console.log("[healthkit-bridge] Skipping build on non-macOS platform.");
  process.exit(0);
}

const packagePath = join(process.cwd(), "native", "healthkit-bridge");
const buildOutput = join(packagePath, ".build", "release", "HealthKitBridge");
const swiftCacheRoot =
  process.env.COWORK_HEALTHKIT_SWIFTPM_CACHE_DIR || join(packagePath, ".build", "swiftpm-cache");
const swiftHome = process.env.COWORK_HEALTHKIT_SWIFTPM_HOME || join(swiftCacheRoot, "home");
const swiftSharedCache = join(swiftCacheRoot, "shared-cache");
const swiftConfigPath = join(swiftCacheRoot, "configuration");
const swiftSecurityPath = join(swiftCacheRoot, "security");
const swiftModuleCache = join(swiftCacheRoot, "ModuleCache");
const destinationDir = join(process.cwd(), "build", "healthkit-bridge");
const destination = join(destinationDir, "HealthKitBridge");
const appBundle = join(destinationDir, "HealthKitBridge.app");
const appContents = join(appBundle, "Contents");
const appMacOS = join(appContents, "MacOS");
const appExecutable = join(appMacOS, "HealthKitBridge");
const pkgInfo = "APPL????\n";
const localConfigPath = join(process.cwd(), ".cowork", "healthkit-bridge.json");
const localConfig = readLocalConfig(localConfigPath);
const appName = process.env.COWORK_HEALTHKIT_APP_NAME || localConfig.appName || "CoWork Health Sync";
const useXcodeBuild =
  process.env.COWORK_HEALTHKIT_USE_XCODE_BUILD === "1" || localConfig.useXcodeBuild === true;
const developmentTeam =
  process.env.COWORK_HEALTHKIT_DEVELOPMENT_TEAM || process.env.DEVELOPMENT_TEAM || localConfig.developmentTeam || "";
const bundleIdentifier =
  process.env.COWORK_HEALTHKIT_BUNDLE_IDENTIFIER ||
  process.env.HEALTHKIT_BRIDGE_BUNDLE_IDENTIFIER ||
  localConfig.bundleIdentifier ||
  process.env.PRODUCT_BUNDLE_IDENTIFIER ||
  "com.cowork.healthkitbridge";
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>HealthKitBridge</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>
    <string>MacOSX</string>
  </array>
  <key>LSUIElement</key>
  <true/>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>NSHealthShareUsageDescription</key>
  <string>CoWork needs access to your Health data to connect Apple Health, read metrics, and generate insights.</string>
  <key>NSHealthUpdateUsageDescription</key>
  <string>CoWork needs access to your Health data to write approved health updates back to Apple Health.</string>
  <key>NSHealthClinicalHealthRecordsShareUsageDescription</key>
  <string>CoWork needs access to clinical health records you choose to share with the app.</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
`;

mkdirSync(swiftHome, { recursive: true });
mkdirSync(swiftSharedCache, { recursive: true });
mkdirSync(swiftConfigPath, { recursive: true });
mkdirSync(swiftSecurityPath, { recursive: true });
mkdirSync(swiftModuleCache, { recursive: true });
const swiftBuildEnv = {
  ...process.env,
  HOME: swiftHome,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || swiftCacheRoot,
  CLANG_MODULE_CACHE_PATH: process.env.CLANG_MODULE_CACHE_PATH || swiftModuleCache,
  SWIFT_MODULE_CACHE_PATH: process.env.SWIFT_MODULE_CACHE_PATH || swiftModuleCache,
};

function readLocalConfig(configPath) {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn(`[healthkit-bridge] Ignoring invalid local config at ${configPath}: ${error.message}`);
    return {};
  }
}

function findAppleDevelopmentIdentityForTeam(teamId, identities) {
  if (!teamId) {
    return "";
  }

  for (const identity of identities) {
    if (!identity.startsWith("Apple Development: ")) {
      continue;
    }

    const certificate = spawnSync("security", ["find-certificate", "-c", identity, "-p"], {
      encoding: "utf8",
      env: process.env,
    });
    if (certificate.status !== 0 || !certificate.stdout) {
      continue;
    }

    const subject = spawnSync("openssl", ["x509", "-noout", "-subject"], {
      encoding: "utf8",
      env: process.env,
      input: certificate.stdout,
    });
    if (subject.status !== 0 || !subject.stdout) {
      continue;
    }

    if (subject.stdout.includes(`OU=${teamId}`)) {
      return identity;
    }
  }

  return "";
}

function findMatchingProvisioningProfile(teamId, bundleId) {
  if (!teamId || !bundleId) {
    return "";
  }

  const candidateDirectories = [
    join(homedir(), "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"),
    join(homedir(), "Library", "MobileDevice", "Provisioning Profiles"),
  ];

  for (const directory of candidateDirectories) {
    if (!existsSync(directory)) {
      continue;
    }

    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".mobileprovision") && !entry.endsWith(".provisionprofile")) {
        continue;
      }

      const candidatePath = join(directory, entry);
      const decodedProfile = spawnSync("security", ["cms", "-D", "-i", candidatePath], {
        encoding: "utf8",
        env: process.env,
      });
      if (decodedProfile.status !== 0 || !decodedProfile.stdout) {
        continue;
      }

      const profileXml = decodedProfile.stdout;
      if (!profileXml.includes(`<string>${teamId}</string>`)) {
        continue;
      }
      if (!profileXml.includes(`${teamId}.${bundleId}`)) {
        continue;
      }
      if (!profileXml.includes("com.apple.developer.healthkit")) {
        continue;
      }

      return candidatePath;
    }
  }

  return "";
}

const identities = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
  encoding: "utf8",
  env: process.env,
});
const identitiesOutput = identities.stdout || "";
const quotedIdentityMatches = [...identitiesOutput.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const matchingTeamIdentity = findAppleDevelopmentIdentityForTeam(developmentTeam, quotedIdentityMatches);
const configuredSigningIdentity =
  process.env.COWORK_HEALTHKIT_SIGNING_IDENTITY ||
  localConfig.signingIdentity ||
  "";
const signingIdentity = configuredSigningIdentity || matchingTeamIdentity || "-";

if (!configuredSigningIdentity && !matchingTeamIdentity) {
  console.warn(
    "[healthkit-bridge] No usable Apple Development identity matched the configured team; using an ad-hoc signature.",
  );
}

const xcodeProjectPath = join(packagePath, "HealthKitBridge.xcodeproj");
const xcodeAppBundle = join(packagePath, ".build", "xcode", "Build", "Products", "Release", "HealthKitBridge.app");

if (existsSync(xcodeProjectPath) && developmentTeam && useXcodeBuild) {
  const xcodebuildArgs = [
    "-project",
    xcodeProjectPath,
    "-scheme",
    "HealthKitBridge",
    "-configuration",
    "Release",
    "-derivedDataPath",
    join(packagePath, ".build", "xcode"),
    "-allowProvisioningUpdates",
    "CODE_SIGN_STYLE=Automatic",
    "CODE_SIGN_IDENTITY=Apple Development",
    `PRODUCT_BUNDLE_IDENTIFIER=${bundleIdentifier}`,
    "ENABLE_HARDENED_RUNTIME=YES",
  ];
  if (developmentTeam) {
    xcodebuildArgs.push(`DEVELOPMENT_TEAM=${developmentTeam}`);
  }
  const xcodebuild = spawnSync(
    "xcodebuild",
    xcodebuildArgs,
    { stdio: "inherit", env: process.env },
  );

  if (xcodebuild.status === 0 && existsSync(xcodeAppBundle)) {
    mkdirSync(destinationDir, { recursive: true });
    cpSync(xcodeAppBundle, appBundle, { recursive: true, force: true });
    copyFileSync(join(appBundle, "Contents", "MacOS", "HealthKitBridge"), destination);
    chmodSync(destination, 0o755);
    console.log(`[healthkit-bridge] Built app target at ${appBundle}`);
    process.exit(0);
  }

  console.warn("[healthkit-bridge] Xcode app build failed or did not produce a bundle; falling back to SwiftPM packaging.");
} else if (!developmentTeam) {
  console.log("[healthkit-bridge] Skipping Xcode app build because no development team is configured.");
} else if (!useXcodeBuild) {
  console.log("[healthkit-bridge] Skipping Xcode app build; set COWORK_HEALTHKIT_USE_XCODE_BUILD=1 to enable it.");
}

const build = spawnSync("swift", [
  "build",
  "--disable-sandbox",
  "--cache-path",
  swiftSharedCache,
  "--config-path",
  swiftConfigPath,
  "--security-path",
  swiftSecurityPath,
  "--manifest-cache",
  "local",
  "--package-path",
  packagePath,
  "-c",
  "release",
  "-Xcc",
  `-fmodules-cache-path=${swiftModuleCache}`,
  "-Xswiftc",
  "-module-cache-path",
  "-Xswiftc",
  swiftModuleCache,
], {
  stdio: "inherit",
  env: swiftBuildEnv,
});

if (build.status !== 0) {
  console.error("[healthkit-bridge] swift build failed.");
  process.exit(build.status ?? 1);
}

if (!existsSync(buildOutput)) {
  console.error(`[healthkit-bridge] Expected binary not found at ${buildOutput}`);
  process.exit(1);
}

mkdirSync(destinationDir, { recursive: true });
copyFileSync(buildOutput, destination);
chmodSync(destination, 0o755);
mkdirSync(appMacOS, { recursive: true });
writeFileSync(join(appContents, "Info.plist"), infoPlist);
writeFileSync(join(appContents, "PkgInfo"), pkgInfo);
copyFileSync(buildOutput, appExecutable);
chmodSync(appExecutable, 0o755);
const provisioningProfile = process.env.COWORK_HEALTHKIT_PROVISIONING_PROFILE || process.env.HEALTHKIT_BRIDGE_PROVISIONING_PROFILE;
const resolvedProvisioningProfile =
  provisioningProfile ||
  localConfig.provisioningProfile ||
  findMatchingProvisioningProfile(developmentTeam, bundleIdentifier);
if (resolvedProvisioningProfile && existsSync(resolvedProvisioningProfile)) {
  copyFileSync(resolvedProvisioningProfile, join(appContents, "embedded.provisionprofile"));
  console.log(`[healthkit-bridge] Embedded provisioning profile ${resolvedProvisioningProfile}`);
}
function signApp(identity, captureOutput = false) {
  return spawnSync(
    "codesign",
    [
      "--force",
      "--sign",
      identity,
      "--options",
      "runtime",
      "--entitlements",
      join(packagePath, "HealthKitBridge.entitlements"),
      appBundle,
    ],
    {
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
      env: process.env,
    },
  );
}

const automaticSigning = !configuredSigningIdentity && Boolean(matchingTeamIdentity);
let codesign = signApp(signingIdentity, automaticSigning);
if (codesign.status !== 0 && automaticSigning) {
  const diagnostics = `${codesign.stdout || ""}${codesign.stderr || ""}`.trim();
  console.warn(
    `[healthkit-bridge] Automatic signing with ${signingIdentity} failed; retrying with an ad-hoc signature.${
      diagnostics ? `\n${diagnostics}` : ""
    }`,
  );
  codesign = signApp("-");
  if (codesign.status === 0) {
    console.warn(
      "[healthkit-bridge] Built with an ad-hoc signature; HealthKit access requires a valid Apple Development identity and provisioning profile.",
    );
  }
}
if (codesign.status !== 0) {
  console.error("[healthkit-bridge] codesign failed.");
  process.exit(codesign.status ?? 1);
}
console.log(`[healthkit-bridge] Copied helper to ${destination}`);
