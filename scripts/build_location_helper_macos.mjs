import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const isMac = process.platform === "darwin";
const packagePath = join(process.cwd(), "native", "location-helper-macos");
const executableName = "CoWorkLocationHelper";
const buildOutput = join(packagePath, ".build", "release", executableName);
const swiftCacheRoot =
  process.env.COWORK_LOCATION_SWIFTPM_CACHE_DIR ||
  join(packagePath, ".build", "swiftpm-cache");
const swiftHome = process.env.COWORK_LOCATION_SWIFTPM_HOME || join(swiftCacheRoot, "home");
const swiftSharedCache = join(swiftCacheRoot, "shared-cache");
const swiftConfigPath = join(swiftCacheRoot, "configuration");
const swiftSecurityPath = join(swiftCacheRoot, "security");
const swiftModuleCache = join(swiftCacheRoot, "ModuleCache");
const destinationDir = join(process.cwd(), "build", "location-helper-macos");
const destination = join(destinationDir, executableName);
const appBundle = join(destinationDir, `${executableName}.app`);
const appContents = join(appBundle, "Contents");
const appMacOS = join(appContents, "MacOS");
const appExecutable = join(appMacOS, executableName);
const bundleIdentifier =
  process.env.COWORK_LOCATION_HELPER_BUNDLE_IDENTIFIER || "com.cowork-os.location-helper";
const appName = "CoWork Location Helper";
const pkgInfo = "APPL????\n";
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>${executableName}</string>
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
  <key>NSLocationWhenInUseUsageDescription</key>
  <string>CoWork OS uses your current location once to answer nearby places and walking route requests.</string>
  <key>NSLocationUsageDescription</key>
  <string>CoWork OS uses your current location once to answer nearby places and walking route requests.</string>
  <key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
  <string>CoWork OS uses your current location once to answer nearby places and walking route requests.</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
`;

if (!isMac) {
  console.log("[location-helper-macos] Skipping build on non-macOS platform.");
  process.exit(0);
}

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
  console.error("[location-helper-macos] swift build failed.");
  process.exit(build.status ?? 1);
}

if (!existsSync(buildOutput)) {
  console.error(`[location-helper-macos] Expected binary not found at ${buildOutput}`);
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

const entitlements = join(packagePath, "CoWorkLocationHelper.entitlements");
const codesign = spawnSync(
  "codesign",
  ["--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, appBundle],
  { stdio: "inherit", env: process.env },
);
if (codesign.status !== 0) {
  console.error("[location-helper-macos] codesign failed.");
  process.exit(codesign.status ?? 1);
}

console.log(`[location-helper-macos] Copied helper to ${destination}`);
