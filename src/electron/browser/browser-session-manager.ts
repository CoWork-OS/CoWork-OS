import * as path from "path";
import type { AccessDomainRule } from "../../shared/access-profiles";
import { evaluateNetworkPolicy } from "../security/network-policy";
import { isLocalHtmlFileUrl, isLoopbackHttpUrl, normalizeWebviewUrl } from "./webview-url-policy";

type Any = any;

export type BrowserBackendKind = "electron-workbench" | "playwright-local" | "external-cdp";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserSnapshotNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  text?: string;
  bounds?: BrowserBounds;
  disabled?: boolean;
  focused?: boolean;
  selected?: boolean;
}

export interface BrowserSnapshotResult {
  success: true;
  sessionId: string;
  tabId: string;
  url: string;
  title: string;
  nodes: BrowserSnapshotNode[];
  focusedRef?: string;
  consoleSummary: BrowserDiagnosticSummary;
  networkSummary: BrowserDiagnosticSummary;
}

export interface BrowserDiagnosticSummary {
  count: number;
  recent: string[];
}

export interface BrowserConsoleEntry {
  level: string;
  text: string;
  source?: string;
  timestamp: number;
}

export interface BrowserNetworkEntry {
  method?: string;
  url: string;
  status?: number;
  resourceType?: string;
  failed?: boolean;
  errorText?: string;
  timestamp: number;
}

export interface BrowserTabInfo {
  tabId: string;
  title: string;
  url: string;
  active: boolean;
  backend: BrowserBackendKind;
}

interface ElectronWorkbenchSessionRegistration {
  taskId: string;
  sessionId?: string;
  webContentsId: number;
  url?: string;
  title?: string;
}

export interface BrowserSessionAccessPolicy {
  networkEnabled: boolean;
  accessNetworkMode?: "disabled" | "on-request" | "enabled";
  profileDomainRules?: AccessDomainRule[];
}

interface BrowserSessionRecord {
  taskId: string;
  sessionId: string;
  webContentsId: number;
  url: string;
  title: string;
  backend: BrowserBackendKind;
  activeTabId: string;
  registeredAt: number;
  latestSnapshotId?: string;
  refs: Map<string, BrowserRefTarget>;
  consoleEntries: BrowserConsoleEntry[];
  networkEntries: BrowserNetworkEntry[];
  downloads: BrowserNetworkEntry[];
  lastDialog?: {
    type?: string;
    message?: string;
    defaultPrompt?: string;
    timestamp: number;
  };
  traceActive?: boolean;
}

interface BrowserRefTarget {
  snapshotId: string;
  backendNodeId?: number;
  nodeId?: number;
  node: BrowserSnapshotNode;
}

const MAX_SNAPSHOT_NODES = 140;
const MAX_DIAGNOSTIC_ENTRIES = 120;
const SECRET_VALUE_PATTERN =
  /(authorization|token|api[-_ ]?key|secret|password|passwd|cookie|set-cookie|session)\s*[=:]\s*(?:bearer\s+)?([^\s"';&]+)/gi;
const BEARER_VALUE_PATTERN = /\bbearer\s+[a-z0-9._~+/-]+=*/gi;
const SECRET_QUERY_PATTERN =
  /([?&](?:access_token|refresh_token|token|api_key|key|password|secret|session)=[^&#]*)/gi;
const SECRET_STORAGE_KEY_PATTERN =
  /(?:authorization|auth(?:entication)?|authuser|token|api[-_ ]?key|secret|password|passwd|cookie|set-cookie|session)/i;

export function normalizeBrowserUrl(rawUrl?: unknown): string {
  const value = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!value) return "";
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|::1)(?::\d+)?(?:\/|$)/i.test(value)) {
    return `http://${value}`;
  }
  return `https://${value}`;
}

export function redactBrowserText(value: unknown, maxLength = 2000): string {
  const text = String(value ?? "");
  return text
    .replace(SECRET_VALUE_PATTERN, "$1=[REDACTED]")
    .replace(BEARER_VALUE_PATTERN, "Bearer [REDACTED]")
    .replace(SECRET_QUERY_PATTERN, "[REDACTED_PARAM]")
    .slice(0, maxLength);
}

function isSensitiveStorageKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (!normalized || normalized === "localstorage" || normalized === "sessionstorage") {
    return false;
  }
  return SECRET_STORAGE_KEY_PATTERN.test(normalized);
}

export function redactBrowserStoragePayload(value: unknown, keyHint = "", depth = 0): unknown {
  if (keyHint && isSensitiveStorageKey(keyHint)) {
    return "[REDACTED]";
  }
  if (depth > 8) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactBrowserStoragePayload(item, "", depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactBrowserStoragePayload(item, key, depth + 1);
    }
    return output;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        return redactBrowserText(
          JSON.stringify(redactBrowserStoragePayload(parsed, "", depth + 1)),
          4000,
        );
      } catch {
        // Fall back to text redaction below for non-JSON strings.
      }
    }
    return redactBrowserText(value, 4000);
  }
  return value;
}

function normalizeSessionId(sessionId?: unknown): string {
  const value = typeof sessionId === "string" ? sessionId.trim() : "";
  return value || "default";
}

function sessionKey(taskId: string, sessionId?: unknown): string {
  return `${taskId}:${normalizeSessionId(sessionId)}`;
}

function getAxValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    return getAxValue((value as Record<string, unknown>).value);
  }
  return String(value);
}

function getAxProperty(node: Any, name: string): unknown {
  const properties = Array.isArray(node?.properties) ? node.properties : [];
  const property = properties.find((item: Any) => item?.name === name);
  return property?.value?.value;
}

function isInterestingAxNode(node: Any): boolean {
  if (!node || node.ignored === true) return false;
  const role = getAxValue(node.role).toLowerCase();
  const name = getAxValue(node.name).trim();
  const value = getAxValue(node.value).trim();
  const interactiveRoles = new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "menuitem",
    "radio",
    "searchbox",
    "slider",
    "switch",
    "tab",
    "textbox",
    "treeitem",
  ]);
  if (interactiveRoles.has(role)) return true;
  if (role === "image" && name) return true;
  if ((role === "heading" || role === "text" || role === "statictext") && name) return true;
  return Boolean(name || value);
}

function boundsFromBoxModel(model: Any): BrowserBounds | undefined {
  const quad = model?.model?.border || model?.model?.content;
  if (!Array.isArray(quad) || quad.length < 8) return undefined;
  const xs = [quad[0], quad[2], quad[4], quad[6]].filter((value) => Number.isFinite(value));
  const ys = [quad[1], quad[3], quad[5], quad[7]].filter((value) => Number.isFinite(value));
  if (xs.length === 0 || ys.length === 0) return undefined;
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    x: Math.max(0, Math.round(left)),
    y: Math.max(0, Math.round(top)),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top)),
  };
}

export class BrowserSessionManager {
  private sessions = new Map<string, BrowserSessionRecord>();
  private debuggerHandlers = new Map<number, (...args: Any[]) => void>();
  private accessPolicies = new Map<string, BrowserSessionAccessPolicy>();
  private accessGuardHandlers = new Map<
    number,
    { contents: Any; willNavigate: Any; willRedirect: Any }
  >();
  private guardedWebRequestSessions = new WeakSet<object>();
  private allowedLocalPreviewUrls = new Map<string, number>();

  private static readonly LOCAL_PREVIEW_TTL_MS = 5 * 60_000;

  setAccessPolicy(taskId: string, policy: BrowserSessionAccessPolicy, sessionId?: unknown): void {
    this.accessPolicies.set(sessionKey(taskId, sessionId), {
      networkEnabled: policy.networkEnabled === true,
      accessNetworkMode: policy.accessNetworkMode,
      profileDomainRules: policy.profileDomainRules ? [...policy.profileDomainRules] : undefined,
    });
  }

  clearAccessPolicy(taskId: string, sessionId?: unknown): void {
    this.accessPolicies.delete(sessionKey(taskId, sessionId));
  }

  /**
   * Permit one explicitly requested local HTML preview. Local file URLs are
   * never allowed merely because they have a valid `.html` extension: the
   * renderer must first register the exact URL it intends to display.
   */
  allowLocalPreviewUrl(rawUrl: string): void {
    if (!isLocalHtmlFileUrl(rawUrl) && !isLoopbackHttpUrl(rawUrl)) return;
    const normalized = normalizeWebviewUrl(rawUrl);
    if (!normalized) return;
    this.allowedLocalPreviewUrls.set(
      normalized,
      Date.now() + BrowserSessionManager.LOCAL_PREVIEW_TTL_MS,
    );
  }

  revokeLocalPreviewUrl(rawUrl: string): void {
    const normalized = normalizeWebviewUrl(rawUrl);
    if (!normalized) return;
    this.allowedLocalPreviewUrls.delete(normalized);
  }

  private isAllowedLocalPreviewUrl(rawUrl: string): boolean {
    const normalized = normalizeWebviewUrl(rawUrl);
    if (!normalized) return false;
    const expiresAt = this.allowedLocalPreviewUrls.get(normalized);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.allowedLocalPreviewUrls.delete(normalized);
      return false;
    }
    this.allowedLocalPreviewUrls.set(
      normalized,
      Date.now() + BrowserSessionManager.LOCAL_PREVIEW_TTL_MS,
    );
    return true;
  }

  assertUrlAllowed(taskId: string, rawUrl: string, sessionId?: unknown): void {
    const key = sessionKey(taskId, sessionId);
    const session = this.sessions.get(key);
    const policy = session ? this.getAccessPolicy(session) : this.accessPolicies.get(key);
    if (!this.isUrlAllowedWithPolicy(policy, rawUrl)) {
      throw new Error(`Browser access denied for "${rawUrl}" by the active access profile.`);
    }
  }

  registerElectronWorkbenchSession(registration: ElectronWorkbenchSessionRegistration): void {
    const sessionId = normalizeSessionId(registration.sessionId);
    const key = sessionKey(registration.taskId, sessionId);
    const existing = this.sessions.get(key);
    this.sessions.set(key, {
      taskId: registration.taskId,
      sessionId,
      webContentsId: registration.webContentsId,
      url: registration.url || existing?.url || "",
      title: registration.title || existing?.title || "",
      backend: "electron-workbench",
      activeTabId: existing?.activeTabId || "active",
      registeredAt: existing?.registeredAt || Date.now(),
      latestSnapshotId: existing?.latestSnapshotId,
      refs: existing?.refs || new Map(),
      consoleEntries: existing?.consoleEntries || [],
      networkEntries: existing?.networkEntries || [],
      downloads: existing?.downloads || [],
      lastDialog: existing?.lastDialog,
      traceActive: existing?.traceActive,
    });
  }

  unregisterSession(input: { taskId: string; sessionId?: string; webContentsId?: number }): void {
    const key = sessionKey(input.taskId, input.sessionId);
    const existing = this.sessions.get(key);
    if (!existing) return;
    if (typeof input.webContentsId === "number" && existing.webContentsId !== input.webContentsId) {
      return;
    }
    this.sessions.delete(key);
    this.accessPolicies.delete(key);
    const handlers = this.accessGuardHandlers.get(existing.webContentsId);
    if (handlers) {
      handlers.contents.removeListener?.("will-navigate", handlers.willNavigate);
      handlers.contents.removeListener?.("will-redirect", handlers.willRedirect);
      this.accessGuardHandlers.delete(existing.webContentsId);
    }
  }

  updateSession(input: {
    taskId: string;
    sessionId?: string;
    webContentsId?: number;
    url?: string;
    title?: string;
  }): void {
    const key = sessionKey(input.taskId, input.sessionId);
    const existing = this.sessions.get(key);
    if (!existing) return;
    if (typeof input.webContentsId === "number" && input.webContentsId !== existing.webContentsId) {
      return;
    }
    existing.url = input.url ?? existing.url;
    existing.title = input.title ?? existing.title;
  }

  getTabs(taskId: string, sessionId?: unknown): BrowserTabInfo[] {
    const session = this.sessions.get(sessionKey(taskId, sessionId));
    if (!session) return [];
    return [
      {
        tabId: session.activeTabId,
        title: session.title || session.url || "Browser",
        url: session.url,
        active: true,
        backend: session.backend,
      },
    ];
  }

  async snapshot(input: {
    taskId: string;
    sessionId?: unknown;
  }): Promise<BrowserSnapshotResult | null> {
    const session = this.sessions.get(sessionKey(input.taskId, input.sessionId));
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);

    const snapshotId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await this.sendCommand(contents, "Accessibility.getFullAXTree").catch(() => ({
      nodes: [],
    }));
    const axNodes = Array.isArray(response?.nodes) ? response.nodes : [];
    const refs = new Map<string, BrowserRefTarget>();
    const nodes: BrowserSnapshotNode[] = [];
    let focusedRef: string | undefined;

    for (const axNode of axNodes) {
      if (nodes.length >= MAX_SNAPSHOT_NODES) break;
      if (!isInterestingAxNode(axNode)) continue;
      const backendNodeId =
        typeof axNode.backendDOMNodeId === "number" ? axNode.backendDOMNodeId : undefined;
      const ref = `b2:${snapshotId}:${nodes.length + 1}`;
      const role = getAxValue(axNode.role) || "generic";
      const node: BrowserSnapshotNode = {
        ref,
        role,
        name: redactBrowserText(getAxValue(axNode.name), 280),
        value: redactBrowserText(getAxValue(axNode.value), 280) || undefined,
        text: redactBrowserText(getAxValue(axNode.description), 280) || undefined,
        bounds: backendNodeId
          ? await this.getBounds(contents, backendNodeId).catch(() => undefined)
          : undefined,
        disabled: getAxProperty(axNode, "disabled") === true || undefined,
        focused: getAxProperty(axNode, "focused") === true || undefined,
        selected: getAxProperty(axNode, "selected") === true || undefined,
      };
      if (node.focused) focusedRef = ref;
      nodes.push(node);
      refs.set(ref, { snapshotId, backendNodeId, node });
    }

    session.latestSnapshotId = snapshotId;
    session.refs = refs;
    session.url = contents.getURL?.() || session.url;
    session.title = contents.getTitle?.() || session.title;

    return {
      success: true,
      sessionId: session.sessionId,
      tabId: session.activeTabId,
      url: session.url,
      title: session.title,
      nodes,
      focusedRef,
      consoleSummary: this.summarize(session.consoleEntries.map((entry) => entry.text)),
      networkSummary: this.summarize(
        session.networkEntries.map((entry) => {
          const status = typeof entry.status === "number" ? `${entry.status} ` : "";
          return `${status}${entry.method || ""} ${entry.url}`.trim();
        }),
      ),
    };
  }

  async clickRef(input: { taskId: string; sessionId?: unknown; ref: string }): Promise<Any | null> {
    const { session, contents, target } = await this.resolveFreshRef(input);
    if (!session || !contents || !target) return null;
    const point = await this.getTargetCenter(contents, target);
    await this.ensureDebugger(session, contents);
    await this.sendCommand(contents, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    await this.sendCommand(contents, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await this.sendCommand(contents, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    return { success: true, ref: input.ref, url: contents.getURL?.() || session.url };
  }

  async hoverRef(input: { taskId: string; sessionId?: unknown; ref: string }): Promise<Any | null> {
    const { session, contents, target } = await this.resolveFreshRef(input);
    if (!session || !contents || !target) return null;
    const point = await this.getTargetCenter(contents, target);
    await this.ensureDebugger(session, contents);
    await this.sendCommand(contents, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    return { success: true, ref: input.ref, url: contents.getURL?.() || session.url };
  }

  async dragRef(input: {
    taskId: string;
    sessionId?: unknown;
    fromRef: string;
    toRef: string;
  }): Promise<Any | null> {
    const from = await this.resolveFreshRef({
      taskId: input.taskId,
      sessionId: input.sessionId,
      ref: input.fromRef,
    });
    const to = await this.resolveFreshRef({
      taskId: input.taskId,
      sessionId: input.sessionId,
      ref: input.toRef,
    });
    if (!from.session || !from.contents || !from.target || !to.target) return null;
    const start = await this.getTargetCenter(from.contents, from.target);
    const end = await this.getTargetCenter(from.contents, to.target);
    await this.ensureDebugger(from.session, from.contents);
    await this.sendCommand(from.contents, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x,
      y: start.y,
    });
    await this.sendCommand(from.contents, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: start.x,
      y: start.y,
      button: "left",
      clickCount: 1,
    });
    await this.sendCommand(from.contents, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: end.x,
      y: end.y,
      button: "left",
    });
    await this.sendCommand(from.contents, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: end.x,
      y: end.y,
      button: "left",
      clickCount: 1,
    });
    return { success: true, fromRef: input.fromRef, toRef: input.toRef };
  }

  async fillRef(input: {
    taskId: string;
    sessionId?: unknown;
    ref: string;
    value: string;
  }): Promise<Any | null> {
    const { session, contents, target } = await this.resolveFreshRef(input);
    if (!session || !contents || !target) return null;
    await this.focusRefTarget(contents, target, true);
    await this.sendCommand(contents, "Input.insertText", { text: String(input.value ?? "") });
    return {
      success: true,
      ref: input.ref,
      value: input.value,
      url: contents.getURL?.() || session.url,
    };
  }

  async typeRef(input: {
    taskId: string;
    sessionId?: unknown;
    ref: string;
    text: string;
  }): Promise<Any | null> {
    const { session, contents, target } = await this.resolveFreshRef(input);
    if (!session || !contents || !target) return null;
    await this.focusRefTarget(contents, target, false);
    await this.sendCommand(contents, "Input.insertText", { text: String(input.text ?? "") });
    return { success: true, ref: input.ref, url: contents.getURL?.() || session.url };
  }

  async getTextRef(input: {
    taskId: string;
    sessionId?: unknown;
    ref: string;
  }): Promise<Any | null> {
    const { contents, target } = await this.resolveFreshRef(input);
    if (!contents || !target) return null;
    if (!target.backendNodeId) {
      return { success: true, ref: input.ref, text: target.node.name || target.node.value || "" };
    }
    const result = await this.callOnBackendNode(
      contents,
      target.backendNodeId,
      `
      function() {
        return String(this.innerText || this.textContent || this.value || this.getAttribute('aria-label') || '').trim();
      }
    `,
    );
    return {
      success: true,
      ref: input.ref,
      text: redactBrowserText(result?.result?.value || "", 4000),
    };
  }

  async uploadFile(input: {
    taskId: string;
    sessionId?: unknown;
    filePath: string;
    ref?: string;
    selector?: string;
  }): Promise<Any | null> {
    const session = this.sessions.get(sessionKey(input.taskId, input.sessionId));
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);
    const resolvedPath = path.resolve(input.filePath);
    let backendNodeId: number | undefined;
    let nodeId: number | undefined;

    if (input.ref) {
      const target = this.getFreshRefTarget(session, input.ref);
      backendNodeId = target.backendNodeId;
    } else if (input.selector) {
      const node = await this.resolveSelector(contents, input.selector);
      nodeId = node?.nodeId;
      backendNodeId = node?.backendNodeId;
    }

    if (!backendNodeId && !nodeId) {
      return {
        success: false,
        error: "Upload target not found. Provide a fresh snapshot ref or selector.",
      };
    }

    await this.sendCommand(contents, "DOM.setFileInputFiles", {
      files: [resolvedPath],
      ...(typeof backendNodeId === "number" ? { backendNodeId } : { nodeId }),
    });
    return { success: true, filePath: resolvedPath };
  }

  async handleDialog(input: {
    taskId: string;
    sessionId?: unknown;
    accept?: boolean;
    promptText?: string;
  }): Promise<Any | null> {
    const session = this.sessions.get(sessionKey(input.taskId, input.sessionId));
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);
    await this.sendCommand(contents, "Page.handleJavaScriptDialog", {
      accept: input.accept !== false,
      promptText: input.promptText,
    });
    session.lastDialog = undefined;
    return { success: true };
  }

  getConsole(
    taskId: string,
    sessionId?: unknown,
  ): { success: true; entries: BrowserConsoleEntry[] } | null {
    const session = this.sessions.get(sessionKey(taskId, sessionId));
    if (!session) return null;
    return { success: true, entries: session.consoleEntries.slice(-MAX_DIAGNOSTIC_ENTRIES) };
  }

  getNetwork(
    taskId: string,
    sessionId?: unknown,
  ): { success: true; entries: BrowserNetworkEntry[] } | null {
    const session = this.sessions.get(sessionKey(taskId, sessionId));
    if (!session) return null;
    return { success: true, entries: session.networkEntries.slice(-MAX_DIAGNOSTIC_ENTRIES) };
  }

  getDownloads(
    taskId: string,
    sessionId?: unknown,
  ): { success: true; entries: BrowserNetworkEntry[] } | null {
    const session = this.sessions.get(sessionKey(taskId, sessionId));
    if (!session) return null;
    return { success: true, entries: session.downloads.slice(-MAX_DIAGNOSTIC_ENTRIES) };
  }

  async getStorage(taskId: string, sessionId?: unknown): Promise<Any | null> {
    const session = this.sessions.get(sessionKey(taskId, sessionId));
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);
    const result = await this.sendCommand(contents, "Runtime.evaluate", {
      returnByValue: true,
      expression: `
        (() => {
          const copyStorage = (storage) => Object.fromEntries(
            Array.from({ length: storage.length }, (_, index) => {
              const key = storage.key(index);
              return [key, key ? storage.getItem(key) : ""];
            }).filter(([key]) => Boolean(key)).slice(0, 80)
          );
          return {
            localStorage: copyStorage(window.localStorage),
            sessionStorage: copyStorage(window.sessionStorage),
            cookies: document.cookie ? "[redacted: available via site cookie store]" : ""
          };
        })()
      `,
    });
    const storage = result?.result?.value || {};
    return { success: true, storage: redactBrowserStoragePayload(storage) };
  }

  async emulate(input: {
    taskId: string;
    sessionId?: unknown;
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
  }): Promise<Any | null> {
    const session = this.sessions.get(sessionKey(input.taskId, input.sessionId));
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);
    const width = Math.max(320, Math.round(input.width || 1280));
    const height = Math.max(320, Math.round(input.height || 720));
    const deviceScaleFactor = Math.max(1, input.deviceScaleFactor || 1);
    const mobile = input.mobile === true;
    await this.sendCommand(contents, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
    return { success: true, width, height, deviceScaleFactor, mobile };
  }

  async traceStart(taskId: string, sessionId?: unknown): Promise<Any | null> {
    const session = this.sessions.get(sessionKey(taskId, sessionId));
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);
    await this.sendCommand(contents, "Tracing.start", {
      categories: "devtools.timeline,disabled-by-default-devtools.timeline",
      transferMode: "ReportEvents",
    });
    session.traceActive = true;
    return { success: true };
  }

  async traceStop(taskId: string, sessionId?: unknown): Promise<Any | null> {
    const session = this.sessions.get(sessionKey(taskId, sessionId));
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);
    await this.sendCommand(contents, "Tracing.end");
    session.traceActive = false;
    return {
      success: true,
      message:
        "Trace stopped. Recent trace events were consumed by the browser diagnostics stream.",
    };
  }

  private async resolveFreshRef(input: {
    taskId: string;
    sessionId?: unknown;
    ref: string;
  }): Promise<{
    session: BrowserSessionRecord | null;
    contents: Any | null;
    target: BrowserRefTarget | null;
  }> {
    const session = this.sessions.get(sessionKey(input.taskId, input.sessionId)) || null;
    const contents = await this.getWebContents(session);
    if (!session || !contents) return { session, contents, target: null };
    return { session, contents, target: this.getFreshRefTarget(session, input.ref) };
  }

  private getFreshRefTarget(session: BrowserSessionRecord, ref: string): BrowserRefTarget {
    const target = session.refs.get(String(ref || ""));
    if (!target) {
      throw new Error("Unknown browser ref. Call browser_snapshot and retry with a current ref.");
    }
    if (!session.latestSnapshotId || target.snapshotId !== session.latestSnapshotId) {
      throw new Error("Stale browser ref. Call browser_snapshot and retry with a current ref.");
    }
    return target;
  }

  private async getTargetCenter(
    contents: Any,
    target: BrowserRefTarget,
  ): Promise<{ x: number; y: number }> {
    const bounds = target.backendNodeId
      ? await this.getBounds(contents, target.backendNodeId).catch(() => target.node.bounds)
      : target.node.bounds;
    if (!bounds) {
      throw new Error(
        "Browser ref has no visible bounds. Call browser_snapshot after scrolling it into view.",
      );
    }
    return {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + Math.min(bounds.height / 2, 24)),
    };
  }

  private async focusRefTarget(
    contents: Any,
    target: BrowserRefTarget,
    clear: boolean,
  ): Promise<void> {
    if (!target.backendNodeId) throw new Error("Browser ref cannot be focused.");
    await this.callOnBackendNode(
      contents,
      target.backendNodeId,
      `
      function(clear) {
        this.focus();
        if (clear && 'value' in this) {
          this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (clear && typeof this.select === 'function') this.select();
        return true;
      }
    `,
      [{ value: clear }],
    );
  }

  private async callOnBackendNode(
    contents: Any,
    backendNodeId: number,
    functionDeclaration: string,
    args: Array<Record<string, unknown>> = [],
  ): Promise<Any> {
    const resolved = await this.sendCommand(contents, "DOM.resolveNode", { backendNodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) throw new Error("Could not resolve browser ref.");
    return await this.sendCommand(contents, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args,
      returnByValue: true,
      awaitPromise: true,
    });
  }

  private async resolveSelector(
    contents: Any,
    selector: string,
  ): Promise<{ nodeId?: number; backendNodeId?: number } | null> {
    await this.ensureDebuggerForContents(contents);
    const document = await this.sendCommand(contents, "DOM.getDocument", {
      depth: 1,
      pierce: true,
    });
    const rootNodeId = document?.root?.nodeId;
    if (!rootNodeId) return null;
    const queried = await this.sendCommand(contents, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector,
    });
    const nodeId =
      typeof queried?.nodeId === "number" && queried.nodeId > 0 ? queried.nodeId : undefined;
    if (!nodeId) return null;
    const described = await this.sendCommand(contents, "DOM.describeNode", { nodeId });
    return {
      nodeId,
      backendNodeId: described?.node?.backendNodeId,
    };
  }

  private async getBounds(
    contents: Any,
    backendNodeId: number,
  ): Promise<BrowserBounds | undefined> {
    await this.ensureDebuggerForContents(contents);
    const model = await this.sendCommand(contents, "DOM.getBoxModel", { backendNodeId });
    return boundsFromBoxModel(model);
  }

  private summarize(values: string[]): BrowserDiagnosticSummary {
    const recent = values.slice(-5).map((value) => redactBrowserText(value, 220));
    return { count: values.length, recent };
  }

  private async ensureDebugger(session: BrowserSessionRecord, contents: Any): Promise<void> {
    await this.ensureDebuggerForContents(contents);
    const webContentsId = session.webContentsId;
    if (!this.debuggerHandlers.has(webContentsId)) {
      const handler = (_event: Any, method: string, params: Any) => {
        this.recordDebuggerEvent(webContentsId, method, params);
      };
      contents.debugger.on("message", handler);
      this.debuggerHandlers.set(webContentsId, handler);
    }
    await this.sendCommand(contents, "Runtime.enable").catch(() => undefined);
    await this.sendCommand(contents, "Log.enable").catch(() => undefined);
    await this.sendCommand(contents, "Network.enable").catch(() => undefined);
    await this.sendCommand(contents, "Page.enable").catch(() => undefined);
  }

  private async ensureDebuggerForContents(contents: Any): Promise<void> {
    const debug = contents?.debugger;
    if (!debug) throw new Error("Browser debugger is not available for this session.");
    if (!debug.isAttached()) {
      debug.attach("1.3");
    }
  }

  private async sendCommand(
    contents: Any,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Any> {
    return await contents.debugger.sendCommand(method, params || {});
  }

  private recordDebuggerEvent(webContentsId: number, method: string, params: Any): void {
    const session = this.findSessionByWebContentsId(webContentsId);
    if (!session) return;
    if (method === "Runtime.consoleAPICalled") {
      const text = Array.isArray(params?.args)
        ? params.args.map((arg: Any) => arg?.value ?? arg?.description ?? "").join(" ")
        : "";
      this.pushConsole(session, {
        level: String(params?.type || "log"),
        text: redactBrowserText(text, 1200),
        timestamp: Date.now(),
      });
    } else if (method === "Log.entryAdded") {
      this.pushConsole(session, {
        level: String(params?.entry?.level || "log"),
        text: redactBrowserText(params?.entry?.text || "", 1200),
        source: params?.entry?.source,
        timestamp: Date.now(),
      });
    } else if (method === "Network.requestWillBeSent") {
      this.pushNetwork(session, {
        method: params?.request?.method,
        url: redactBrowserText(params?.request?.url || "", 1200),
        resourceType: params?.type,
        timestamp: Date.now(),
      });
    } else if (method === "Network.responseReceived") {
      this.pushNetwork(session, {
        url: redactBrowserText(params?.response?.url || "", 1200),
        status: params?.response?.status,
        resourceType: params?.type,
        timestamp: Date.now(),
      });
    } else if (method === "Network.loadingFailed") {
      this.pushNetwork(session, {
        url: redactBrowserText(params?.requestId || "", 300),
        failed: true,
        errorText: redactBrowserText(params?.errorText || "", 600),
        timestamp: Date.now(),
      });
    } else if (method === "Page.javascriptDialogOpening") {
      session.lastDialog = {
        type: params?.type,
        message: redactBrowserText(params?.message || "", 1200),
        defaultPrompt: redactBrowserText(params?.defaultPrompt || "", 1200),
        timestamp: Date.now(),
      };
    } else if (method === "Page.downloadWillBegin" || method === "Browser.downloadWillBegin") {
      const entry = {
        url: redactBrowserText(params?.url || "", 1200),
        resourceType: "download",
        timestamp: Date.now(),
      };
      session.downloads.push(entry);
      session.downloads = session.downloads.slice(-MAX_DIAGNOSTIC_ENTRIES);
    }
  }

  private pushConsole(session: BrowserSessionRecord, entry: BrowserConsoleEntry): void {
    session.consoleEntries.push(entry);
    session.consoleEntries = session.consoleEntries.slice(-MAX_DIAGNOSTIC_ENTRIES);
  }

  private pushNetwork(session: BrowserSessionRecord, entry: BrowserNetworkEntry): void {
    session.networkEntries.push(entry);
    session.networkEntries = session.networkEntries.slice(-MAX_DIAGNOSTIC_ENTRIES);
  }

  private findSessionByWebContentsId(webContentsId: number): BrowserSessionRecord | null {
    for (const session of this.sessions.values()) {
      if (session.webContentsId === webContentsId) return session;
    }
    return null;
  }

  private async getWebContents(
    session: BrowserSessionRecord | null | undefined,
  ): Promise<Any | null> {
    if (!session) return null;
    const electron = await import("electron");
    const contents = (electron as Any).webContents?.fromId?.(session.webContentsId);
    if (!contents || contents.isDestroyed?.()) {
      this.unregisterSession(session);
      return null;
    }
    this.attachAccessGuards(session, contents);
    this.assertCurrentUrlAllowed(session, contents.getURL?.() || session.url || "");
    return contents;
  }

  private getAccessPolicy(session: BrowserSessionRecord): BrowserSessionAccessPolicy | undefined {
    return this.accessPolicies.get(sessionKey(session.taskId, session.sessionId));
  }

  private isUrlAllowed(session: BrowserSessionRecord, rawUrl: string): boolean {
    return this.isUrlAllowedWithPolicy(this.getAccessPolicy(session), rawUrl);
  }

  private isUrlAllowedWithPolicy(
    policy: BrowserSessionAccessPolicy | undefined,
    rawUrl: string,
  ): boolean {
    const url = String(rawUrl || "").trim();
    if (!url || url === "about:blank") return true;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    if (parsed.protocol === "file:" || isLoopbackHttpUrl(url)) {
      return this.isAllowedLocalPreviewUrl(url);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

    if (!policy) return true;
    return (
      evaluateNetworkPolicy({
        url,
        toolName: "browser_workbench_request",
        networkEnabled: policy.networkEnabled,
        accessNetworkMode: policy.accessNetworkMode,
        profileDomainRules: policy.profileDomainRules,
      }).action === "allow"
    );
  }

  private assertCurrentUrlAllowed(session: BrowserSessionRecord, url: string): void {
    if (!this.isUrlAllowed(session, url)) {
      throw new Error(`Browser access denied for "${url}" by the active access profile.`);
    }
  }

  private attachAccessGuards(session: BrowserSessionRecord, contents: Any): void {
    const webContentsId = contents.id;
    if (typeof webContentsId !== "number") return;

    if (!this.accessGuardHandlers.has(webContentsId)) {
      const willNavigate = (event: Any, url: string) => {
        const currentSession = this.findSessionByWebContentsId(webContentsId);
        if (currentSession && !this.isUrlAllowed(currentSession, url)) {
          event.preventDefault?.();
        }
      };
      const willRedirect = (event: Any, url: string) => {
        const currentSession = this.findSessionByWebContentsId(webContentsId);
        if (currentSession && !this.isUrlAllowed(currentSession, url)) {
          event.preventDefault?.();
        }
      };
      contents.on?.("will-navigate", willNavigate);
      contents.on?.("will-redirect", willRedirect);
      this.accessGuardHandlers.set(webContentsId, { contents, willNavigate, willRedirect });
    }

    const webRequest = contents.session?.webRequest;
    if (!webRequest || typeof webRequest.onBeforeRequest !== "function") return;
    if (this.guardedWebRequestSessions.has(webRequest as object)) return;
    this.guardedWebRequestSessions.add(webRequest as object);
    webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (details: Any, callback: (response: { cancel?: boolean }) => void) => {
        const matchingSession = Array.from(this.sessions.values()).find(
          (candidate) => candidate.webContentsId === details.webContentsId,
        );
        if (!matchingSession || this.isUrlAllowed(matchingSession, details.url)) {
          callback({});
          return;
        }
        callback({ cancel: true });
      },
    );
  }
}

const browserSessionManager = new BrowserSessionManager();

export function getBrowserSessionManager(): BrowserSessionManager {
  return browserSessionManager;
}
