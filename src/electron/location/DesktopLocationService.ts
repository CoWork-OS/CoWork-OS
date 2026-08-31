import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface DesktopLocationRequest {
  accuracy?: "coarse" | "precise";
  maxAgeMs?: number;
  timeoutMs?: number;
}

export type DesktopLocationSource =
  | "macos_core_location"
  | "windows_location"
  | "linux_geoclue"
  | "ip_geolocation";

export interface DesktopLocationSnapshot {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  timestamp: number;
  source: DesktopLocationSource;
}

export type DesktopLocationErrorCode =
  | "LOCATION_DENIED"
  | "LOCATION_UNAVAILABLE"
  | "LOCATION_TIMEOUT"
  | "LOCATION_NOT_CONFIGURED"
  | "LOCATION_UNSUPPORTED_PLATFORM";

export class DesktopLocationError extends Error {
  constructor(
    readonly code: DesktopLocationErrorCode,
    message: string,
    readonly provider?: string,
  ) {
    super(message);
    this.name = "DesktopLocationError";
  }
}

export interface NativeLocationProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  getCurrentLocation(request?: DesktopLocationRequest): Promise<DesktopLocationSnapshot>;
}

interface LocationHelperEnvelope {
  ok?: boolean;
  location?: Partial<DesktopLocationSnapshot>;
  error?: {
    code?: DesktopLocationErrorCode;
    message?: string;
  };
}

interface LocationProviderOptions {
  platform?: NodeJS.Platform;
  helperPath?: string;
  existsSync?: (candidatePath: string) => boolean;
  runner?: typeof execFileAsync;
  readFileSync?: typeof fs.readFileSync;
  unlinkSync?: typeof fs.unlinkSync;
  tmpdir?: () => string;
}

type MacOSCoreLocationProviderOptions = LocationProviderOptions;

const DEFAULT_TIMEOUT_MS = 15000;
const LOCATION_HELPER_DIR = "location-helper-macos";
const LOCATION_HELPER_EXECUTABLE = "CoWorkLocationHelper";

const VALID_LOCATION_SOURCES: ReadonlySet<string> = new Set<DesktopLocationSource>([
  "macos_core_location",
  "windows_location",
  "linux_geoclue",
  "ip_geolocation",
]);

export function registerLocationProbeScheme(): void {
  // Native OS providers do not need Electron's Chromium geolocation permission probe.
  // Keep this no-op for older startup code that registers location during app bootstrap.
}

export class MacOSCoreLocationProvider implements NativeLocationProvider {
  readonly name = "macos_core_location";
  private readonly platform: NodeJS.Platform;
  private readonly helperPath?: string;
  private readonly existsSync: (candidatePath: string) => boolean;
  private readonly runner: typeof execFileAsync;
  private readonly readFileSync: typeof fs.readFileSync;
  private readonly unlinkSync: typeof fs.unlinkSync;
  private readonly tmpdir: () => string;

  constructor(options: MacOSCoreLocationProviderOptions = {}) {
    this.platform = options.platform || process.platform;
    this.helperPath = options.helperPath;
    this.existsSync = options.existsSync || fs.existsSync;
    this.runner = options.runner || execFileAsync;
    this.readFileSync = options.readFileSync || fs.readFileSync;
    this.unlinkSync = options.unlinkSync || fs.unlinkSync;
    this.tmpdir = options.tmpdir || os.tmpdir;
  }

  async isAvailable(): Promise<boolean> {
    return this.platform === "darwin" && Boolean(this.resolveHelperTarget());
  }

  async getCurrentLocation(request: DesktopLocationRequest = {}): Promise<DesktopLocationSnapshot> {
    if (this.platform !== "darwin") {
      throw new DesktopLocationError(
        "LOCATION_UNSUPPORTED_PLATFORM",
        "macOS Core Location is only available on macOS.",
        this.name,
      );
    }

    const helper = this.resolveHelperTarget();
    if (!helper) {
      throw new DesktopLocationError(
        "LOCATION_NOT_CONFIGURED",
        "macOS Core Location helper is not built or bundled.",
        this.name,
      );
    }

    const timeoutMs = clampPositiveInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000);
    const accuracy = request.accuracy === "coarse" ? "coarse" : "precise";
    const responsePath = path.join(
      this.tmpdir(),
      `cowork-location-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    const helperArgs = [
      "--accuracy",
      accuracy,
      "--timeout-ms",
      String(timeoutMs),
      "--response-file",
      responsePath,
    ];

    try {
      if (helper.kind === "app") {
        await this.runner("/usr/bin/open", ["-W", "-n", helper.path, "--args", ...helperArgs], {
          timeout: timeoutMs + 3000,
          maxBuffer: 128 * 1024,
        });
        return parseHelperSuccess(String(this.readFileSync(responsePath, "utf8")), this.name);
      }

      const { stdout } = await this.runner(helper.path, helperArgs, {
        timeout: timeoutMs + 1000,
        maxBuffer: 128 * 1024,
      });
      return parseHelperSuccess(
        stdout || String(this.readFileSync(responsePath, "utf8")),
        this.name,
      );
    } catch (error) {
      try {
        if (this.existsSync(responsePath)) {
          return parseHelperSuccess(String(this.readFileSync(responsePath, "utf8")), this.name);
        }
      } catch {
        // Fall through to the process error when the response file was not readable.
      }
      throw parseHelperError(error, this.name);
    } finally {
      try {
        if (this.existsSync(responsePath)) this.unlinkSync(responsePath);
      } catch {
        // Best-effort cleanup of transient helper output.
      }
    }
  }

  private resolveHelperTarget(): { kind: "app" | "executable"; path: string } | null {
    const candidates = this.helperPath
      ? [{ kind: "executable" as const, path: this.helperPath }]
      : getMacOSLocationHelperCandidates();
    for (const candidate of candidates) {
      if (this.existsSync(candidate.path)) return candidate;
    }
    return null;
  }
}

export class WindowsLocationProvider implements NativeLocationProvider {
  readonly name = "windows_location";
  private readonly platform: NodeJS.Platform;
  private readonly helperPath?: string;
  private readonly existsSync: (candidatePath: string) => boolean;
  private readonly runner: typeof execFileAsync;
  private readonly readFileSync: typeof fs.readFileSync;
  private readonly unlinkSync: typeof fs.unlinkSync;
  private readonly tmpdir: () => string;

  constructor(options: LocationProviderOptions = {}) {
    this.platform = options.platform || process.platform;
    this.helperPath = options.helperPath;
    this.existsSync = options.existsSync || fs.existsSync;
    this.runner = options.runner || execFileAsync;
    this.readFileSync = options.readFileSync || fs.readFileSync;
    this.unlinkSync = options.unlinkSync || fs.unlinkSync;
    this.tmpdir = options.tmpdir || os.tmpdir;
  }

  async isAvailable(): Promise<boolean> {
    return this.platform === "win32" && Boolean(this.resolveHelperScript());
  }

  async getCurrentLocation(request: DesktopLocationRequest = {}): Promise<DesktopLocationSnapshot> {
    if (this.platform !== "win32") {
      throw new DesktopLocationError(
        "LOCATION_UNSUPPORTED_PLATFORM",
        "Windows Location is only available on Windows.",
        this.name,
      );
    }

    const scriptPath = this.resolveHelperScript();
    if (!scriptPath) {
      throw new DesktopLocationError(
        "LOCATION_NOT_CONFIGURED",
        "Windows Location helper is not built or bundled.",
        this.name,
      );
    }

    const timeoutMs = clampPositiveInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000);
    const accuracy = request.accuracy === "coarse" ? "coarse" : "precise";
    const responsePath = path.join(
      this.tmpdir(),
      `cowork-location-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    const psArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "--accuracy",
      accuracy,
      "--timeout-ms",
      String(timeoutMs),
      "--response-file",
      responsePath,
    ];

    try {
      const { stdout } = await this.runner(resolveWindowsPowerShell(), psArgs, {
        timeout: timeoutMs + 3000,
        maxBuffer: 128 * 1024,
      });
      return parseHelperSuccess(
        stdout || String(this.readFileSync(responsePath, "utf8")),
        this.name,
      );
    } catch (error) {
      try {
        if (this.existsSync(responsePath)) {
          return parseHelperSuccess(String(this.readFileSync(responsePath, "utf8")), this.name);
        }
      } catch {
        // Fall through to the process error when the response file was not readable.
      }
      throw parseHelperError(error, this.name);
    } finally {
      try {
        if (this.existsSync(responsePath)) this.unlinkSync(responsePath);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  private resolveHelperScript(): string | null {
    const candidates = this.helperPath ? [this.helperPath] : getWindowsLocationHelperCandidates();
    for (const candidate of candidates) {
      if (this.existsSync(candidate)) return candidate;
    }
    return null;
  }
}

export class LinuxGeoClueProvider implements NativeLocationProvider {
  readonly name = "linux_geoclue";
  private readonly platform: NodeJS.Platform;
  private readonly helperPath?: string;
  private readonly existsSync: (candidatePath: string) => boolean;
  private readonly runner: typeof execFileAsync;
  private readonly readFileSync: typeof fs.readFileSync;
  private readonly unlinkSync: typeof fs.unlinkSync;
  private readonly tmpdir: () => string;

  constructor(options: LocationProviderOptions = {}) {
    this.platform = options.platform || process.platform;
    this.helperPath = options.helperPath;
    this.existsSync = options.existsSync || fs.existsSync;
    this.runner = options.runner || execFileAsync;
    this.readFileSync = options.readFileSync || fs.readFileSync;
    this.unlinkSync = options.unlinkSync || fs.unlinkSync;
    this.tmpdir = options.tmpdir || os.tmpdir;
  }

  async isAvailable(): Promise<boolean> {
    return this.platform === "linux" && Boolean(this.resolveHelperScript());
  }

  async getCurrentLocation(request: DesktopLocationRequest = {}): Promise<DesktopLocationSnapshot> {
    if (this.platform !== "linux") {
      throw new DesktopLocationError(
        "LOCATION_UNSUPPORTED_PLATFORM",
        "Linux GeoClue is only available on Linux.",
        this.name,
      );
    }

    const scriptPath = this.resolveHelperScript();
    if (!scriptPath) {
      throw new DesktopLocationError(
        "LOCATION_NOT_CONFIGURED",
        "Linux GeoClue location helper is not built or bundled.",
        this.name,
      );
    }

    const timeoutMs = clampPositiveInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000);
    const accuracy = request.accuracy === "coarse" ? "coarse" : "precise";
    const responsePath = path.join(
      this.tmpdir(),
      `cowork-location-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    const scriptArgs = [
      scriptPath,
      "--accuracy",
      accuracy,
      "--timeout-ms",
      String(timeoutMs),
      "--response-file",
      responsePath,
    ];

    try {
      const { stdout } = await this.runner("/bin/bash", scriptArgs, {
        timeout: timeoutMs + 3000,
        maxBuffer: 128 * 1024,
      });
      return parseHelperSuccess(
        stdout || String(this.readFileSync(responsePath, "utf8")),
        this.name,
      );
    } catch (error) {
      try {
        if (this.existsSync(responsePath)) {
          return parseHelperSuccess(String(this.readFileSync(responsePath, "utf8")), this.name);
        }
      } catch {
        // Fall through to the process error when the response file was not readable.
      }
      throw parseHelperError(error, this.name);
    } finally {
      try {
        if (this.existsSync(responsePath)) this.unlinkSync(responsePath);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  private resolveHelperScript(): string | null {
    const candidates = this.helperPath ? [this.helperPath] : getLinuxLocationHelperCandidates();
    for (const candidate of candidates) {
      if (this.existsSync(candidate)) return candidate;
    }
    return null;
  }
}

export class DesktopLocationService {
  private static instance: DesktopLocationService | null = null;

  constructor(
    private readonly providers: NativeLocationProvider[] = createNativeLocationProviders(),
  ) {}

  static getInstance(): DesktopLocationService {
    if (!DesktopLocationService.instance) {
      DesktopLocationService.instance = new DesktopLocationService();
    }
    return DesktopLocationService.instance;
  }

  installPermissionHandlers(): void {
    // Native OS providers own their permission flow. This remains for startup
    // compatibility with the previous Electron geolocation implementation.
  }

  async getCurrentLocation(request: DesktopLocationRequest = {}): Promise<DesktopLocationSnapshot> {
    for (const provider of this.providers) {
      if (!(await provider.isAvailable())) continue;
      return provider.getCurrentLocation(request);
    }

    const platform = process.platform;
    const hasNativeSupport = platform === "darwin" || platform === "win32" || platform === "linux";
    throw new DesktopLocationError(
      hasNativeSupport ? "LOCATION_NOT_CONFIGURED" : "LOCATION_UNSUPPORTED_PLATFORM",
      getNoProviderMessage(platform),
    );
  }
}

export function createNativeLocationProviders(): NativeLocationProvider[] {
  return [
    new MacOSCoreLocationProvider(),
    new WindowsLocationProvider(),
    new LinuxGeoClueProvider(),
  ];
}

function getNoProviderMessage(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "macOS Core Location helper is not built or bundled.";
  }
  if (platform === "win32") {
    return "Windows Location helper is not built or bundled.";
  }
  if (platform === "linux") {
    return "Linux GeoClue location helper is not built or bundled.";
  }
  return `Desktop location is not supported on ${platform}.`;
}

function getMacOSLocationHelperCandidates(): Array<{ kind: "app" | "executable"; path: string }> {
  const resourcesPath =
    typeof (process as Any).resourcesPath === "string" ? (process as Any).resourcesPath : "";
  const relativeAppExecutable = path.join(
    LOCATION_HELPER_DIR,
    `${LOCATION_HELPER_EXECUTABLE}.app`,
    "Contents",
    "MacOS",
    LOCATION_HELPER_EXECUTABLE,
  );
  const relativeExecutable = path.join(LOCATION_HELPER_DIR, LOCATION_HELPER_EXECUTABLE);
  const candidates: Array<{ kind: "app" | "executable"; path: string }> = [];

  if (resourcesPath) {
    candidates.push({
      kind: "app",
      path: path.join(resourcesPath, LOCATION_HELPER_DIR, `${LOCATION_HELPER_EXECUTABLE}.app`),
    });
    candidates.push({ kind: "executable", path: path.join(resourcesPath, relativeExecutable) });
  }

  candidates.push({
    kind: "app",
    path: path.join(
      process.cwd(),
      "build",
      LOCATION_HELPER_DIR,
      `${LOCATION_HELPER_EXECUTABLE}.app`,
    ),
  });
  candidates.push({
    kind: "executable",
    path: path.join(process.cwd(), "build", relativeExecutable),
  });
  candidates.push({
    kind: "executable",
    path: path.join(process.cwd(), "build", relativeAppExecutable),
  });
  return candidates;
}

function getWindowsLocationHelperCandidates(): string[] {
  const resourcesPath =
    typeof (process as Any).resourcesPath === "string" ? (process as Any).resourcesPath : "";
  const dir = "location-helper-windows";
  const script = "Get-Location.ps1";
  const candidates: string[] = [];
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, dir, script));
  }
  candidates.push(path.join(process.cwd(), "build", dir, script));
  return candidates;
}

function getLinuxLocationHelperCandidates(): string[] {
  const resourcesPath =
    typeof (process as Any).resourcesPath === "string" ? (process as Any).resourcesPath : "";
  const dir = "location-helper-linux";
  const script = "get-location.sh";
  const candidates: string[] = [];
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, dir, script));
  }
  candidates.push(path.join(process.cwd(), "build", dir, script));
  return candidates;
}

function resolveWindowsPowerShell(): string {
  const systemRoot = process.env.SYSTEMROOT || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function parseHelperSuccess(stdout: string, provider: string): DesktopLocationSnapshot {
  const envelope = parseHelperEnvelope(stdout, provider);
  if (!envelope.ok || !envelope.location) {
    throw helperEnvelopeError(envelope, provider);
  }

  const { latitude, longitude, accuracyMeters, timestamp, source } = envelope.location;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    typeof accuracyMeters !== "number" ||
    typeof timestamp !== "number" ||
    !VALID_LOCATION_SOURCES.has(source as string)
  ) {
    throw new DesktopLocationError(
      "LOCATION_UNAVAILABLE",
      "Location helper returned an invalid location payload.",
      provider,
    );
  }

  return {
    latitude,
    longitude,
    accuracyMeters,
    timestamp,
    source: source as DesktopLocationSource,
  };
}

function parseHelperError(error: unknown, provider: string): DesktopLocationError {
  const maybeError = error as {
    stdout?: string;
    stderr?: string;
    killed?: boolean;
    signal?: string;
  };
  if (maybeError?.stdout) {
    try {
      return helperEnvelopeError(parseHelperEnvelope(maybeError.stdout, provider), provider);
    } catch (parseError) {
      if (parseError instanceof DesktopLocationError) return parseError;
    }
  }

  if (maybeError?.killed || maybeError?.signal === "SIGTERM") {
    return new DesktopLocationError(
      "LOCATION_TIMEOUT",
      "Timed out while getting current location.",
      provider,
    );
  }

  const message = error instanceof Error ? error.message : String(error || "");
  return new DesktopLocationError(
    "LOCATION_UNAVAILABLE",
    message || "Location helper failed.",
    provider,
  );
}

function parseHelperEnvelope(stdout: string, provider: string): LocationHelperEnvelope {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) {
    throw new DesktopLocationError(
      "LOCATION_UNAVAILABLE",
      "Location helper returned no output.",
      provider,
    );
  }

  try {
    return JSON.parse(trimmed) as LocationHelperEnvelope;
  } catch {
    throw new DesktopLocationError(
      "LOCATION_UNAVAILABLE",
      "Location helper returned invalid JSON.",
      provider,
    );
  }
}

function helperEnvelopeError(
  envelope: LocationHelperEnvelope,
  provider: string,
): DesktopLocationError {
  const code = normalizeLocationErrorCode(envelope.error?.code);
  return new DesktopLocationError(
    code,
    envelope.error?.message || locationErrorMessage(code),
    provider,
  );
}

function normalizeLocationErrorCode(code: unknown): DesktopLocationErrorCode {
  if (
    code === "LOCATION_DENIED" ||
    code === "LOCATION_UNAVAILABLE" ||
    code === "LOCATION_TIMEOUT" ||
    code === "LOCATION_NOT_CONFIGURED" ||
    code === "LOCATION_UNSUPPORTED_PLATFORM"
  ) {
    return code;
  }
  return "LOCATION_UNAVAILABLE";
}

function locationErrorMessage(code: DesktopLocationErrorCode): string {
  switch (code) {
    case "LOCATION_DENIED":
      return "Location access was denied by the operating system.";
    case "LOCATION_TIMEOUT":
      return "Timed out while getting current location.";
    case "LOCATION_NOT_CONFIGURED":
      return "Desktop location is not configured.";
    case "LOCATION_UNSUPPORTED_PLATFORM":
      return "Desktop location is not supported on this platform.";
    case "LOCATION_UNAVAILABLE":
    default:
      return "Current location is unavailable.";
  }
}

function clampPositiveInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

export function getDesktopLocationService(): DesktopLocationService {
  return DesktopLocationService.getInstance();
}
