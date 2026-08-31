import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { access, chmod, mkdir, readFile, writeFile } from "fs/promises";
import { constants as fsConstants } from "fs";
import * as path from "path";
import { getUserDataDir } from "../utils/user-data-dir";
import type { ComputerUseProvider } from "./provider";

type Any = any; // oxlint-disable-line typescript-eslint/no-explicit-any

const HELPER_DIR = path.join(getUserDataDir(), "computer-use-helper");
const HELPER_PATH = path.join(HELPER_DIR, process.platform === "win32" ? "bridge.ps1" : "bridge");
const HELPER_STAMP_PATH = path.join(HELPER_DIR, "bridge.sha256");
const HELPER_SETUP_TIMEOUT_MS = 60_000;
const HELPER_COMMAND_TIMEOUT_MS = 20_000;

export interface ComputerUseHelperStatus {
  platform: NodeJS.Platform;
  helperPath: string;
  sourcePath: string | null;
  installed: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  error?: string;
}

export interface ComputerUseHelperApp {
  appName: string;
  bundleId?: string;
  pid: number;
  isFrontmost?: boolean;
}

export interface ComputerUseHelperFramePoints {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ComputerUseHelperWindow {
  windowId?: number;
  title: string;
  framePoints: ComputerUseHelperFramePoints;
  scaleFactor: number;
  isMinimized: boolean;
  isOnscreen: boolean;
  isMain: boolean;
  isFocused: boolean;
}

export interface ComputerUseFrontmostApp {
  appName: string;
  bundleId?: string;
  pid: number;
  windowTitle?: string;
  windowId?: number;
}

export interface ComputerUseScreenshotPayload {
  pngBase64: string;
  width: number;
  height: number;
  scaleFactor: number;
}

export interface ComputerUseAxPressResult {
  pressed: boolean;
  reason?: string;
}

export interface ComputerUseAxFocusResult {
  focused: boolean;
  reason?: string;
}

export interface ComputerUseFocusedElementResult {
  exists: boolean;
  elementRef?: string;
  role?: string;
  subrole?: string;
  isTextInput?: boolean;
  isSecure?: boolean;
  canSetValue?: boolean;
}

export interface ComputerUseAxElementResult {
  found?: boolean;
  focused?: boolean;
  exists?: boolean;
  elementRef?: string;
  role?: string;
  subrole?: string;
  title?: string;
  value?: string;
  x?: number;
  y?: number;
  score?: number;
  confidence?: string;
  actions?: string[];
  isTextInput?: boolean;
  isSecure?: boolean;
  canSetValue?: boolean;
  reason?: string;
}

export type ComputerUseHelperMouseButton = "left" | "right" | "wheel" | "back" | "forward";

export interface ComputerUseHelperKeypressSpec {
  pid: number;
  keyCode?: number;
  keyText?: string;
  modifiers?: string[];
}

interface PendingRequest {
  cmd: string;
  resolve: (value: Any) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

class HelperTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperTransportError";
  }
}

export class HelperCommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HelperCommandError";
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export function isRecoverableScreenshotError(error: unknown): boolean {
  return (
    error instanceof HelperCommandError &&
    (error.code === "screenshot_timeout" ||
      error.code === "window_not_found" ||
      error.code === "window_not_foreground" ||
      error.code === "screenshot_failed")
  );
}

function isPackagedElectronApp(): boolean {
  try {
    // oxlint-disable-next-line typescript-eslint/no-require-imports
    const electron = require("electron") as Any;
    return electron?.app?.isPackaged === true;
  } catch {
    return false;
  }
}

function getBundledHelperSourcePath(): string | null {
  if (process.platform !== "darwin" && process.platform !== "win32") return null;
  const fileName = process.platform === "win32" ? "bridge.ps1" : "bridge.swift";
  const candidates: string[] = [];
  if (
    isPackagedElectronApp() &&
    typeof process.resourcesPath === "string" &&
    process.resourcesPath.length > 0
  ) {
    candidates.push(path.join(process.resourcesPath, "computer-use", fileName));
  }
  if (typeof process.cwd === "function") {
    candidates.push(path.join(process.cwd(), "resources", "computer-use", fileName));
  }
  candidates.push(path.resolve(__dirname, "../../../resources/computer-use", fileName));
  candidates.push(path.resolve(__dirname, "../../../../resources/computer-use", fileName));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function isExecutable(filePath: string): Promise<boolean> {
  if (process.platform === "win32") {
    return existsSync(filePath);
  }
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getElectronDialog(): {
  showMessageBox: (options: Any) => Promise<{ response: number }>;
} | null {
  try {
    // oxlint-disable-next-line typescript-eslint/no-require-imports
    const electron = require("electron") as Any;
    return electron?.dialog ?? null;
  } catch {
    return null;
  }
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function resolvePowerShellCommand(): string {
  if (process.env.COWORK_POWERSHELL_PATH) {
    return process.env.COWORK_POWERSHELL_PATH;
  }
  return process.env.ComSpec ? "powershell.exe" : "powershell";
}

export class ComputerUseHelperRuntime implements ComputerUseProvider {
  private static instance: ComputerUseHelperRuntime | null = null;

  static getInstance(): ComputerUseHelperRuntime {
    if (!ComputerUseHelperRuntime.instance) {
      ComputerUseHelperRuntime.instance = new ComputerUseHelperRuntime();
    }
    return ComputerUseHelperRuntime.instance;
  }

  static resetForTesting(): void {
    ComputerUseHelperRuntime.instance = null;
  }

  private helper: ChildProcessWithoutNullStreams | null = null;
  private helperStdoutBuffer = "";
  private requestSequence = 0;
  private pending = new Map<string, PendingRequest>();
  private queueTail: Promise<void> = Promise.resolve();

  getHelperPath(): string {
    return HELPER_PATH;
  }

  getHelperSourcePath(): string | null {
    return getBundledHelperSourcePath();
  }

  async getStatus(): Promise<ComputerUseHelperStatus> {
    const sourcePath = this.getHelperSourcePath();
    const installed =
      process.platform === "win32"
        ? Boolean(sourcePath || existsSync(HELPER_PATH))
        : await isExecutable(HELPER_PATH);
    if (!installed) {
      return {
        platform: process.platform,
        helperPath: HELPER_PATH,
        sourcePath,
        installed: false,
        accessibility: false,
        screenRecording: false,
      };
    }

    try {
      if (process.platform === "win32") {
        await this.ensureHelperInstalled();
      }
      const status = await this.checkPermissions();
      return {
        platform: process.platform,
        helperPath: HELPER_PATH,
        sourcePath,
        installed: true,
        accessibility: status.accessibility,
        screenRecording: status.screenRecording,
      };
    } catch (error) {
      return {
        platform: process.platform,
        helperPath: HELPER_PATH,
        sourcePath,
        installed: true,
        accessibility: false,
        screenRecording: false,
        error: normalizeError(error).message,
      };
    }
  }

  async ensureReadyWithInteractivePermissions(): Promise<void> {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      throw new Error("Computer use is only supported on macOS and Windows desktop builds.");
    }
    await this.ensureHelperInstalled();
    await this.ensureHelperProcess();
    if (process.platform === "darwin") {
      await this.ensurePermissionsInteractive();
    }
  }

  stop(): void {
    this.rejectAllPending(new HelperTransportError("Computer-use helper stopped."));
    const helper = this.helper;
    this.helper = null;
    this.helperStdoutBuffer = "";
    if (helper && helper.exitCode === null && !helper.killed) {
      helper.kill("SIGTERM");
    }
  }

  async listApps(): Promise<ComputerUseHelperApp[]> {
    const result = await this.bridgeCommand<unknown>("listApps");
    const rawApps = Array.isArray(result) ? result : [];
    const apps: Array<ComputerUseHelperApp | null> = rawApps.map(
      (entry): ComputerUseHelperApp | null => {
        const record =
          entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
        if (!record) return null;
        const pid = Number(record.pid);
        if (!Number.isFinite(pid) || pid <= 0) return null;
        return {
          appName: typeof record.appName === "string" ? record.appName : "Unknown App",
          bundleId: typeof record.bundleId === "string" ? record.bundleId : undefined,
          pid: Math.trunc(pid),
          isFrontmost: record.isFrontmost === true,
        };
      },
    );
    return apps.filter((entry): entry is ComputerUseHelperApp => entry !== null);
  }

  async listWindows(pid: number): Promise<ComputerUseHelperWindow[]> {
    const result = await this.bridgeCommand<unknown>("listWindows", { pid });
    const rawWindows = Array.isArray(result) ? result : [];
    return rawWindows.map((entry) => {
      const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const frame =
        record.framePoints && typeof record.framePoints === "object"
          ? (record.framePoints as Record<string, unknown>)
          : {};
      return {
        windowId:
          typeof record.windowId === "number" && Number.isFinite(record.windowId)
            ? Math.trunc(record.windowId)
            : undefined,
        title: typeof record.title === "string" ? record.title : "",
        framePoints: {
          x: Number(frame.x) || 0,
          y: Number(frame.y) || 0,
          w: Math.max(1, Number(frame.w) || 1),
          h: Math.max(1, Number(frame.h) || 1),
        },
        scaleFactor: Math.max(1, Number(record.scaleFactor) || 1),
        isMinimized: record.isMinimized === true,
        isOnscreen: record.isOnscreen !== false,
        isMain: record.isMain === true,
        isFocused: record.isFocused === true,
      };
    });
  }

  async getFrontmost(): Promise<ComputerUseFrontmostApp> {
    const result = await this.bridgeCommand<Record<string, unknown>>("getFrontmost");
    const pid = Number(result.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error("No frontmost app is available for computer use.");
    }
    return {
      appName: typeof result.appName === "string" ? result.appName : "Unknown App",
      bundleId: typeof result.bundleId === "string" ? result.bundleId : undefined,
      pid: Math.trunc(pid),
      windowTitle: typeof result.windowTitle === "string" ? result.windowTitle : undefined,
      windowId:
        typeof result.windowId === "number" && Number.isFinite(result.windowId)
          ? Math.trunc(result.windowId)
          : undefined,
    };
  }

  async screenshot(windowId: number): Promise<ComputerUseScreenshotPayload> {
    const result = await this.bridgeCommand<Record<string, unknown>>(
      "screenshot",
      {
        windowId,
      },
      25_000,
    );
    const pngBase64 = typeof result.pngBase64 === "string" ? result.pngBase64 : "";
    if (!pngBase64) {
      throw new Error("Computer-use helper returned an invalid screenshot payload.");
    }
    return {
      pngBase64,
      width: Math.max(1, Math.trunc(Number(result.width) || 1)),
      height: Math.max(1, Math.trunc(Number(result.height) || 1)),
      scaleFactor: Math.max(1, Number(result.scaleFactor) || 1),
    };
  }

  async axPressAtPoint(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
  }): Promise<ComputerUseAxPressResult> {
    const result = await this.bridgeCommand<Record<string, unknown>>("axPressAtPoint", args);
    return {
      pressed: result.pressed === true,
      reason: typeof result.reason === "string" ? result.reason : undefined,
    };
  }

  async axFocusAtPoint(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
  }): Promise<ComputerUseAxFocusResult> {
    const result = await this.bridgeCommand<Record<string, unknown>>("axFocusAtPoint", args);
    return {
      focused: result.focused === true,
      reason: typeof result.reason === "string" ? result.reason : undefined,
    };
  }

  async axDescribeAtPoint(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
  }): Promise<Record<string, unknown>> {
    return await this.bridgeCommand<Record<string, unknown>>("axDescribeAtPoint", args);
  }

  async axFindTextInput(args: {
    pid: number;
    windowId?: number;
  }): Promise<ComputerUseAxElementResult> {
    const result = await this.bridgeCommand<Record<string, unknown>>("axFindTextInput", args);
    return this.parseAxElementResult(result);
  }

  async axFocusTextInput(args: {
    pid: number;
    windowId?: number;
  }): Promise<ComputerUseAxElementResult> {
    const result = await this.bridgeCommand<Record<string, unknown>>("axFocusTextInput", args);
    return this.parseAxElementResult(result);
  }

  async axFindFocusableElement(args: {
    pid: number;
    windowId?: number;
    roles?: string[];
  }): Promise<ComputerUseAxElementResult> {
    const result = await this.bridgeCommand<Record<string, unknown>>(
      "axFindFocusableElement",
      args,
    );
    return this.parseAxElementResult(result);
  }

  async axFindActionableElement(args: {
    pid: number;
    windowId?: number;
    roles?: string[];
  }): Promise<ComputerUseAxElementResult> {
    const result = await this.bridgeCommand<Record<string, unknown>>(
      "axFindActionableElement",
      args,
    );
    return this.parseAxElementResult(result);
  }

  async focusedElement(pid: number): Promise<ComputerUseFocusedElementResult> {
    const result = await this.bridgeCommand<Record<string, unknown>>("focusedElement", { pid });
    return {
      exists: result.exists === true,
      elementRef: typeof result.elementRef === "string" ? result.elementRef : undefined,
      role: typeof result.role === "string" ? result.role : undefined,
      subrole: typeof result.subrole === "string" ? result.subrole : undefined,
      isTextInput: result.isTextInput === true,
      isSecure: result.isSecure === true,
      canSetValue: result.canSetValue === true,
    };
  }

  async setValue(elementRef: string, value: string): Promise<void> {
    await this.bridgeCommand("setValue", { elementRef, value });
  }

  async mouseClick(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
    button?: ComputerUseHelperMouseButton;
    clickCount?: number;
  }): Promise<void> {
    await this.bridgeCommand("mouseClick", args);
  }

  async mouseMove(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
  }): Promise<void> {
    await this.bridgeCommand("mouseMove", args);
  }

  async mouseDrag(args: {
    windowId: number;
    pid: number;
    path: Array<{ x: number; y: number }>;
    captureWidth: number;
    captureHeight: number;
  }): Promise<void> {
    await this.bridgeCommand("mouseDrag", args, 30_000);
  }

  async scrollAtPoint(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
    scrollX: number;
    scrollY: number;
  }): Promise<void> {
    await this.bridgeCommand("scrollAtPoint", args);
  }

  async typeText(text: string, pid: number, windowId?: number): Promise<void> {
    await this.bridgeCommand(
      "typeText",
      { text, pid, ...(typeof windowId === "number" ? { windowId } : {}) },
      Math.min(90_000, Math.max(HELPER_COMMAND_TIMEOUT_MS, text.length * 25 + 4_000)),
    );
  }

  async pressKeys(spec: ComputerUseHelperKeypressSpec & { windowId?: number }): Promise<void> {
    await this.bridgeCommand("keyPress", { ...spec });
  }

  async activateApp(pid: number): Promise<void> {
    await this.bridgeCommand("activateApp", { pid });
  }

  async raiseWindow(pid: number, windowId?: number): Promise<void> {
    await this.bridgeCommand("raiseWindow", {
      pid,
      ...(typeof windowId === "number" ? { windowId } : {}),
    }).catch(() => undefined);
  }

  async unminimizeWindow(pid: number, windowId?: number): Promise<void> {
    await this.bridgeCommand("unminimizeWindow", {
      pid,
      ...(typeof windowId === "number" ? { windowId } : {}),
    }).catch(() => undefined);
  }

  async openPermissionPane(kind: "accessibility" | "screenRecording"): Promise<void> {
    await this.ensureHelperInstalled();
    await this.ensureHelperProcess();
    await this.bridgeCommand("openPermissionPane", { kind });
  }

  private async withRuntimeLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queueTail;
    let release!: () => void;
    this.queueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async ensureHelperInstalled(): Promise<void> {
    const sourcePath = this.getHelperSourcePath();
    if (!sourcePath) {
      throw new Error("Computer-use helper source is missing from bundled resources.");
    }
    await mkdir(HELPER_DIR, { recursive: true });
    const source = await readFile(sourcePath);
    const nextStamp = sha256(source);
    if (process.platform === "win32") {
      const currentStamp = existsSync(HELPER_STAMP_PATH)
        ? await readFile(HELPER_STAMP_PATH, "utf8").catch(() => "")
        : "";
      const currentHelperStamp = existsSync(HELPER_PATH) ? sha256(await readFile(HELPER_PATH)) : "";
      if (currentHelperStamp === nextStamp && currentStamp.trim() === nextStamp) {
        return;
      }
      await writeFile(HELPER_PATH, source, "utf8");
      await writeFile(HELPER_STAMP_PATH, `${nextStamp}\n`, "utf8");
      return;
    }
    const currentStamp = existsSync(HELPER_STAMP_PATH)
      ? await readFile(HELPER_STAMP_PATH, "utf8").catch(() => "")
      : "";
    const helperIsExecutable = await isExecutable(HELPER_PATH);
    if (helperIsExecutable && currentStamp.trim() === nextStamp) {
      return;
    }

    const compileArgs = [
      "swiftc",
      "-O",
      "-framework",
      "AppKit",
      "-framework",
      "ApplicationServices",
      "-framework",
      "ScreenCaptureKit",
      sourcePath,
      "-o",
      HELPER_PATH,
    ];
    const compile = spawnSync("xcrun", compileArgs, {
      encoding: "utf8",
      env: process.env,
      timeout: HELPER_SETUP_TIMEOUT_MS,
    });
    if (compile.status !== 0) {
      const output = [compile.stderr, compile.stdout].filter(Boolean).join("\n").trim();
      throw new Error(
        `Failed to build the computer-use helper with xcrun swiftc.${output ? `\n${output}` : ""}`,
      );
    }

    await chmod(HELPER_PATH, 0o755);
    spawnSync("codesign", ["--force", "--sign", "-", HELPER_PATH], {
      encoding: "utf8",
      env: process.env,
      timeout: 15_000,
    });
    await writeFile(HELPER_STAMP_PATH, `${nextStamp}\n`, "utf8");
  }

  private async ensureHelperProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.helper && this.helper.exitCode === null && !this.helper.killed) {
      return this.helper;
    }
    if (!(await isExecutable(HELPER_PATH))) {
      throw new HelperTransportError(`Computer-use helper is missing at ${HELPER_PATH}.`);
    }

    const child =
      process.platform === "win32"
        ? spawn(
            resolvePowerShellCommand(),
            ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", HELPER_PATH],
            {
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            },
          )
        : spawn(HELPER_PATH, [], {
            stdio: ["pipe", "pipe", "pipe"],
          });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.handleHelperStdoutChunk(chunk);
    });
    child.stderr.on("data", () => {
      // Helper diagnostics stay local to the runtime.
    });
    child.on("error", (error) => {
      if (this.helper === child) {
        this.helper = null;
      }
      this.rejectAllPending(
        new HelperTransportError(`Computer-use helper crashed: ${error.message}`),
      );
    });
    child.on("exit", (code, signal) => {
      if (this.helper === child) {
        this.helper = null;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      this.rejectAllPending(new HelperTransportError(`Computer-use helper exited (${reason}).`));
    });

    this.helper = child;
    this.helperStdoutBuffer = "";
    return child;
  }

  private handleHelperStdoutChunk(chunk: string): void {
    this.helperStdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.helperStdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.helperStdoutBuffer.slice(0, newlineIndex).trim();
      this.helperStdoutBuffer = this.helperStdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      let parsed: Any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const id = typeof parsed?.id === "string" ? parsed.id : "";
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (parsed.ok === true) {
        pending.resolve(parsed.result);
      } else {
        const message =
          typeof parsed?.error?.message === "string"
            ? parsed.error.message
            : `Computer-use helper command '${pending.cmd}' failed.`;
        const code = typeof parsed?.error?.code === "string" ? parsed.error.code : undefined;
        pending.reject(new HelperCommandError(message, code));
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private async bridgeCommand<T = unknown>(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = HELPER_COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    return await this.withRuntimeLock(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const helper = await this.ensureHelperProcess();
        const id = `req_${++this.requestSequence}`;
        try {
          const result = await new Promise<T>((resolve, reject) => {
            const payload = `${JSON.stringify({ id, cmd, ...args })}\n`;
            const timer = setTimeout(() => {
              this.pending.delete(id);
              reject(
                new HelperTransportError(
                  `Computer-use helper command '${cmd}' timed out after ${timeoutMs}ms.`,
                ),
              );
            }, timeoutMs);

            this.pending.set(id, {
              cmd,
              resolve,
              reject,
              timer,
            });

            helper.stdin.write(payload, (error) => {
              if (!error) return;
              const pending = this.pending.get(id);
              if (!pending) return;
              clearTimeout(pending.timer);
              this.pending.delete(id);
              reject(
                new HelperTransportError(
                  `Failed to send command '${cmd}' to the computer-use helper: ${error.message}`,
                ),
              );
            });
          });
          return result;
        } catch (error) {
          if (error instanceof HelperTransportError && attempt === 0) {
            this.stop();
            continue;
          }
          throw normalizeError(error);
        }
      }
      throw new Error(`Computer-use helper command '${cmd}' failed.`);
    });
  }

  private async checkPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean }> {
    const result = await this.bridgeCommand<Record<string, unknown>>("checkPermissions");
    return {
      accessibility: result.accessibility === true,
      screenRecording: result.screenRecording === true,
    };
  }

  private async ensurePermissionsInteractive(): Promise<void> {
    let status = await this.checkPermissions();
    if (status.accessibility && status.screenRecording) {
      return;
    }

    const dialog = getElectronDialog();
    if (!dialog) {
      throw new Error(
        `Computer use needs Accessibility and Screen Recording for the helper at ${HELPER_PATH}. Start CoWork in the desktop runtime and retry.`,
      );
    }

    while (!status.accessibility || !status.screenRecording) {
      const buttons: string[] = [];
      if (!status.accessibility) buttons.push("Open Accessibility Settings");
      if (!status.screenRecording) buttons.push("Open Screen Recording Settings");
      buttons.push("Recheck", "Cancel");

      const response = await dialog.showMessageBox({
        type: "warning",
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true,
        message: "Computer use requires helper permissions",
        detail:
          `Grant Accessibility and Screen Recording to the computer-use helper:\n${HELPER_PATH}\n\n` +
          "Accessibility is required for AX-based interaction and Screen Recording is required for window screenshots. " +
          "After enabling permissions in System Settings, return here and choose Recheck.",
      });

      const choice = buttons[response.response] || "Cancel";
      if (choice === "Cancel") {
        throw new Error(
          `Computer-use permission setup was cancelled. Grant permissions to ${HELPER_PATH} and retry.`,
        );
      }
      if (choice === "Open Accessibility Settings") {
        await this.openPermissionPane("accessibility");
      } else if (choice === "Open Screen Recording Settings") {
        await this.openPermissionPane("screenRecording");
      }

      status = await this.checkPermissions();
    }
  }

  private parseAxElementResult(result: Record<string, unknown>): ComputerUseAxElementResult {
    return {
      found: result.found === true,
      focused: result.focused === true,
      exists: result.exists === true,
      elementRef: typeof result.elementRef === "string" ? result.elementRef : undefined,
      role: typeof result.role === "string" ? result.role : undefined,
      subrole: typeof result.subrole === "string" ? result.subrole : undefined,
      title: typeof result.title === "string" ? result.title : undefined,
      value: typeof result.value === "string" ? result.value : undefined,
      x: typeof result.x === "number" && Number.isFinite(result.x) ? result.x : undefined,
      y: typeof result.y === "number" && Number.isFinite(result.y) ? result.y : undefined,
      score:
        typeof result.score === "number" && Number.isFinite(result.score)
          ? result.score
          : undefined,
      confidence: typeof result.confidence === "string" ? result.confidence : undefined,
      actions: Array.isArray(result.actions)
        ? result.actions.filter((entry): entry is string => typeof entry === "string")
        : undefined,
      isTextInput: result.isTextInput === true,
      isSecure: result.isSecure === true,
      canSetValue: result.canSetValue === true,
      reason: typeof result.reason === "string" ? result.reason : undefined,
    };
  }
}
