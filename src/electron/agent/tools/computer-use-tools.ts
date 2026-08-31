import * as crypto from "crypto";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";
import { ComputerUseSessionManager } from "../../computer-use/session-manager";
import { getComputerUseProvider, type ComputerUseProvider } from "../../computer-use/provider";
import {
  type ComputerUseHelperApp,
  type ComputerUseHelperKeypressSpec,
  type ComputerUseHelperMouseButton,
  type ComputerUseHelperFramePoints,
  type ComputerUseHelperWindow,
  isRecoverableScreenshotError,
} from "../../computer-use/helper-runtime";
import { BuiltinToolsSettingsManager } from "./builtin-settings";
import {
  normalizeNativeComputerUseMode,
  type NativeComputerUseMode,
} from "../../../shared/computer-use-contract";

type Any = any; // oxlint-disable-line typescript-eslint/no-explicit-any

const CUA_CAPTURE_REFRESH_WAIT_MS = 150;
const CUA_SCREENSHOT_RETRY_WAIT_MS = 250;
const DEFAULT_WAIT_MS = 1_000;
const MAX_WAIT_MS = 30_000;
const CONTROLLED_WINDOW_ERROR = "No controlled window is selected. Call screenshot() first.";

const BLOCKED_KEY_COMBOS = new Set([
  "cmd+tab",
  "command+tab",
  "cmd+space",
  "command+space",
  "cmd+q",
  "command+q",
  "alt+f4",
  "l+win",
  "l+windows",
  "cmd+option+esc",
  "command+option+escape",
  "ctrl+alt+delete",
]);

function normalizeKeysForBlocklist(keys: string[]): string {
  return keys
    .map((k) => k.toLowerCase().trim())
    .sort()
    .join("+");
}

export type ComputerUseMouseButton = "left" | "right" | "wheel" | "back" | "forward";

interface ComputerUseTargetState {
  appName: string;
  bundleId?: string;
  pid: number;
  windowId: number;
  windowTitle: string;
  framePoints: ComputerUseHelperFramePoints;
  scaleFactor: number;
  isMinimized: boolean;
  isOnscreen: boolean;
  isMain: boolean;
  isFocused: boolean;
}

interface ComputerUseCaptureState {
  id: string;
  windowId: number;
  width: number;
  height: number;
  scaleFactor: number;
  imageBase64: string;
  hash: string;
  createdAt: number;
}

interface PersistedComputerUseState {
  currentTarget: ComputerUseTargetState | null;
  currentCapture: ComputerUseCaptureState | null;
}

export interface ComputerUseToolResult {
  captureId: string;
  imageBase64: string;
  mediaType: "image/png";
  width: number;
  height: number;
  scaleFactor: number;
  createdAt: number;
  target: {
    appName: string;
    bundleId?: string;
    pid: number;
    windowId: number;
    windowTitle: string;
    framePoints: ComputerUseHelperFramePoints;
  };
  action?: string;
  note?: string;
}

interface ScreenshotSelection {
  app?: string;
  windowTitle?: string;
}

interface ActionPreparationResult {
  target: ComputerUseTargetState;
  capture: ComputerUseCaptureState;
  visibleControl: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeQuery(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function formatWindowChoice(appName: string, windowTitle: string): string {
  return windowTitle.trim() ? `${appName} — ${windowTitle}` : `${appName} — <untitled window>`;
}

function exactOrContainsScore(value: string | undefined, query: string): number {
  const normalizedValue = normalizeQuery(value);
  if (!query) return 0;
  if (!normalizedValue) return 0;
  if (normalizedValue === query) return 100;
  if (normalizedValue.startsWith(query)) return 70;
  if (normalizedValue.includes(query)) return 50;
  return 0;
}

function scoreWindow(window: ComputerUseHelperWindow): number {
  let score = 0;
  if (window.isFocused) score += 100;
  if (window.isMain) score += 80;
  if (!window.isMinimized) score += 40;
  if (window.isOnscreen) score += 20;
  if (typeof window.windowId === "number") score += 10;
  if (window.title.trim()) score += 5;
  return score;
}

function requireFiniteCoordinate(label: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function requireIntegerInRange(label: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  const rounded = Math.trunc(value);
  if (rounded < min || rounded > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return rounded;
}

function validatePointInCapture(
  x: number,
  y: number,
  capture: ComputerUseCaptureState,
  errorPrefix = "Coordinates",
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${errorPrefix} must be finite numbers.`);
  }
  if (x < 0 || y < 0 || x >= capture.width || y >= capture.height) {
    throw new Error(
      `${errorPrefix} (${Math.round(x)},${Math.round(y)}) are outside the latest screenshot bounds (${capture.width}x${capture.height}). Call screenshot() again and retry.`,
    );
  }
}

function frameDistanceScore(
  current: ComputerUseHelperFramePoints,
  previous: ComputerUseHelperFramePoints,
): number {
  const dx = Math.abs(current.x - previous.x);
  const dy = Math.abs(current.y - previous.y);
  const dw = Math.abs(current.w - previous.w);
  const dh = Math.abs(current.h - previous.h);
  return dx + dy + dw + dh;
}

const MAC_VIRTUAL_KEY_CODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "=": 24,
  "9": 25,
  "7": 26,
  "-": 27,
  "8": 28,
  "0": 29,
  "]": 30,
  o: 31,
  u: 32,
  "[": 33,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  n: 45,
  m: 46,
  ".": 47,
  "`": 50,
};

function parseKeypressSpec(pid: number, keys: string[]): ComputerUseHelperKeypressSpec {
  if (process.platform === "win32") {
    return parseWindowsKeypressSpec(pid, keys);
  }

  const modifiers: string[] = [];
  let keyText: string | null = null;
  let keyCode: number | null = null;

  for (const key of keys) {
    const trimmed = key.trim();
    const lower = trimmed.toLowerCase();
    if (lower === "cmd" || lower === "command") {
      modifiers.push("command");
      continue;
    }
    if (lower === "ctrl" || lower === "control") {
      modifiers.push("control");
      continue;
    }
    if (lower === "alt" || lower === "option") {
      modifiers.push("option");
      continue;
    }
    if (lower === "shift") {
      modifiers.push("shift");
      continue;
    }

    if (lower === "return" || lower === "enter") {
      keyCode = 36;
    } else if (lower === "escape" || lower === "esc") {
      keyCode = 53;
    } else if (lower === "tab") {
      keyCode = 48;
    } else if (lower === "space") {
      keyCode = 49;
    } else if (lower === "delete" || lower === "backspace") {
      keyCode = 51;
    } else if (lower === "up") {
      keyCode = 126;
    } else if (lower === "down") {
      keyCode = 125;
    } else if (lower === "left") {
      keyCode = 123;
    } else if (lower === "right") {
      keyCode = 124;
    } else if (lower === "home") {
      keyCode = 115;
    } else if (lower === "end") {
      keyCode = 119;
    } else if (lower === "pageup") {
      keyCode = 116;
    } else if (lower === "pagedown") {
      keyCode = 121;
    } else if (lower.startsWith("f") && /^f\d{1,2}$/.test(lower)) {
      const fkeyMap: Record<string, number> = {
        f1: 122,
        f2: 120,
        f3: 99,
        f4: 118,
        f5: 96,
        f6: 97,
        f7: 98,
        f8: 100,
        f9: 101,
        f10: 109,
        f11: 103,
        f12: 111,
      };
      keyCode = fkeyMap[lower] ?? null;
    } else if (lower in MAC_VIRTUAL_KEY_CODES) {
      keyCode = MAC_VIRTUAL_KEY_CODES[lower];
    } else if (trimmed.length === 1) {
      keyText = trimmed;
    } else {
      keyText = trimmed;
    }
  }

  if (keyCode === null && !keyText) {
    throw new Error(`Could not resolve key combination: ${keys.join("+")}`);
  }
  if (modifiers.length > 0 && keyCode === null && keyText) {
    const originalText = keyText;
    const lowered = originalText.toLowerCase();
    if (lowered in MAC_VIRTUAL_KEY_CODES) {
      keyCode = MAC_VIRTUAL_KEY_CODES[lowered];
      keyText = null;
      if (originalText !== lowered && !modifiers.includes("shift")) {
        modifiers.push("shift");
      }
    }
  }

  return {
    pid,
    ...(keyCode !== null ? { keyCode } : { keyText: keyText! }),
    ...(modifiers.length > 0 ? { modifiers } : {}),
  };
}

function parseWindowsKeypressSpec(pid: number, keys: string[]): ComputerUseHelperKeypressSpec {
  const modifiers: string[] = [];
  let keyText: string | null = null;

  for (const key of keys) {
    const trimmed = key.trim();
    const lower = trimmed.toLowerCase();
    if (lower === "cmd" || lower === "command" || lower === "win" || lower === "windows") {
      modifiers.push("windows");
      continue;
    }
    if (lower === "ctrl" || lower === "control") {
      modifiers.push("control");
      continue;
    }
    if (lower === "alt" || lower === "option") {
      modifiers.push("alt");
      continue;
    }
    if (lower === "shift") {
      modifiers.push("shift");
      continue;
    }
    keyText = trimmed;
  }

  if (!keyText) {
    throw new Error(`Could not resolve key combination: ${keys.join("+")}`);
  }

  return {
    pid,
    keyText,
    ...(modifiers.length > 0 ? { modifiers } : {}),
  };
}

/**
 * Pi-style computer-use tools:
 * - stateful target window chosen by screenshot()
 * - helper-managed permissions and window capture
 * - every successful action returns a fresh screenshot + captureId
 */
export class ComputerUseTools {
  private static persistedState = new Map<string, PersistedComputerUseState>();
  private static visibleControlGrants = new Map<string, Set<string>>();

  private currentTarget: ComputerUseTargetState | null = null;
  private currentCapture: ComputerUseCaptureState | null = null;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {
    const saved = ComputerUseTools.persistedState.get(taskId);
    this.currentTarget = saved?.currentTarget ?? null;
    this.currentCapture = saved?.currentCapture ?? null;
  }

  static resetForTesting(): void {
    ComputerUseTools.persistedState.clear();
    ComputerUseTools.visibleControlGrants.clear();
  }

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  private helper(): ComputerUseProvider {
    return getComputerUseProvider();
  }

  private session(): ComputerUseSessionManager {
    return ComputerUseSessionManager.getInstance();
  }

  private persistState(): void {
    ComputerUseTools.persistedState.set(this.taskId, {
      currentTarget: this.currentTarget,
      currentCapture: this.currentCapture,
    });
  }

  private async ensureReady(): Promise<void> {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      throw new Error("Computer use is only supported on macOS and Windows desktop builds.");
    }
    this.session().acquire(this.taskId, this.daemon);
    this.session().checkNotAborted();
    await this.helper().ensureReadyWithInteractivePermissions();
  }

  private async bringTargetToFront(target: ComputerUseTargetState): Promise<void> {
    await this.helper().unminimizeWindow(target.pid, target.windowId);
    await this.helper().activateApp(target.pid);
    await this.helper().raiseWindow(target.pid, target.windowId);
    await sleep(CUA_CAPTURE_REFRESH_WAIT_MS);
  }

  private resolveNativeControlMode(): NativeComputerUseMode {
    return normalizeNativeComputerUseMode(
      BuiltinToolsSettingsManager.getComputerUseAutomationSettings().nativeComputerUseMode,
    );
  }

  private visibleControlGrantKey(target: ComputerUseTargetState): string {
    return `${target.pid}:${target.windowId}`;
  }

  private hasVisibleControlGrant(target: ComputerUseTargetState): boolean {
    return (
      ComputerUseTools.visibleControlGrants
        .get(this.taskId)
        ?.has(this.visibleControlGrantKey(target)) === true
    );
  }

  private rememberVisibleControlGrant(target: ComputerUseTargetState): void {
    let grants = ComputerUseTools.visibleControlGrants.get(this.taskId);
    if (!grants) {
      grants = new Set();
      ComputerUseTools.visibleControlGrants.set(this.taskId, grants);
    }
    grants.add(this.visibleControlGrantKey(target));
  }

  private isVisibleControlAllowed(target: ComputerUseTargetState): boolean {
    return this.resolveNativeControlMode() === "visible" || this.hasVisibleControlGrant(target);
  }

  private async requestVisibleControlApproval(
    toolName: string,
    target: ComputerUseTargetState,
    reason: string,
  ): Promise<boolean> {
    const requester = (this.daemon as Any)?.requestApproval;
    if (typeof requester !== "function") return false;
    return await requester.call(
      this.daemon,
      this.taskId,
      "computer_use",
      `Allow visible Computer Use to control ${target.appName}?`,
      {
        kind: "computer_use_foreground_control",
        tool: toolName,
        reason,
        targetApp: target.appName,
        bundleId: target.bundleId,
        windowId: target.windowId,
        windowTitle: target.windowTitle,
      },
      { allowAutoApprove: false },
    );
  }

  private async ensureVisibleControlAllowed(
    toolName: string,
    target: ComputerUseTargetState,
    reason: string,
  ): Promise<void> {
    if (this.isVisibleControlAllowed(target)) return;
    const approved = await this.requestVisibleControlApproval(toolName, target, reason);
    if (!approved) {
      throw new Error(this.visibleControlRequiredMessage(toolName, target));
    }
    this.rememberVisibleControlGrant(target);
  }

  private visibleControlRequiredMessage(toolName: string, target: ComputerUseTargetState): string {
    return `${toolName} needs visible control of ${target.appName}. Background Computer Use could not complete this action without real mouse/keyboard events.`;
  }

  private makeCaptureState(
    target: ComputerUseTargetState,
    payload: { pngBase64: string; width: number; height: number; scaleFactor: number },
  ): ComputerUseCaptureState {
    const imageBuffer = Buffer.from(payload.pngBase64, "base64");
    const hash = crypto.createHash("sha256").update(imageBuffer).digest("hex").slice(0, 16);
    return {
      id: `cap_${Date.now()}_${hash}`,
      windowId: target.windowId,
      width: payload.width,
      height: payload.height,
      scaleFactor: payload.scaleFactor,
      imageBase64: payload.pngBase64,
      hash,
      createdAt: Date.now(),
    };
  }

  private buildResult(action?: string, note?: string): ComputerUseToolResult {
    if (!this.currentTarget || !this.currentCapture) {
      throw new Error("Computer-use state is missing the current target screenshot.");
    }
    return {
      captureId: this.currentCapture.id,
      imageBase64: this.currentCapture.imageBase64,
      mediaType: "image/png",
      width: this.currentCapture.width,
      height: this.currentCapture.height,
      scaleFactor: this.currentCapture.scaleFactor,
      createdAt: this.currentCapture.createdAt,
      target: {
        appName: this.currentTarget.appName,
        bundleId: this.currentTarget.bundleId,
        pid: this.currentTarget.pid,
        windowId: this.currentTarget.windowId,
        windowTitle: this.currentTarget.windowTitle,
        framePoints: this.currentTarget.framePoints,
      },
      ...(action ? { action } : {}),
      ...(note ? { note } : {}),
    };
  }

  private async captureTarget(toolName: string, note?: string): Promise<ComputerUseToolResult> {
    if (!this.currentTarget) {
      throw new Error(CONTROLLED_WINDOW_ERROR);
    }
    let payload;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        payload = await this.helper().screenshot(this.currentTarget.windowId);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          attempt > 0 ||
          (!isRecoverableScreenshotError(error) && !/audio\/video capture failure/i.test(message))
        ) {
          throw error;
        }
        this.currentTarget = await this.refreshCurrentTarget();
        await this.ensureVisibleControlAllowed(
          toolName,
          this.currentTarget,
          "background_window_capture_failed",
        );
        await this.bringTargetToFront(this.currentTarget);
        await sleep(CUA_SCREENSHOT_RETRY_WAIT_MS);
      }
    }
    if (!payload) {
      throw new Error("Failed to capture the current controlled window.");
    }
    this.currentCapture = this.makeCaptureState(this.currentTarget, payload);
    this.persistState();
    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: toolName,
      success: true,
      captureId: this.currentCapture.id,
      width: payload.width,
      height: payload.height,
      targetApp: this.currentTarget.appName,
      windowId: this.currentTarget.windowId,
      windowTitle: this.currentTarget.windowTitle,
    });
    return this.buildResult(toolName, note);
  }

  private toTargetState(
    app: ComputerUseHelperApp,
    window: ComputerUseHelperWindow,
  ): ComputerUseTargetState {
    if (typeof window.windowId !== "number") {
      throw new Error(
        `The selected window in ${app.appName} cannot be controlled because macOS did not expose a stable window id.`,
      );
    }
    return {
      appName: app.appName,
      bundleId: app.bundleId,
      pid: app.pid,
      windowId: window.windowId,
      windowTitle: window.title,
      framePoints: window.framePoints,
      scaleFactor: window.scaleFactor,
      isMinimized: window.isMinimized,
      isOnscreen: window.isOnscreen,
      isMain: window.isMain,
      isFocused: window.isFocused,
    };
  }

  private async resolveFrontmostTarget(): Promise<ComputerUseTargetState> {
    const frontmost = await this.helper().getFrontmost();
    const frontmostApp: ComputerUseHelperApp = {
      appName: frontmost.appName,
      bundleId: frontmost.bundleId,
      pid: frontmost.pid,
      isFrontmost: true,
    };
    const windows = await this.helper().listWindows(frontmost.pid);
    if (windows.length === 0) {
      throw new Error(`No controllable windows were found for ${frontmost.appName}.`);
    }
    const preferredWindow =
      windows.find((entry) => entry.windowId === frontmost.windowId) ||
      windows.sort((a, b) => scoreWindow(b) - scoreWindow(a))[0];
    return this.toTargetState(frontmostApp, preferredWindow);
  }

  private chooseRefreshFallbackWindow(
    windows: ComputerUseHelperWindow[],
    previous: ComputerUseTargetState,
  ): ComputerUseHelperWindow | null {
    const controllable = windows.filter((entry) => typeof entry.windowId === "number");
    if (controllable.length === 0) {
      return null;
    }

    const visible = controllable.filter((entry) => !entry.isMinimized && entry.isOnscreen);
    if (visible.length === 1) {
      return visible[0];
    }

    const ranked = (visible.length > 0 ? visible : controllable)
      .map((entry) => ({
        entry,
        score:
          (entry.isFocused ? 120 : 0) +
          (entry.isMain ? 80 : 0) +
          (!entry.isMinimized ? 30 : 0) +
          (entry.isOnscreen ? 20 : 0) -
          frameDistanceScore(entry.framePoints, previous.framePoints) / 20,
      }))
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 1) {
      return ranked[0].entry;
    }
    if (ranked.length > 1 && ranked[0].score >= ranked[1].score + 25) {
      return ranked[0].entry;
    }
    return null;
  }

  private async findRetargetedApp(
    previous: ComputerUseTargetState,
  ): Promise<ComputerUseHelperApp | null> {
    const previousAppName = normalizeQuery(previous.appName);
    const previousBundleId = normalizeQuery(previous.bundleId);
    const candidates = (await this.helper().listApps())
      .filter((app) => app.pid !== previous.pid)
      .map((app) => {
        const appName = normalizeQuery(app.appName);
        const bundleId = normalizeQuery(app.bundleId);
        const sameBundle = Boolean(previousBundleId) && bundleId === previousBundleId;
        const sameAppName = Boolean(previousAppName) && appName === previousAppName;
        if (!sameBundle && !sameAppName) {
          return null;
        }
        return {
          app,
          score: (sameBundle ? 200 : 0) + (sameAppName ? 120 : 0) + (app.isFrontmost ? 40 : 0),
        };
      })
      .filter((entry): entry is { app: ComputerUseHelperApp; score: number } => entry !== null)
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.app ?? null;
  }

  private async refreshCurrentTarget(): Promise<ComputerUseTargetState> {
    if (!this.currentTarget) {
      throw new Error(CONTROLLED_WINDOW_ERROR);
    }
    let targetApp = {
      appName: this.currentTarget.appName,
      bundleId: this.currentTarget.bundleId,
      pid: this.currentTarget.pid,
    };
    let windows = await this.helper().listWindows(targetApp.pid);
    let refreshed =
      windows.find((entry) => entry.windowId === this.currentTarget?.windowId) ||
      windows.find(
        (entry) => normalizeQuery(entry.title) === normalizeQuery(this.currentTarget?.windowTitle),
      ) ||
      this.chooseRefreshFallbackWindow(windows, this.currentTarget);

    if (!refreshed) {
      const retargetedApp = await this.findRetargetedApp(this.currentTarget);
      if (retargetedApp) {
        targetApp = {
          appName: retargetedApp.appName,
          bundleId: retargetedApp.bundleId,
          pid: retargetedApp.pid,
        };
        windows = await this.helper().listWindows(targetApp.pid);
        refreshed =
          windows.find(
            (entry) =>
              normalizeQuery(entry.title) === normalizeQuery(this.currentTarget?.windowTitle),
          ) || this.chooseRefreshFallbackWindow(windows, this.currentTarget);
      }
    }

    if (!refreshed) {
      throw new Error(
        `The controlled window "${this.currentTarget.windowTitle || this.currentTarget.appName}" is no longer available. Call screenshot() to retarget.`,
      );
    }
    this.currentTarget = {
      ...this.currentTarget,
      appName: targetApp.appName,
      bundleId: targetApp.bundleId,
      pid: targetApp.pid,
      windowId: refreshed.windowId ?? this.currentTarget.windowId,
      windowTitle: refreshed.title,
      framePoints: refreshed.framePoints,
      scaleFactor: refreshed.scaleFactor,
      isMinimized: refreshed.isMinimized,
      isOnscreen: refreshed.isOnscreen,
      isMain: refreshed.isMain,
      isFocused: refreshed.isFocused,
    };
    this.persistState();
    return this.currentTarget;
  }

  private pickSingleMatch<T>(
    entries: T[],
    getLabel: (entry: T) => string,
    getScore: (entry: T) => number,
    emptyMessage: string,
    ambiguousMessage: string,
  ): T {
    if (entries.length === 0) {
      throw new Error(emptyMessage);
    }
    const ranked = [...entries]
      .map((entry) => ({ entry, score: getScore(entry), label: getLabel(entry) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

    if (ranked.length === 0) {
      throw new Error(emptyMessage);
    }
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
      const choices = ranked
        .slice(0, 5)
        .map((candidate) => candidate.label)
        .join(", ");
      throw new Error(`${ambiguousMessage} Matching targets: ${choices}`);
    }
    return ranked[0].entry;
  }

  private async resolveTargetFromSelection(
    selection: ScreenshotSelection,
  ): Promise<ComputerUseTargetState> {
    const appQuery = normalizeQuery(selection.app);
    const windowQuery = normalizeQuery(selection.windowTitle);
    if (!appQuery && !windowQuery) {
      return await this.resolveFrontmostTarget();
    }

    const apps = await this.helper().listApps();
    const candidateApps = appQuery
      ? apps.filter((app) => {
          const best = Math.max(
            exactOrContainsScore(app.appName, appQuery),
            exactOrContainsScore(app.bundleId, appQuery),
          );
          return best > 0;
        })
      : apps;

    if (candidateApps.length === 0) {
      throw new Error(`No running app matches "${selection.app}".`);
    }

    const scoredCandidates: Array<{
      app: ComputerUseHelperApp;
      window: ComputerUseHelperWindow;
      score: number;
    }> = [];

    for (const app of candidateApps) {
      const windows = await this.helper().listWindows(app.pid);
      for (const window of windows) {
        const appScore = appQuery
          ? Math.max(
              exactOrContainsScore(app.appName, appQuery),
              exactOrContainsScore(app.bundleId, appQuery),
            )
          : app.isFrontmost
            ? 5
            : 0;
        const windowScore = windowQuery
          ? exactOrContainsScore(window.title, windowQuery)
          : scoreWindow(window);
        if (windowQuery && windowScore === 0) continue;
        const score =
          appScore + windowScore + (window.isFocused ? 25 : 0) + (window.isMain ? 10 : 0);
        if (score <= 0) continue;
        scoredCandidates.push({ app, window, score });
      }
    }

    if (scoredCandidates.length === 0) {
      if (candidateApps.length === 1) {
        const fallbackWindows = await this.helper().listWindows(candidateApps[0].pid);
        const fallbackWindow = this.chooseRefreshFallbackWindow(fallbackWindows, {
          appName: candidateApps[0].appName,
          bundleId: candidateApps[0].bundleId,
          pid: candidateApps[0].pid,
          windowId: -1,
          windowTitle: selection.windowTitle || "",
          framePoints: { x: 0, y: 0, w: 0, h: 0 },
          scaleFactor: 1,
          isMinimized: false,
          isOnscreen: true,
          isMain: false,
          isFocused: false,
        });
        if (fallbackWindow) {
          return this.toTargetState(candidateApps[0], fallbackWindow);
        }
      }
      const label = selection.windowTitle
        ? `window "${selection.windowTitle}"`
        : "a controllable window";
      throw new Error(`Could not find ${label}${selection.app ? ` in ${selection.app}` : ""}.`);
    }

    const chosen = this.pickSingleMatch(
      scoredCandidates,
      (candidate) => formatWindowChoice(candidate.app.appName, candidate.window.title),
      (candidate) => candidate.score,
      `Could not find a controllable window for ${selection.app || "the requested target"}.`,
      "Multiple windows match the requested target.",
    );
    return this.toTargetState(chosen.app, chosen.window);
  }

  private requireCurrentCapture(captureId?: string): ComputerUseCaptureState {
    if (!this.currentTarget || !this.currentCapture) {
      throw new Error(CONTROLLED_WINDOW_ERROR);
    }
    if (this.currentCapture.windowId !== this.currentTarget.windowId) {
      throw new Error(
        "The current capture no longer matches the controlled window. Call screenshot() to refresh.",
      );
    }
    if (captureId && captureId !== this.currentCapture.id) {
      throw new Error(
        `captureId ${captureId} is stale. Call screenshot() to refresh and use the newest capture.`,
      );
    }
    return this.currentCapture;
  }

  private async prepareAction(
    toolName: string,
    captureId?: string,
  ): Promise<ActionPreparationResult> {
    await this.ensureReady();
    const target = await this.refreshCurrentTarget();
    const capture = this.requireCurrentCapture(captureId);
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: toolName,
      targetApp: target.appName,
      bundleId: target.bundleId,
      windowId: target.windowId,
      captureId: capture.id,
    });
    const visibleControl = this.isVisibleControlAllowed(target);
    if (visibleControl) {
      await this.bringTargetToFront(target);
    }
    return { target, capture, visibleControl };
  }

  async screenshot(selection: ScreenshotSelection = {}): Promise<ComputerUseToolResult> {
    await this.ensureReady();
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "screenshot",
      app: selection.app,
      windowTitle: selection.windowTitle,
      hadCurrentTarget: Boolean(this.currentTarget),
    });

    this.currentTarget =
      selection.app || selection.windowTitle
        ? await this.resolveTargetFromSelection(selection)
        : this.currentTarget
          ? await this.refreshCurrentTarget().catch(async () => await this.resolveFrontmostTarget())
          : await this.resolveFrontmostTarget();

    this.persistState();
    if (this.isVisibleControlAllowed(this.currentTarget)) {
      await this.bringTargetToFront(this.currentTarget);
    }
    return await this.captureTarget("screenshot");
  }

  async click(
    x: number,
    y: number,
    button: ComputerUseMouseButton = "left",
    captureId?: string,
  ): Promise<ComputerUseToolResult> {
    const { target, capture, visibleControl } = await this.prepareAction("click", captureId);
    validatePointInCapture(x, y, capture);
    try {
      if (button === "left") {
        const axResult = await this.helper().axPressAtPoint({
          windowId: target.windowId,
          pid: target.pid,
          x,
          y,
          captureWidth: capture.width,
          captureHeight: capture.height,
        });
        if (!axResult.pressed) {
          const focusResult = await this.helper().axFocusAtPoint({
            windowId: target.windowId,
            pid: target.pid,
            x,
            y,
            captureWidth: capture.width,
            captureHeight: capture.height,
          });
          if (focusResult.focused) {
            return await this.captureTarget(
              "click",
              "Background accessibility focused the target, but did not confirm a press. Use another action or approve visible control if a real mouse click is required.",
            );
          }
          await this.ensureVisibleControlAllowed("click", target, "background_ax_press_failed");
          if (!visibleControl) {
            await this.bringTargetToFront(target);
          }
          await this.helper().mouseClick({
            windowId: target.windowId,
            pid: target.pid,
            x,
            y,
            captureWidth: capture.width,
            captureHeight: capture.height,
            button: button as ComputerUseHelperMouseButton,
            clickCount: 1,
          });
        }
      } else {
        await this.ensureVisibleControlAllowed("click", target, "non_left_mouse_button");
        if (!visibleControl) {
          await this.bringTargetToFront(target);
        }
        await this.helper().mouseClick({
          windowId: target.windowId,
          pid: target.pid,
          x,
          y,
          captureWidth: capture.width,
          captureHeight: capture.height,
          button: button as ComputerUseHelperMouseButton,
          clickCount: 1,
        });
      }
      return await this.captureTarget("click");
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "click",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async doubleClick(x: number, y: number, captureId?: string): Promise<ComputerUseToolResult> {
    const { target, capture, visibleControl } = await this.prepareAction("double_click", captureId);
    validatePointInCapture(x, y, capture);
    try {
      if (!visibleControl) {
        await this.ensureVisibleControlAllowed("double_click", target, "double_click");
        await this.bringTargetToFront(target);
      }
      await this.helper().mouseClick({
        windowId: target.windowId,
        pid: target.pid,
        x,
        y,
        captureWidth: capture.width,
        captureHeight: capture.height,
        button: "left",
        clickCount: 2,
      });
      return await this.captureTarget("double_click");
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "double_click",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async moveMouse(x: number, y: number, captureId?: string): Promise<ComputerUseToolResult> {
    const { target, capture, visibleControl } = await this.prepareAction("move_mouse", captureId);
    validatePointInCapture(x, y, capture);
    try {
      if (!visibleControl) {
        await this.ensureVisibleControlAllowed("move_mouse", target, "mouse_move");
        await this.bringTargetToFront(target);
      }
      await this.helper().mouseMove({
        windowId: target.windowId,
        pid: target.pid,
        x,
        y,
        captureWidth: capture.width,
        captureHeight: capture.height,
      });
      return await this.captureTarget("move_mouse");
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "move_mouse",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async drag(
    path: Array<{ x: number; y: number }>,
    captureId?: string,
  ): Promise<ComputerUseToolResult> {
    if (!Array.isArray(path) || path.length < 2) {
      throw new Error("drag requires a path with at least two points.");
    }
    const { target, capture, visibleControl } = await this.prepareAction("drag", captureId);
    const normalizedPath = path.map((point, index) => {
      const px = requireFiniteCoordinate(`path[${index}].x`, point.x);
      const py = requireFiniteCoordinate(`path[${index}].y`, point.y);
      validatePointInCapture(px, py, capture, `path[${index}]`);
      return { x: px, y: py };
    });
    try {
      if (!visibleControl) {
        await this.ensureVisibleControlAllowed("drag", target, "mouse_drag");
        await this.bringTargetToFront(target);
      }
      await this.helper().mouseDrag({
        windowId: target.windowId,
        pid: target.pid,
        path: normalizedPath,
        captureWidth: capture.width,
        captureHeight: capture.height,
      });
      return await this.captureTarget("drag");
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "drag",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async scroll(
    x: number,
    y: number,
    scrollX: number,
    scrollY: number,
    captureId?: string,
  ): Promise<ComputerUseToolResult> {
    const { target, capture, visibleControl } = await this.prepareAction("scroll", captureId);
    validatePointInCapture(x, y, capture);
    const normalizedScrollX = requireIntegerInRange("scrollX", scrollX, -10_000, 10_000);
    const normalizedScrollY = requireIntegerInRange("scrollY", scrollY, -10_000, 10_000);
    try {
      if (!visibleControl) {
        await this.ensureVisibleControlAllowed("scroll", target, "mouse_scroll");
        await this.bringTargetToFront(target);
      }
      await this.helper().scrollAtPoint({
        windowId: target.windowId,
        pid: target.pid,
        x,
        y,
        captureWidth: capture.width,
        captureHeight: capture.height,
        scrollX: normalizedScrollX,
        scrollY: normalizedScrollY,
      });
      return await this.captureTarget("scroll");
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "scroll",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async typeText(text: string): Promise<ComputerUseToolResult> {
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("type_text requires a non-empty text string.");
    }
    await this.ensureReady();
    const target = await this.refreshCurrentTarget();
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "type_text",
      targetApp: target.appName,
      bundleId: target.bundleId,
      windowId: target.windowId,
      textLength: text.length,
    });
    try {
      let nextVisibleControl = this.isVisibleControlAllowed(target);
      if (nextVisibleControl) {
        await this.bringTargetToFront(target);
      }
      const focused = await this.helper().focusedElement(target.pid);
      if (focused.exists && focused.canSetValue && !focused.isSecure && focused.elementRef) {
        await this.helper().setValue(focused.elementRef, text);
      } else {
        let focusedTextInput: Awaited<ReturnType<ComputerUseProvider["axFocusTextInput"]>>;
        try {
          focusedTextInput = await this.helper().axFocusTextInput({
            pid: target.pid,
            windowId: target.windowId,
          });
        } catch {
          focusedTextInput = { focused: false };
        }
        if (
          focusedTextInput.focused &&
          focusedTextInput.canSetValue &&
          !focusedTextInput.isSecure &&
          focusedTextInput.elementRef
        ) {
          await this.helper().setValue(focusedTextInput.elementRef, text);
        } else {
          if (!nextVisibleControl) {
            await this.ensureVisibleControlAllowed(
              "type_text",
              target,
              "background_text_value_set_failed",
            );
            nextVisibleControl = true;
            await this.bringTargetToFront(target);
          }
          await this.helper().typeText(text, target.pid, target.windowId);
        }
      }
      return await this.captureTarget("type_text");
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "type_text",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async pressKeys(keys: string[]): Promise<ComputerUseToolResult> {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error("keypress requires a non-empty keys array.");
    }
    const normalized = normalizeKeysForBlocklist(keys);
    if (BLOCKED_KEY_COMBOS.has(normalized)) {
      throw new Error(`Blocked key combination: ${keys.join("+")}.`);
    }
    await this.ensureReady();
    const target = await this.refreshCurrentTarget();
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "keypress",
      targetApp: target.appName,
      bundleId: target.bundleId,
      windowId: target.windowId,
      keys,
    });
    try {
      await this.ensureVisibleControlAllowed("keypress", target, "keyboard_event");
      await this.bringTargetToFront(target);
      await this.helper().pressKeys({
        ...parseKeypressSpec(target.pid, keys),
        windowId: target.windowId,
      });
      return await this.captureTarget("keypress");
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "keypress",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async wait(ms?: number): Promise<ComputerUseToolResult> {
    const delayMs =
      ms === undefined ? DEFAULT_WAIT_MS : requireIntegerInRange("ms", ms, 0, MAX_WAIT_MS);
    await this.ensureReady();
    await this.refreshCurrentTarget();
    this.requireCurrentCapture();
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "wait",
      ms: delayMs,
    });
    await sleep(delayMs);
    return await this.captureTarget("wait");
  }

  static getToolDefinitions(options?: { headless?: boolean }): LLMTool[] {
    if (options?.headless || (process.platform !== "darwin" && process.platform !== "win32")) {
      return [];
    }
    return [
      {
        name: "screenshot",
        description:
          "Capture the current controlled window in a native desktop app. Call this first. " +
          "Passing app and/or windowTitle retargets control to that window. Defaults to background window capture; visible control is a fallback only when approved.",
        input_schema: {
          type: "object",
          properties: {
            app: {
              type: "string",
              description: "Optional app name or bundle id to retarget before capturing.",
            },
            windowTitle: {
              type: "string",
              description: "Optional window title filter to retarget before capturing.",
            },
          },
          required: [],
        },
      },
      {
        name: "click",
        description:
          "Click inside the current controlled window using screenshot-relative coordinates. " +
          "Use the latest captureId to guard against stale state. Returns a fresh screenshot.",
        input_schema: {
          type: "object",
          properties: {
            x: {
              type: "number",
              description: "Window-relative X coordinate from the latest screenshot.",
            },
            y: {
              type: "number",
              description: "Window-relative Y coordinate from the latest screenshot.",
            },
            button: {
              type: "string",
              enum: ["left", "right", "wheel", "back", "forward"],
              description: "Mouse button to click. Defaults to left.",
            },
            captureId: {
              type: "string",
              description: "Optional validation token from the latest screenshot().",
            },
          },
          required: ["x", "y"],
        },
      },
      {
        name: "double_click",
        description:
          "Double-click inside the current controlled window using screenshot-relative coordinates. Returns a fresh screenshot.",
        input_schema: {
          type: "object",
          properties: {
            x: {
              type: "number",
              description: "Window-relative X coordinate from the latest screenshot.",
            },
            y: {
              type: "number",
              description: "Window-relative Y coordinate from the latest screenshot.",
            },
            captureId: {
              type: "string",
              description: "Optional validation token from the latest screenshot().",
            },
          },
          required: ["x", "y"],
        },
      },
      {
        name: "move_mouse",
        description:
          "Move the pointer inside the current controlled window using screenshot-relative coordinates. Returns a fresh screenshot.",
        input_schema: {
          type: "object",
          properties: {
            x: {
              type: "number",
              description: "Window-relative X coordinate from the latest screenshot.",
            },
            y: {
              type: "number",
              description: "Window-relative Y coordinate from the latest screenshot.",
            },
            captureId: {
              type: "string",
              description: "Optional validation token from the latest screenshot().",
            },
          },
          required: ["x", "y"],
        },
      },
      {
        name: "drag",
        description:
          "Drag through a series of screenshot-relative points inside the current controlled window. Returns a fresh screenshot.",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "array",
              description: "Ordered drag path in screenshot-relative coordinates.",
              items: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                },
                required: ["x", "y"],
              },
            },
            captureId: {
              type: "string",
              description: "Optional validation token from the latest screenshot().",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "scroll",
        description:
          "Scroll at a screenshot-relative point inside the current controlled window. scrollX and scrollY are signed line deltas. Returns a fresh screenshot.",
        input_schema: {
          type: "object",
          properties: {
            x: {
              type: "number",
              description: "Window-relative X coordinate from the latest screenshot.",
            },
            y: {
              type: "number",
              description: "Window-relative Y coordinate from the latest screenshot.",
            },
            scrollX: { type: "number", description: "Signed horizontal scroll delta in lines." },
            scrollY: { type: "number", description: "Signed vertical scroll delta in lines." },
            captureId: {
              type: "string",
              description: "Optional validation token from the latest screenshot().",
            },
          },
          required: ["x", "y", "scrollX", "scrollY"],
        },
      },
      {
        name: "type_text",
        description:
          "Type or set text into the currently focused control of the current controlled window. Returns a fresh screenshot.",
        input_schema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text to enter into the focused control.",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "keypress",
        description:
          "Send a key or key chord to the current controlled window. Modifier keys: cmd/command on macOS, win/windows on Windows, ctrl/control, alt/option, shift. Returns a fresh screenshot.",
        input_schema: {
          type: "object",
          properties: {
            keys: {
              type: "array",
              items: { type: "string" },
              description: 'Array of key names to press together, e.g. ["cmd", "c"] or ["return"].',
            },
          },
          required: ["keys"],
        },
      },
      {
        name: "wait",
        description:
          "Pause briefly and then refresh the current controlled window screenshot. Useful after async UI transitions.",
        input_schema: {
          type: "object",
          properties: {
            ms: {
              type: "number",
              description: `Optional wait duration in milliseconds (default ${DEFAULT_WAIT_MS}).`,
            },
          },
          required: [],
        },
      },
    ];
  }
}
