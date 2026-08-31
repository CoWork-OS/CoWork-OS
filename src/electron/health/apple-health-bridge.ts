import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import type {
  HealthSourceConnectionMode,
  HealthWritebackItem,
  HealthWritebackType,
} from "../../shared/health";

export interface AppleHealthBridgeStatus {
  available: boolean;
  executablePath?: string;
  authorizationStatus:
    | "authorized"
    | "denied"
    | "not-determined"
    | "restricted"
    | "import-only"
    | "unavailable";
  readableTypes: HealthWritebackType[];
  writableTypes: HealthWritebackType[];
  sourceMode: HealthSourceConnectionMode;
  lastSyncedAt?: number;
  lastError?: string;
}

export interface AppleHealthBridgeSyncResult {
  permissions: {
    read: boolean;
    write: boolean;
  };
  readableTypes: HealthWritebackType[];
  writableTypes: HealthWritebackType[];
  metrics: Array<{
    key: HealthWritebackType;
    value: number;
    unit: string;
    label: string;
    recordedAt: number;
  }>;
  records: Array<{
    title: string;
    summary: string;
    recordedAt: number;
    sourceLabel: string;
    kind: "wearable" | "lab" | "record" | "manual";
    tags: string[];
  }>;
  sourceMode: HealthSourceConnectionMode;
  lastSyncedAt: number;
}

export interface AppleHealthBridgeAuthorizationResult {
  granted: boolean;
  authorizationStatus: AppleHealthBridgeStatus["authorizationStatus"];
  readableTypes: HealthWritebackType[];
  writableTypes: HealthWritebackType[];
  sourceMode: HealthSourceConnectionMode;
}

export interface AppleHealthBridgeWriteResult {
  writtenCount: number;
  warnings: string[];
}

type BridgeRequest =
  | {
      method: "status";
      sourceMode: HealthSourceConnectionMode;
    }
  | {
      method: "authorize";
      sourceMode: HealthSourceConnectionMode;
      readTypes: HealthWritebackType[];
      writeTypes: HealthWritebackType[];
    }
  | {
      method: "sync";
      sourceId: string;
      sourceMode: HealthSourceConnectionMode;
      readTypes: HealthWritebackType[];
      writeTypes: HealthWritebackType[];
      since?: number;
    }
  | {
      method: "write";
      sourceId: string;
      sourceMode: HealthSourceConnectionMode;
      items: HealthWritebackItem[];
    };

type BridgeResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code?: string; message: string; details?: unknown } };

function isMac(): boolean {
  return process.platform === "darwin";
}

function candidateBridgePaths(): string[] {
  const packagedResources = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  return [
    packagedResources
      ? path.join(
          packagedResources,
          "healthkit-bridge",
          "HealthKitBridge.app",
          "Contents",
          "MacOS",
          "HealthKitBridge",
        )
      : "",
    path.resolve(
      process.cwd(),
      "build",
      "healthkit-bridge",
      "HealthKitBridge.app",
      "Contents",
      "MacOS",
      "HealthKitBridge",
    ),
    packagedResources ? path.join(packagedResources, "healthkit-bridge", "HealthKitBridge") : "",
    path.resolve(process.cwd(), "build", "healthkit-bridge", "HealthKitBridge"),
    path.resolve(
      process.cwd(),
      "native",
      "healthkit-bridge",
      ".build",
      "release",
      "HealthKitBridge",
    ),
    path.resolve(__dirname, "../../../native/healthkit-bridge/.build/release/HealthKitBridge"),
  ].filter(Boolean);
}

function candidateBridgeBundles(): string[] {
  const packagedResources = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  return [
    packagedResources
      ? path.join(packagedResources, "healthkit-bridge", "HealthKitBridge.app")
      : "",
    path.resolve(process.cwd(), "build", "healthkit-bridge", "HealthKitBridge.app"),
  ].filter(Boolean);
}

function resolveBridgeExecutable(): string | null {
  if (!isMac()) return null;
  for (const candidate of candidateBridgePaths()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function resolveBridgeBundle(): string | null {
  if (!isMac()) return null;
  for (const candidate of candidateBridgeBundles()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function parseResponse<T>(raw: string): BridgeResponse<T> {
  return JSON.parse(raw) as BridgeResponse<T>;
}

function embeddedProvisioningProfilePath(bundlePath: string): string {
  return path.join(bundlePath, "Contents", "embedded.provisionprofile");
}

function hasEmbeddedProvisioningProfile(bundlePath: string): boolean {
  return fs.existsSync(embeddedProvisioningProfilePath(bundlePath));
}

function extractBundleIdentifierFromPlist(plistPath: string): string | undefined {
  try {
    const plist = fs.readFileSync(plistPath, "utf8");
    const match = plist.match(
      /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i,
    );
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function readLocalBundleIdentifier(): string | undefined {
  try {
    const configPath = path.resolve(process.cwd(), ".cowork", "healthkit-bridge.json");
    if (!fs.existsSync(configPath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      bundleIdentifier?: unknown;
    };
    return typeof parsed.bundleIdentifier === "string" && parsed.bundleIdentifier.trim().length > 0
      ? parsed.bundleIdentifier.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveProvisioningBundleIdentifier(bundlePath?: string): string {
  const configured =
    process.env.COWORK_HEALTHKIT_BUNDLE_IDENTIFIER ||
    process.env.HEALTHKIT_BRIDGE_BUNDLE_IDENTIFIER ||
    process.env.PRODUCT_BUNDLE_IDENTIFIER ||
    readLocalBundleIdentifier();
  if (configured) return configured;
  if (bundlePath) {
    const bundleIdentifier = extractBundleIdentifierFromPlist(
      path.join(bundlePath, "Contents", "Info.plist"),
    );
    if (bundleIdentifier) return bundleIdentifier;
  }
  return "com.cowork.healthkitbridge";
}

function provisioningErrorMessage(bundlePath?: string): string {
  const profilePath = bundlePath
    ? embeddedProvisioningProfilePath(bundlePath)
    : "the helper app bundle";
  const bundleIdentifier = resolveProvisioningBundleIdentifier(bundlePath);
  return `Apple Health bridge cannot launch because HealthKit uses restricted entitlements and macOS requires an eligible embedded provisioning profile. Missing profile: ${profilePath}. Register this Mac in Apple Developer, create/download a Mac App Development profile for ${bundleIdentifier} with HealthKit enabled, set COWORK_HEALTHKIT_PROVISIONING_PROFILE (or .cowork/healthkit-bridge.json -> provisioningProfile), then rebuild the helper.`;
}

function normalizeBridgeLaunchError(raw: string, bundlePath?: string): string {
  const trimmed = raw.trim();
  if (
    /RBSRequestErrorDomain/i.test(trimmed) ||
    /Launchd job spawn failed/i.test(trimmed) ||
    /cannot be opened for an unexpected reason/i.test(trimmed)
  ) {
    return provisioningErrorMessage(bundlePath);
  }
  return trimmed || provisioningErrorMessage(bundlePath);
}

function runBridge<T>(request: BridgeRequest): Promise<BridgeResponse<T>> {
  return new Promise((resolve, reject) => {
    const shouldUseBundle = !process.env.COWORK_HEALTHKIT_BRIDGE_DIRECT;
    const bundlePath = shouldUseBundle ? resolveBridgeBundle() : null;
    if (bundlePath) {
      if (!hasEmbeddedProvisioningProfile(bundlePath)) {
        resolve({
          ok: false,
          error: {
            code: "BRIDGE_PROVISIONING_REQUIRED",
            message: provisioningErrorMessage(bundlePath),
          },
        });
        return;
      }

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-healthkit-"));
      const requestPath = path.join(tempDir, "request.json");
      const responsePath = path.join(tempDir, "response.json");
      fs.writeFileSync(requestPath, `${JSON.stringify(request)}\n`, "utf8");

      const child = spawn(
        "open",
        [
          "-W",
          "-n",
          "-a",
          bundlePath,
          "--args",
          "--appkit",
          "--request-file",
          requestPath,
          "--response-file",
          responsePath,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );

      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          if (resolveBridgeExecutable() && process.env.COWORK_HEALTHKIT_BRIDGE_DIRECT) {
            // fall through to executable path below
          } else {
            resolve({
              ok: false,
              error: {
                code: "BRIDGE_EXITED",
                message: normalizeBridgeLaunchError(stderr, bundlePath),
              },
            });
            return;
          }
        }

        try {
          const raw = fs.readFileSync(responsePath, "utf8").trim();
          resolve(parseResponse<T>(raw));
        } catch (error) {
          reject(error);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
      return;
    }

    const executablePath = resolveBridgeExecutable();
    if (!executablePath) {
      resolve({
        ok: false,
        error: {
          code: "BRIDGE_UNAVAILABLE",
          message: isMac()
            ? "Apple Health bridge is not built or is missing from the app bundle."
            : "Apple Health bridge is only available on macOS.",
        },
      });
      return;
    }

    const child = spawn(executablePath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          error: {
            code: "BRIDGE_EXITED",
            message: normalizeBridgeLaunchError(stderr, resolveBridgeBundle() || undefined),
          },
        });
        return;
      }

      try {
        resolve(parseResponse<T>(stdout.trim()));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

export class AppleHealthBridge {
  static isAvailable(): boolean {
    return resolveBridgeExecutable() != null;
  }

  static getExecutablePath(): string | null {
    return resolveBridgeExecutable();
  }

  static async getStatus(sourceMode: HealthSourceConnectionMode): Promise<AppleHealthBridgeStatus> {
    const response = await runBridge<AppleHealthBridgeStatus>({
      method: "status",
      sourceMode,
    });
    if (!response.ok) {
      return {
        available: false,
        authorizationStatus: sourceMode === "import" ? "import-only" : "unavailable",
        readableTypes: [],
        writableTypes: [],
        sourceMode,
        lastError: response.error.message,
      };
    }
    return response.data;
  }

  static async authorize(
    sourceMode: HealthSourceConnectionMode,
    readTypes: HealthWritebackType[],
    writeTypes: HealthWritebackType[],
  ): Promise<AppleHealthBridgeAuthorizationResult> {
    const response = await runBridge<AppleHealthBridgeAuthorizationResult>({
      method: "authorize",
      sourceMode,
      readTypes,
      writeTypes,
    });
    if (!response.ok) {
      return {
        granted: false,
        authorizationStatus: sourceMode === "import" ? "import-only" : "unavailable",
        readableTypes: readTypes,
        writableTypes: writeTypes,
        sourceMode,
      };
    }
    return response.data;
  }

  static async sync(
    sourceId: string,
    sourceMode: HealthSourceConnectionMode,
    readTypes: HealthWritebackType[],
    writeTypes: HealthWritebackType[],
    since?: number,
  ): Promise<AppleHealthBridgeSyncResult | null> {
    const response = await runBridge<AppleHealthBridgeSyncResult>({
      method: "sync",
      sourceId,
      sourceMode,
      readTypes,
      writeTypes,
      since,
    });
    return response.ok ? response.data : null;
  }

  static async write(
    sourceId: string,
    sourceMode: HealthSourceConnectionMode,
    items: HealthWritebackItem[],
  ): Promise<AppleHealthBridgeWriteResult | null> {
    const response = await runBridge<AppleHealthBridgeWriteResult>({
      method: "write",
      sourceId,
      sourceMode,
      items,
    });
    return response.ok ? response.data : null;
  }
}
