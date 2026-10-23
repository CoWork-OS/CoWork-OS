/**
 * CuaSpaceProvider — runs CoWork Computer Use against a Cua Space (an isolated computer)
 * through the Cua Driver MCP tools served by cua-spacesd, instead of the host desktop.
 *
 * Mapping notes (Cua Driver v0.32 tool registry):
 * - Window-targeted pointer x/y are screenshot pixels of that window's latest
 *   get_window_state, which is the same space CoWork captures use, so they pass
 *   through unscaled. Element `screenshot_frame` is in that space too; `frame` is
 *   screen coordinates and is never used for hit-testing.
 * - Input tools take either `target` or the flat `pid` form, never both.
 * - Cua accessibility is element-token based: tokens come from get_window_state and go
 *   stale after the next snapshot of the same window, so the cache is per capture.
 * - Point-based AX focus is not exposed; axFocusAtPoint reports unsupported and the
 *   tools fall back to their existing visible-control path.
 */

import type { ComputerUseProvider } from "../provider";
import type {
  ComputerUseAxElementResult,
  ComputerUseAxFocusResult,
  ComputerUseAxPressResult,
  ComputerUseFocusedElementResult,
  ComputerUseFrontmostApp,
  ComputerUseHelperApp,
  ComputerUseHelperKeypressSpec,
  ComputerUseHelperMouseButton,
  ComputerUseHelperStatus,
  ComputerUseHelperWindow,
  ComputerUseScreenshotPayload,
} from "../helper-runtime";
import { macKeyNameForCode } from "../mac-key-codes";
import {
  connectCuaSpace,
  cuaSpaceUnreachableMessage,
  type CuaSpaceClientLike,
  type CuaToolResult,
} from "./client";

type Json = Record<string, unknown>;

interface CuaWindowRecord {
  pid: number;
  framePoints: { x: number; y: number; w: number; h: number };
}

interface CuaElement {
  token: string;
  role: string;
  subrole?: string;
  secure: boolean;
  label?: string;
  value?: string;
  actions: string[];
  focused: boolean;
  frame?: { x: number; y: number; w: number; h: number };
}

interface CuaWindowSnapshot {
  pid: number;
  windowId: number;
  captureId?: string;
  elements: CuaElement[];
}

const TEXT_INPUT_ROLE =
  /text ?field|text ?area|textfield|textarea|search ?field|combo ?box|entry|edit/i;
const SECURE_ROLE = /secure|password/i;
const ELEMENT_REF_PREFIX = "cua:";
/** Base64 length of a 32 MB PNG; anything larger is refused before decoding. */
const MAX_SCREENSHOT_BASE64_LENGTH = Math.ceil((32 * 1024 * 1024) / 3) * 4;

const MODIFIER_NAMES: Record<string, string> = {
  command: "cmd",
  control: "ctrl",
  option: "alt",
  shift: "shift",
};

const KEY_ALIASES: Record<string, string> = {
  pageup: "page_up",
  pagedown: "page_down",
};

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** structuredContent when present, otherwise the first JSON text block. */
function payloadOf(result: CuaToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      try {
        return JSON.parse(block.text);
      } catch {
        // Not JSON; keep looking.
      }
    }
  }
  return undefined;
}

/** Find the record list in a payload: either the payload itself or its first array field. */
function listOf(payload: unknown, preferredKeys: string[]): Json[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of preferredKeys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  const isPng =
    buffer.length >= 24 &&
    buffer.readUInt32BE(0) === 0x89504e47 &&
    buffer.readUInt32BE(4) === 0x0d0a1a0a &&
    buffer.toString("ascii", 12, 16) === "IHDR";
  return isPng ? { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) } : null;
}

function encodeElementRef(pid: number, token: string): string {
  return `${ELEMENT_REF_PREFIX}${pid}:${token}`;
}

function decodeElementRef(ref: string): { pid: number; token: string } {
  const match = /^cua:(\d+):(.+)$/s.exec(ref);
  if (!match) {
    throw new Error("Element reference does not belong to the Cua Space provider.");
  }
  return { pid: Number(match[1]), token: match[2] };
}

function parseElements(payload: unknown): CuaElement[] {
  const records = listOf(payload, ["elements"]);
  const elements: CuaElement[] = [];
  for (const record of records) {
    const token = str(record.element_token);
    if (!token) continue;
    // Only screenshot_frame shares the pixel space of window-local pointer input.
    const frame =
      isRecord(record.screenshot_frame) && record.screenshot_frame_valid !== false
        ? record.screenshot_frame
        : undefined;
    const fx = num(frame?.x);
    const fy = num(frame?.y);
    const fw = num(frame?.w) ?? num(frame?.width);
    const fh = num(frame?.h) ?? num(frame?.height);
    elements.push({
      token,
      role: str(record.role) ?? "",
      ...(str(record.subrole) ? { subrole: str(record.subrole) } : {}),
      secure:
        record.secure === true ||
        record.is_secure === true ||
        SECURE_ROLE.test(`${str(record.role) ?? ""} ${str(record.subrole) ?? ""}`),
      label: str(record.label),
      value: typeof record.value === "string" ? record.value : undefined,
      actions: Array.isArray(record.actions)
        ? record.actions.filter((a): a is string => typeof a === "string")
        : [],
      focused: record.focused === true,
      ...(fx !== undefined && fy !== undefined && fw !== undefined && fh !== undefined
        ? { frame: { x: fx, y: fy, w: fw, h: fh } }
        : {}),
    });
  }
  return elements;
}

function isTextInputElement(element: CuaElement): boolean {
  return TEXT_INPUT_ROLE.test(`${element.role} ${element.subrole ?? ""}`);
}

function isEditableTextInput(element: CuaElement): boolean {
  return isTextInputElement(element) && !element.secure;
}

function describeElement(element: CuaElement, pid: number): ComputerUseAxElementResult {
  const isTextInput = isTextInputElement(element) || element.secure;
  const isSecure = element.secure;
  return {
    found: true,
    exists: true,
    elementRef: encodeElementRef(pid, element.token),
    role: element.role,
    ...(element.subrole ? { subrole: element.subrole } : {}),
    title: element.label,
    value: isSecure ? undefined : element.value,
    actions: element.actions,
    isTextInput,
    isSecure,
    canSetValue: isTextInput && !isSecure,
    ...(element.frame
      ? { x: element.frame.x + element.frame.w / 2, y: element.frame.y + element.frame.h / 2 }
      : {}),
  };
}

export class CuaSpaceProvider implements ComputerUseProvider {
  private readonly windows = new Map<number, CuaWindowRecord>();
  private readonly snapshots = new Map<number, CuaWindowSnapshot>();
  /** Last window captured per pid; pid-only AX calls resolve against it. */
  private readonly lastWindowByPid = new Map<number, number>();

  constructor(
    private readonly client: CuaSpaceClientLike,
    private readonly origin: string,
  ) {}

  getHelperPath(): string {
    return this.origin;
  }

  getHelperSourcePath(): string | null {
    return null;
  }

  async getStatus(): Promise<ComputerUseHelperStatus> {
    const healthy = await this.client.checkHealth();
    return {
      platform: process.platform,
      helperPath: this.origin,
      sourcePath: null,
      installed: healthy,
      // Space images ship with Accessibility and Screen Recording pre-granted.
      accessibility: healthy,
      screenRecording: healthy,
      ...(healthy ? {} : { error: cuaSpaceUnreachableMessage(this.origin) }),
    };
  }

  async ensureReadyWithInteractivePermissions(): Promise<void> {
    await connectCuaSpace(this.client, this.origin);
  }

  stop(): void {
    this.windows.clear();
    this.snapshots.clear();
    this.lastWindowByPid.clear();
    void this.client.disconnect();
  }

  async listApps(): Promise<ComputerUseHelperApp[]> {
    const payload = payloadOf(await this.client.callTool("list_apps", {}));
    const apps: ComputerUseHelperApp[] = [];
    for (const record of listOf(payload, ["apps", "applications"])) {
      const pid = num(record.pid);
      if (pid === undefined || pid <= 0 || record.running === false) continue;
      apps.push({
        appName: str(record.name) ?? `pid ${pid}`,
        ...(str(record.bundle_id) ? { bundleId: str(record.bundle_id) } : {}),
        pid,
        isFrontmost: record.active === true || record.frontmost === true,
      });
    }
    return apps;
  }

  async listWindows(pid: number): Promise<ComputerUseHelperWindow[]> {
    const payload = payloadOf(
      await this.client.callTool("list_windows", { pid, on_screen_only: false }),
    );
    const records = listOf(payload, ["windows"]).filter((record) => {
      const owner = num(record.pid);
      return owner === undefined || owner === pid;
    });
    const topZ = Math.max(...records.map((record) => num(record.z_index) ?? 0), 0);
    return records.map((record) => {
      const windowId = num(record.window_id);
      const bounds = isRecord(record.bounds) ? record.bounds : {};
      const framePoints = {
        x: num(bounds.x) ?? 0,
        y: num(bounds.y) ?? 0,
        w: num(bounds.width) ?? num(bounds.w) ?? 0,
        h: num(bounds.height) ?? num(bounds.h) ?? 0,
      };
      if (windowId !== undefined) {
        this.windows.set(windowId, { pid, framePoints });
      }
      const isMain = (num(record.z_index) ?? 0) === topZ;
      return {
        ...(windowId !== undefined ? { windowId } : {}),
        title: str(record.title) ?? "",
        framePoints,
        scaleFactor: 1,
        isMinimized: record.minimized === true,
        isOnscreen: record.is_on_screen !== false,
        isMain,
        isFocused: isMain,
      };
    });
  }

  async getFrontmost(): Promise<ComputerUseFrontmostApp> {
    const apps = await this.listApps();
    const app = apps.find((candidate) => candidate.isFrontmost) ?? apps[0];
    if (!app) {
      throw new Error("The Cua Space has no running apps to control.");
    }
    const windows = await this.listWindows(app.pid);
    const window = windows.find((candidate) => candidate.isMain) ?? windows[0];
    return {
      appName: app.appName,
      ...(app.bundleId ? { bundleId: app.bundleId } : {}),
      pid: app.pid,
      ...(window?.title ? { windowTitle: window.title } : {}),
      ...(typeof window?.windowId === "number" ? { windowId: window.windowId } : {}),
    };
  }

  private async pidForWindow(windowId: number): Promise<number> {
    const known = this.windows.get(windowId);
    if (known) return known.pid;
    const payload = payloadOf(await this.client.callTool("list_windows", {}));
    for (const record of listOf(payload, ["windows"])) {
      if (num(record.window_id) === windowId && num(record.pid) !== undefined) {
        return num(record.pid)!;
      }
    }
    throw new Error(`Window ${windowId} is not present in the Cua Space.`);
  }

  async screenshot(windowId: number): Promise<ComputerUseScreenshotPayload> {
    const pid = await this.pidForWindow(windowId);
    const result = await this.client.callTool("get_window_state", {
      pid,
      window_id: windowId,
      include_screenshot: true,
    });
    const payload = payloadOf(result);
    const structured = isRecord(payload) ? payload : {};

    const imageBlock = result.content.find(
      (block) => block.type === "image" && typeof block.data === "string",
    );
    const pngBase64 =
      imageBlock?.data ??
      str(structured.screenshot_base64) ??
      str(structured.screenshot) ??
      str(structured.image);
    if (!pngBase64) {
      const reason = str(structured.screenshot_error);
      throw new Error(
        `Cua Space get_window_state returned no screenshot${reason ? `: ${reason}` : "."}`,
      );
    }
    if (pngBase64.length > MAX_SCREENSHOT_BASE64_LENGTH) {
      throw new Error("Cua Space screenshot is larger than 32 MB.");
    }
    if (imageBlock?.mimeType && imageBlock.mimeType !== "image/png") {
      throw new Error(`Cua Space returned ${imageBlock.mimeType}; Computer Use expects PNG.`);
    }
    const dims = pngDimensions(Buffer.from(pngBase64, "base64"));
    if (!dims) {
      throw new Error("Cua Space screenshot is not a PNG image.");
    }

    const captureId = str(structured.capture_id) ?? str(structured.screenshot_id);
    this.snapshots.set(windowId, {
      pid,
      windowId,
      ...(captureId ? { captureId } : {}),
      elements: parseElements(payload),
    });
    this.lastWindowByPid.set(pid, windowId);

    const frameWidth = this.windows.get(windowId)?.framePoints.w ?? 0;
    const scaleFactor =
      num(structured.scale) ??
      num(structured.scale_factor) ??
      (frameWidth > 0 ? dims.width / frameWidth : 1);
    return { pngBase64, width: dims.width, height: dims.height, scaleFactor };
  }

  private target(pid: number, windowId: number): Json {
    return { kind: "window", pid, window_id: windowId };
  }

  private captureBinding(windowId: number): Json {
    const captureId = this.snapshots.get(windowId)?.captureId;
    return captureId ? { capture_id: captureId } : {};
  }

  async axPressAtPoint(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
  }): Promise<ComputerUseAxPressResult> {
    const result = await this.client.callTool("click", {
      target: this.target(args.pid, args.windowId),
      x: args.x,
      y: args.y,
      button: "left",
      count: 1,
      delivery_mode: "background",
      ...this.captureBinding(args.windowId),
    });
    const payload = payloadOf(result);
    const effect = isRecord(payload) ? str(payload.effect) : undefined;
    if (effect === "suspected_noop") {
      return { pressed: false, reason: "cua_suspected_noop" };
    }
    return { pressed: true };
  }

  async axFocusAtPoint(): Promise<ComputerUseAxFocusResult> {
    return { focused: false, reason: "cua_space_point_focus_unsupported" };
  }

  async axDescribeAtPoint(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
  }): Promise<Record<string, unknown>> {
    const element = this.snapshots
      .get(args.windowId)
      ?.elements.find(
        (candidate) =>
          candidate.frame &&
          args.x >= candidate.frame.x &&
          args.x <= candidate.frame.x + candidate.frame.w &&
          args.y >= candidate.frame.y &&
          args.y <= candidate.frame.y + candidate.frame.h,
      );
    return element ? { ...describeElement(element, args.pid) } : { found: false };
  }

  private elementsFor(pid: number, windowId?: number): CuaElement[] {
    const resolved = windowId ?? this.lastWindowByPid.get(pid);
    if (resolved === undefined) return [];
    const snapshot = this.snapshots.get(resolved);
    return snapshot && snapshot.pid === pid ? snapshot.elements : [];
  }

  private findElement(
    pid: number,
    windowId: number | undefined,
    predicate: (element: CuaElement) => boolean,
  ): ComputerUseAxElementResult {
    const element = this.elementsFor(pid, windowId).find(predicate);
    return element ? describeElement(element, pid) : { found: false, reason: "not_found" };
  }

  async axFindTextInput(args: {
    pid: number;
    windowId?: number;
  }): Promise<ComputerUseAxElementResult> {
    return this.findElement(args.pid, args.windowId, isEditableTextInput);
  }

  async axFocusTextInput(args: {
    pid: number;
    windowId?: number;
  }): Promise<ComputerUseAxElementResult> {
    const elements = this.elementsFor(args.pid, args.windowId).filter(isEditableTextInput);
    // Only claim focus when the target is unambiguous: the focused field, or the sole field.
    const element =
      elements.find((candidate) => candidate.focused) ??
      (elements.length === 1 ? elements[0] : undefined);
    if (!element) return { focused: false, reason: "no_unambiguous_text_input" };
    return { ...describeElement(element, args.pid), focused: true };
  }

  async axFindFocusableElement(args: {
    pid: number;
    windowId?: number;
    roles?: string[];
  }): Promise<ComputerUseAxElementResult> {
    const roles = args.roles?.map((role) => role.toLowerCase());
    return this.findElement(args.pid, args.windowId, (element) =>
      roles ? roles.includes(element.role.toLowerCase()) : element.actions.length > 0,
    );
  }

  async axFindActionableElement(args: {
    pid: number;
    windowId?: number;
    roles?: string[];
  }): Promise<ComputerUseAxElementResult> {
    return this.axFindFocusableElement(args);
  }

  async focusedElement(pid: number): Promise<ComputerUseFocusedElementResult> {
    const element = this.elementsFor(pid).find((candidate) => candidate.focused);
    if (!element) return { exists: false };
    const described = describeElement(element, pid);
    return {
      exists: true,
      elementRef: described.elementRef,
      role: described.role,
      ...(described.subrole ? { subrole: described.subrole } : {}),
      isTextInput: described.isTextInput,
      isSecure: described.isSecure,
      canSetValue: described.canSetValue,
    };
  }

  async setValue(elementRef: string, value: string): Promise<void> {
    const { pid, token } = decodeElementRef(elementRef);
    // Re-check against the latest snapshot: tokens go stale after the next capture,
    // and secure fields must never be written regardless of what the caller checked.
    const element = this.elementsFor(pid).find((candidate) => candidate.token === token);
    if (!element) {
      throw new Error("Element reference is stale. Call screenshot() to refresh.");
    }
    if (element.secure) {
      throw new Error("Refusing to set the value of a secure text field.");
    }
    await this.client.callTool("set_value", { pid, element_token: token, value });
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
    const button = args.button ?? "left";
    if (button === "back" || button === "forward") {
      throw new Error(`The Cua Space backend does not support the ${button} mouse button.`);
    }
    await this.client.callTool("click", {
      target: this.target(args.pid, args.windowId),
      x: args.x,
      y: args.y,
      button: button === "wheel" ? "middle" : button,
      count: Math.max(1, Math.min(3, args.clickCount ?? 1)),
      delivery_mode: "foreground",
      ...this.captureBinding(args.windowId),
    });
  }

  async mouseMove(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
  }): Promise<void> {
    // Window-targeted coordinates are screenshot pixels, like click.
    await this.client.callTool("move_cursor", {
      target: this.target(args.pid, args.windowId),
      x: args.x,
      y: args.y,
    });
  }

  async mouseDrag(args: {
    windowId: number;
    pid: number;
    path: Array<{ x: number; y: number }>;
    captureWidth: number;
    captureHeight: number;
  }): Promise<void> {
    const from = args.path[0];
    const to = args.path[args.path.length - 1];
    if (!from || !to) {
      throw new Error("drag requires at least two points.");
    }
    // Cua drag interpolates a straight segment; intermediate path points are not replayed.
    await this.client.callTool("drag", {
      target: this.target(args.pid, args.windowId),
      from_x: from.x,
      from_y: from.y,
      to_x: to.x,
      to_y: to.y,
      steps: Math.max(2, Math.min(100, args.path.length * 5)),
      delivery_mode: "foreground",
    });
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
    const vertical = Math.abs(args.scrollY) >= Math.abs(args.scrollX);
    const delta = vertical ? args.scrollY : args.scrollX;
    if (delta === 0) return;
    const direction = vertical ? (delta > 0 ? "down" : "up") : delta > 0 ? "right" : "left";
    await this.client.callTool("scroll", {
      target: this.target(args.pid, args.windowId),
      direction,
      amount: Math.max(1, Math.min(50, Math.abs(delta))),
      by: "line",
    });
  }

  /** Exact window target when one is known, otherwise the flat pid form. */
  private inputTarget(pid: number, windowId: number | undefined): Json {
    const resolved = windowId ?? this.lastWindowByPid.get(pid);
    return resolved !== undefined ? { target: this.target(pid, resolved) } : { pid };
  }

  async typeText(text: string, pid: number, windowId?: number): Promise<void> {
    // Keystrokes land in whatever has focus; refuse when the last capture shows a
    // secure field there, matching setValue's refusal.
    const focused = this.elementsFor(pid, windowId).find((candidate) => candidate.focused);
    if (focused?.secure) {
      throw new Error("Refusing to type into a secure text field.");
    }
    await this.client.callTool("type_text", {
      text,
      ...this.inputTarget(pid, windowId),
      delivery_mode: "foreground",
    });
  }

  async pressKeys(spec: ComputerUseHelperKeypressSpec & { windowId?: number }): Promise<void> {
    const rawKey =
      spec.keyText ??
      (typeof spec.keyCode === "number" ? macKeyNameForCode(spec.keyCode) : undefined);
    if (!rawKey) {
      throw new Error(`The Cua Space backend cannot map key code ${spec.keyCode}.`);
    }
    const key = KEY_ALIASES[rawKey] ?? rawKey;
    const modifiers = (spec.modifiers ?? []).map(
      (modifier) => MODIFIER_NAMES[modifier.toLowerCase()] ?? modifier.toLowerCase(),
    );
    const target = this.inputTarget(spec.pid, spec.windowId);
    // press_key sends one key; combinations go through hotkey.
    if (modifiers.length > 0) {
      await this.client.callTool("hotkey", { keys: [...modifiers, key], ...target });
    } else {
      await this.client.callTool("press_key", { key, ...target });
    }
  }

  async activateApp(pid: number): Promise<void> {
    await this.client.callTool("bring_to_front", { pid });
  }

  async raiseWindow(): Promise<void> {
    // bring_to_front in activateApp already raises the app's front window.
  }

  async unminimizeWindow(): Promise<void> {
    // Cua Driver exposes no unminimize tool; set_window_frame cannot restore a minimized window.
  }

  async openPermissionPane(): Promise<void> {
    // Permissions live inside the Space image, not on this Mac.
  }
}
