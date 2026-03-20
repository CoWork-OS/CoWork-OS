import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import type { HealthSourceConnectionMode, HealthWritebackItem, HealthWritebackType } from "../../shared/health";

export interface AppleHealthBridgeStatus {
  available: boolean;
  executablePath?: string;
  authorizationStatus: "authorized" | "denied" | "not-determined" | "restricted" | "import-only" | "unavailable";
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
    packagedResources ? path.join(packagedResources, "healthkit-bridge", "HealthKitBridge.app", "Contents", "MacOS", "HealthKitBridge") : "",
    path.resolve(process.cwd(), "build", "healthkit-bridge", "HealthKitBridge.app", "Contents", "MacOS", "HealthKitBridge"),
    packagedResources ? path.join(packagedResources, "healthkit-bridge", "HealthKitBridge") : "",
    path.resolve(process.cwd(), "build", "healthkit-bridge", "HealthKitBridge"),
    path.resolve(process.cwd(), "native", "healthkit-bridge", ".build", "release", "HealthKitBridge"),
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

function provisioningErrorMessage(): string {
  return "Apple Health bridge requires a properly provisioned macOS app bundle. The current helper build was rejected by Launch Services, so HealthKit authorization cannot prompt until Xcode-managed signing/provisioning succeeds.";
}

function runBridge<T>(request: BridgeRequest): Promise<BridgeResponse<T>> {
  return new Promise((resolve, reject) => {
    const shouldUseBundle = !process.env.COWORK_HEALTHKIT_BRIDGE_DIRECT;
    const bundlePath = shouldUseBundle ? resolveBridgeBundle() : null;
    if (bundlePath) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-healthkit-"));
      const requestPath = path.join(tempDir, "request.json");
      const responsePath = path.join(tempDir, "response.json");
      fs.writeFileSync(requestPath, `${JSON.stringify(request)}\n`, "utf8");

      const child = spawn("open", ["-W", "-n", "-a", bundlePath, "--args", "--appkit", "--request-file", requestPath, "--response-file", responsePath], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

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
                message: stderr.trim() || provisioningErrorMessage(),
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
            message: stderr.trim() || provisioningErrorMessage(),
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
