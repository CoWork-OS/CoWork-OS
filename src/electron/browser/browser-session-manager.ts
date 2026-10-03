import * as path from "path";
import type { AccessDomainRule } from "../../shared/access-profiles";
import { evaluateNetworkPolicy } from "../security/network-policy";
import {
  buildSelectorResolverExpression,
  DESCRIBE_NODE_FUNCTION,
  FOCUS_FUNCTION,
  HIT_TARGET_CHECK_FUNCTION,
  INSTALL_EVENT_PROBE_FUNCTION,
  PREPARE_FILL_FUNCTION,
  READ_EVENT_PROBE_FUNCTION,
  READ_FIELD_FUNCTION,
  SET_FIELD_VALUE_FUNCTION,
  ACTIVE_ELEMENT_EXPRESSION,
} from "./browser-page-scripts";
import {
  type KeyDefinition,
  MODIFIER_BITS,
  NAMED_KEYS,
  parseKeyCombo,
  resolveKeyDefinition,
} from "./browser-keyboard";
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
  /** True when the node's box lies outside the viewport at snapshot time. */
  offscreen?: boolean;
}

export interface BrowserSnapshotOptions {
  /** Skip this many nodes of the ranked node list (pass nextOffset to page). */
  offset?: number;
  /** Maximum nodes to return (default 140, max 400). */
  limit?: number;
  /** Only return interactive nodes (buttons, links, fields, ...). */
  interactiveOnly?: boolean;
  /** Only return nodes whose name or value contains this text (case-insensitive). */
  query?: string;
}

export interface BrowserSnapshotResult {
  success: true;
  sessionId: string;
  tabId: string;
  url: string;
  title: string;
  nodes: BrowserSnapshotNode[];
  focusedRef?: string;
  /** Nodes matching the filters before paging. */
  totalNodes: number;
  returnedNodes: number;
  offset: number;
  /** True when nodes were left out; page with nextOffset or narrow with filters. */
  truncated: boolean;
  nextOffset?: number;
  /** Static text nodes dropped because an ancestor's name already contains them. */
  omittedDuplicateText?: number;
  hint?: string;
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
  /** URL (without fragment) of the document the current refs belong to. */
  snapshotUrl?: string;
  /** Why the refs were dropped (navigation), reported to callers using old refs. */
  refsInvalidatedReason?: string;
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

const DEFAULT_SNAPSHOT_LIMIT = 140;
const MAX_SNAPSHOT_LIMIT = 400;
/** Remote objects created while acting on the page; released after each action. */
const ACTION_OBJECT_GROUP = "cowork-browser-action";
/** Above this length browser_type inserts text in one step instead of per key. */
const MAX_PER_KEY_TYPE_LENGTH = 500;
const NODE_GONE_ERROR_PATTERN =
  /detached from document|no node with given id|could not find node with given id|does not belong to the document|node with given id not found|no node found for given backend id/i;
const CONTEXT_GONE_ERROR_PATTERN =
  /cannot find context with specified id|execution context was destroyed|inspected target navigated or closed|target closed/i;
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

const INTERACTIVE_AX_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);
const TEXT_AX_ROLES = new Set(["statictext", "text"]);
const DOCUMENT_AX_ROLES = new Set(["rootwebarea", "webarea"]);

function isInterestingAxNode(node: Any): boolean {
  if (!node || node.ignored === true) return false;
  const role = getAxValue(node.role).toLowerCase();
  const name = getAxValue(node.name).trim();
  const value = getAxValue(node.value).trim();
  // Inline text boxes are layout fragments of a StaticText node.
  if (role === "inlinetextbox") return false;
  if (INTERACTIVE_AX_ROLES.has(role)) return true;
  if (role === "image" && name) return true;
  if ((role === "heading" || TEXT_AX_ROLES.has(role)) && name) return true;
  return Boolean(name || value);
}

function normalizeAxText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Landmarks whose links are site chrome (menus, footers) rather than page content. */
const CHROME_LANDMARK_AX_ROLES = new Set(["navigation", "banner", "contentinfo"]);

/**
 * Snapshot ordering tier; lower tiers survive truncation first. Controls
 * (buttons, fields, ...) come first, then headings and content links, then
 * links in navigation/header/footer landmarks, then text.
 */
function snapshotTier(role: string, inChromeLandmark: boolean): number {
  if (role === "link") return inChromeLandmark ? 2 : 1;
  if (INTERACTIVE_AX_ROLES.has(role)) return 0;
  if (role === "heading") return 1;
  return 3;
}

function snapshotIdFromRef(ref: string): string {
  const match = /^b2:(snap-[^:]+):\d+$/.exec(ref);
  return match ? match[1] : "";
}

function urlWithoutFragment(rawUrl: string): string {
  const value = String(rawUrl || "");
  const hashIndex = value.indexOf("#");
  return hashIndex === -1 ? value : value.slice(0, hashIndex);
}

function quadBounds(quad: unknown): BrowserBounds | undefined {
  if (!Array.isArray(quad) || quad.length < 8) return undefined;
  const xs = [quad[0], quad[2], quad[4], quad[6]].filter((value) => Number.isFinite(value));
  const ys = [quad[1], quad[3], quad[5], quad[7]].filter((value) => Number.isFinite(value));
  if (xs.length < 4 || ys.length < 4) return undefined;
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/**
 * Bounds in viewport coordinates. Not clamped: a negative y means the node is
 * above the viewport, which callers need to know rather than a fake 0.
 */
function boundsFromBoxModel(model: Any): BrowserBounds | undefined {
  const bounds = quadBounds(model?.model?.border || model?.model?.content);
  if (!bounds) return undefined;
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

/** Error for an action that could not be performed or verified; reported as success:false. */
class BrowserActionError extends Error {}

interface ViewportSize {
  width: number;
  height: number;
  /** Scroll offset of the layout viewport in document coordinates. */
  pageX: number;
  pageY: number;
}

interface ActionPoint {
  /** Viewport coordinates, as used by Input.dispatchMouseEvent. */
  x: number;
  y: number;
  /** Document scroll offset, needed by DOM.getNodeForLocation. */
  pageX: number;
  pageY: number;
}

function looselyEqual(actual: string, expected: string): boolean {
  const strip = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  return strip(actual) === strip(expected);
}

function looselyContains(actual: string, expected: string): boolean {
  const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
  const strip = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  return collapse(actual).includes(collapse(expected)) || strip(actual).includes(strip(expected));
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
    // Refs hold backend node ids of one renderer; a new webContents invalidates them.
    const sameContents = existing?.webContentsId === registration.webContentsId;
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
      snapshotUrl: sameContents ? existing?.snapshotUrl : undefined,
      refsInvalidatedReason:
        existing && !sameContents && existing.refs.size > 0
          ? "the browser view was reloaded"
          : existing?.refsInvalidatedReason,
      refs: sameContents && existing ? existing.refs : new Map(),
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
    if (
      typeof input.url === "string" &&
      existing.snapshotUrl &&
      urlWithoutFragment(input.url) !== existing.snapshotUrl
    ) {
      this.invalidateRefs(existing, `the page navigated to ${redactBrowserText(input.url, 200)}`);
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

  async snapshot(
    input: {
      taskId: string;
      sessionId?: unknown;
    } & BrowserSnapshotOptions,
  ): Promise<BrowserSnapshotResult | null> {
    const session = this.sessions.get(sessionKey(input.taskId, input.sessionId));
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);

    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const limit = Math.min(
      MAX_SNAPSHOT_LIMIT,
      Math.max(1, Math.floor(Number(input.limit) || DEFAULT_SNAPSHOT_LIMIT)),
    );
    const query = typeof input.query === "string" ? normalizeAxText(input.query) : "";
    const interactiveOnly = input.interactiveOnly === true;

    const snapshotId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await this.sendCommand(contents, "Accessibility.getFullAXTree").catch(() => ({
      nodes: [],
    }));
    const axNodes: Any[] = Array.isArray(response?.nodes) ? response.nodes : [];
    const byId = new Map<string, Any>();
    const parentOf = new Map<string, string>();
    for (const axNode of axNodes) {
      if (axNode?.nodeId === undefined) continue;
      const id = String(axNode.nodeId);
      byId.set(id, axNode);
      if (axNode.parentId !== undefined) parentOf.set(id, String(axNode.parentId));
      for (const childId of Array.isArray(axNode.childIds) ? axNode.childIds : []) {
        if (!parentOf.has(String(childId))) parentOf.set(String(childId), id);
      }
    }
    const inChromeLandmark = (axNode: Any): boolean => {
      let parentId = parentOf.get(String(axNode.nodeId));
      for (let depth = 0; parentId && depth < 40; depth += 1) {
        const parent = byId.get(parentId);
        if (!parent) break;
        if (CHROME_LANDMARK_AX_ROLES.has(getAxValue(parent.role).toLowerCase())) return true;
        parentId = parentOf.get(parentId);
      }
      return false;
    };
    // A StaticText child repeats the name of the button/link/heading around it.
    const repeatsAncestorName = (axNode: Any, text: string): boolean => {
      let parentId = parentOf.get(String(axNode.nodeId));
      for (let depth = 0; parentId && depth < 8; depth += 1) {
        const parent = byId.get(parentId);
        if (!parent) break;
        const parentRole = getAxValue(parent.role).toLowerCase();
        if (DOCUMENT_AX_ROLES.has(parentRole)) break;
        if (parent.ignored !== true && normalizeAxText(getAxValue(parent.name)).includes(text)) {
          return true;
        }
        parentId = parentOf.get(parentId);
      }
      return false;
    };

    const candidates: Array<{ axNode: Any; role: string; tier: number; index: number }> = [];
    let omittedDuplicateText = 0;
    for (const axNode of axNodes) {
      if (!isInterestingAxNode(axNode)) continue;
      const role = getAxValue(axNode.role) || "generic";
      const roleKey = role.toLowerCase();
      // The document node's name is the page title, already returned as `title`.
      if (DOCUMENT_AX_ROLES.has(roleKey)) continue;
      const name = normalizeAxText(getAxValue(axNode.name));
      if (TEXT_AX_ROLES.has(roleKey) && name && repeatsAncestorName(axNode, name)) {
        omittedDuplicateText += 1;
        continue;
      }
      if (interactiveOnly && !INTERACTIVE_AX_ROLES.has(roleKey)) continue;
      const tier = snapshotTier(roleKey, roleKey === "link" && inChromeLandmark(axNode));
      if (query) {
        const value = normalizeAxText(getAxValue(axNode.value));
        if (!name.includes(query) && !value.includes(query)) continue;
      }
      candidates.push({ axNode, role, tier, index: candidates.length });
    }

    // Lower tiers first; document order within a tier and within the returned page.
    const ranked = [...candidates].sort((a, b) => a.tier - b.tier || a.index - b.index);
    const page = ranked.slice(offset, offset + limit).sort((a, b) => a.index - b.index);
    const viewport = page.length > 0 ? await this.getViewport(contents) : null;

    // Paging or filtering continues the current snapshot: earlier refs stay valid.
    const continuation =
      (offset > 0 || interactiveOnly || Boolean(query)) &&
      session.refs.size > 0 &&
      !session.refsInvalidatedReason &&
      session.snapshotUrl === urlWithoutFragment(contents.getURL?.() || session.url);
    const refs = continuation ? new Map(session.refs) : new Map<string, BrowserRefTarget>();
    const nodes: BrowserSnapshotNode[] = [];
    let focusedRef: string | undefined;

    for (const entry of page) {
      const { axNode, role } = entry;
      const backendNodeId =
        typeof axNode.backendDOMNodeId === "number" ? axNode.backendDOMNodeId : undefined;
      const ref = `b2:${snapshotId}:${entry.index + 1}`;
      const bounds = backendNodeId
        ? await this.getBounds(contents, backendNodeId).catch(() => undefined)
        : undefined;
      const offscreen =
        bounds && viewport
          ? bounds.x + bounds.width <= 0 ||
            bounds.y + bounds.height <= 0 ||
            bounds.x >= viewport.width ||
            bounds.y >= viewport.height ||
            undefined
          : undefined;
      const node: BrowserSnapshotNode = {
        ref,
        role,
        name: redactBrowserText(getAxValue(axNode.name), 280),
        value: redactBrowserText(getAxValue(axNode.value), 280) || undefined,
        text: redactBrowserText(getAxValue(axNode.description), 280) || undefined,
        bounds,
        offscreen,
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
    session.refsInvalidatedReason = undefined;
    session.url = contents.getURL?.() || session.url;
    session.title = contents.getTitle?.() || session.title;
    session.snapshotUrl = urlWithoutFragment(session.url);

    const total = candidates.length;
    const nextOffset = offset + page.length < total ? offset + page.length : undefined;
    const truncated = page.length < total;
    return {
      success: true,
      sessionId: session.sessionId,
      tabId: session.activeTabId,
      url: session.url,
      title: session.title,
      nodes,
      focusedRef,
      totalNodes: total,
      returnedNodes: nodes.length,
      offset,
      truncated,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      ...(omittedDuplicateText > 0 ? { omittedDuplicateText } : {}),
      ...(truncated
        ? {
            hint:
              `Showing ${nodes.length} of ${total} nodes (controls first, navigation links and text last). ` +
              (nextOffset !== undefined
                ? `Call browser_snapshot with offset=${nextOffset} for more, `
                : "Call browser_snapshot with a smaller offset for the rest, ") +
              "or narrow it with interactive_only=true or query.",
          }
        : {}),
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
    await this.ensureDebugger(session, contents);
    return await this.runAction(contents, { ref: input.ref }, async () => {
      const backendNodeId = this.requireBackendNode(target);
      const click = await this.clickBackendNode(contents, backendNodeId, input.ref);
      return { ...click, url: contents.getURL?.() || session.url };
    });
  }

  async clickSelector(input: {
    taskId: string;
    sessionId?: unknown;
    selector: string;
  }): Promise<Any | null> {
    const session = this.sessions.get(sessionKey(input.taskId, input.sessionId)) || null;
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);
    return await this.runAction(contents, { selector: input.selector }, async () => {
      const backendNodeId = await this.resolveSelectorNode(contents, input.selector);
      const click = await this.clickBackendNode(contents, backendNodeId);
      return { ...click, element: input.selector, url: contents.getURL?.() || session.url };
    });
  }

  async hoverRef(input: { taskId: string; sessionId?: unknown; ref: string }): Promise<Any | null> {
    const { session, contents, target } = await this.resolveFreshRef(input);
    if (!session || !contents || !target) return null;
    await this.ensureDebugger(session, contents);
    return await this.runAction(contents, { ref: input.ref }, async () => {
      const backendNodeId = this.requireBackendNode(target);
      const point = await this.getActionPoint(contents, backendNodeId, input.ref);
      await this.assertHitTarget(contents, backendNodeId, point);
      await this.sendCommand(contents, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });
      return { success: true, x: point.x, y: point.y, url: contents.getURL?.() || session.url };
    });
  }

  async hoverSelector(input: {
    taskId: string;
    sessionId?: unknown;
    selector: string;
  }): Promise<Any | null> {
    const session = this.sessions.get(sessionKey(input.taskId, input.sessionId)) || null;
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);
    return await this.runAction(contents, { selector: input.selector }, async () => {
      const backendNodeId = await this.resolveSelectorNode(contents, input.selector);
      const point = await this.getActionPoint(contents, backendNodeId);
      await this.assertHitTarget(contents, backendNodeId, point);
      await this.sendCommand(contents, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });
      return { success: true, x: point.x, y: point.y, url: contents.getURL?.() || session.url };
    });
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
    const contents = from.contents;
    const fromTarget = from.target;
    const toTarget = to.target;
    await this.ensureDebugger(from.session, contents);
    return await this.runAction(
      contents,
      { fromRef: input.fromRef, toRef: input.toRef },
      async () => {
        const fromNode = this.requireBackendNode(fromTarget);
        const toNode = this.requireBackendNode(toTarget);
        let start = await this.getActionPoint(contents, fromNode, input.fromRef);
        let end = await this.getActionPoint(contents, toNode, input.toRef, { scroll: false }).catch(
          () => null,
        );
        if (!end) {
          end = await this.getActionPoint(contents, toNode, input.toRef);
          start = await this.getActionPoint(contents, fromNode, input.fromRef, { scroll: false });
        }
        await this.assertHitTarget(contents, fromNode, start);
        await this.sendCommand(contents, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: start.x,
          y: start.y,
        });
        await this.sendCommand(contents, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: start.x,
          y: start.y,
          button: "left",
          clickCount: 1,
        });
        await this.sendCommand(contents, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: end.x,
          y: end.y,
          button: "left",
        });
        await this.sendCommand(contents, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: end.x,
          y: end.y,
          button: "left",
          clickCount: 1,
        });
        return { success: true, fromRef: input.fromRef, toRef: input.toRef };
      },
    );
  }

  async fillRef(input: {
    taskId: string;
    sessionId?: unknown;
    ref: string;
    value: string;
  }): Promise<Any | null> {
    const { session, contents, target } = await this.resolveFreshRef(input);
    if (!session || !contents || !target) return null;
    await this.ensureDebugger(session, contents);
    return await this.runAction(contents, { ref: input.ref }, async () => {
      const backendNodeId = this.requireBackendNode(target);
      const fill = await this.fillBackendNode(contents, backendNodeId, input.value, input.ref);
      return { ...fill, url: contents.getURL?.() || session.url };
    });
  }

  async fillSelector(input: {
    taskId: string;
    sessionId?: unknown;
    selector: string;
    value: string;
  }): Promise<Any | null> {
    const session = this.sessions.get(sessionKey(input.taskId, input.sessionId)) || null;
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);
    return await this.runAction(contents, { selector: input.selector }, async () => {
      const backendNodeId = await this.resolveSelectorNode(contents, input.selector);
      const fill = await this.fillBackendNode(contents, backendNodeId, input.value);
      return { ...fill, url: contents.getURL?.() || session.url };
    });
  }

  async typeRef(input: {
    taskId: string;
    sessionId?: unknown;
    ref: string;
    text: string;
  }): Promise<Any | null> {
    const { session, contents, target } = await this.resolveFreshRef(input);
    if (!session || !contents || !target) return null;
    await this.ensureDebugger(session, contents);
    return await this.runAction(contents, { ref: input.ref }, async () => {
      const backendNodeId = this.requireBackendNode(target);
      const typed = await this.typeIntoBackendNode(contents, backendNodeId, input.text, input.ref);
      return { ...typed, url: contents.getURL?.() || session.url };
    });
  }

  async typeSelector(input: {
    taskId: string;
    sessionId?: unknown;
    selector: string;
    text: string;
  }): Promise<Any | null> {
    const session = this.sessions.get(sessionKey(input.taskId, input.sessionId)) || null;
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);
    return await this.runAction(contents, { selector: input.selector }, async () => {
      const backendNodeId = await this.resolveSelectorNode(contents, input.selector);
      const typed = await this.typeIntoBackendNode(contents, backendNodeId, input.text);
      return { ...typed, url: contents.getURL?.() || session.url };
    });
  }

  /**
   * Press a key or combo ("Enter", "Shift+Tab", "Control+a") on the focused
   * element through CDP key events carrying key, code, keyCode and text, so
   * default actions run (Enter submits a form, Tab moves focus).
   */
  async pressKey(input: { taskId: string; sessionId?: unknown; key: string }): Promise<Any | null> {
    const session = this.sessions.get(sessionKey(input.taskId, input.sessionId)) || null;
    const contents = await this.getWebContents(session);
    if (!session || !contents) return null;
    await this.ensureDebugger(session, contents);
    const combo = parseKeyCombo(String(input.key ?? ""));
    if (!combo) {
      return {
        success: false,
        key: input.key,
        error:
          `Unsupported key "${String(input.key ?? "")}". Use a key name such as Enter, Tab, ` +
          "Escape, Backspace, ArrowDown, a single character, or a combo like Shift+Tab.",
      };
    }
    await this.dispatchKeyCombo(contents, combo);
    const focused = await this.sendCommand(contents, "Runtime.evaluate", {
      expression: ACTIVE_ELEMENT_EXPRESSION,
      returnByValue: true,
    }).catch(() => null);
    const activeElement = focused?.result?.value;
    return {
      success: true,
      key: input.key,
      url: contents.getURL?.() || session.url,
      ...(typeof activeElement === "string" && activeElement ? { focused: activeElement } : {}),
    };
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
    ).finally(() =>
      this.sendCommand(contents, "Runtime.releaseObjectGroup", {
        objectGroup: ACTION_OBJECT_GROUP,
      }).catch(() => undefined),
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
    const currentUrl = urlWithoutFragment(contents.getURL?.() || "");
    if (session.snapshotUrl && currentUrl && currentUrl !== session.snapshotUrl) {
      this.invalidateRefs(session, `the page navigated to ${redactBrowserText(currentUrl, 200)}`);
    }
    return { session, contents, target: this.getFreshRefTarget(session, input.ref) };
  }

  /** Drop all refs because the document they point into is gone. */
  private invalidateRefs(session: BrowserSessionRecord, reason: string): void {
    if (session.refs.size === 0 && session.refsInvalidatedReason) return;
    session.refs = new Map();
    session.refsInvalidatedReason = reason;
  }

  private getFreshRefTarget(session: BrowserSessionRecord, ref: string): BrowserRefTarget {
    const key = String(ref || "");
    const target = session.refs.get(key);
    if (target) return target;
    if (session.refsInvalidatedReason) {
      throw new Error(
        `Stale browser ref: ${session.refsInvalidatedReason} after the last browser_snapshot. ` +
          "Call browser_snapshot and retry with a current ref.",
      );
    }
    const refSnapshotId = snapshotIdFromRef(key);
    if (refSnapshotId && refSnapshotId !== session.latestSnapshotId) {
      throw new Error("Stale browser ref. Call browser_snapshot and retry with a current ref.");
    }
    throw new Error("Unknown browser ref. Call browser_snapshot and retry with a current ref.");
  }

  private requireBackendNode(target: BrowserRefTarget): number {
    if (typeof target.backendNodeId !== "number") {
      throw new BrowserActionError(
        "This ref has no DOM element to act on. Take a new browser_snapshot and pick a button, link or field ref.",
      );
    }
    return target.backendNodeId;
  }

  /**
   * Run one page action. Verification failures become `success: false` with
   * the reason; stale refs and protocol failures still throw.
   */
  private async runAction(
    contents: Any,
    context: Record<string, unknown>,
    action: () => Promise<Any>,
  ): Promise<Any> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof BrowserActionError) {
        return { success: false, ...context, error: error.message };
      }
      throw error;
    } finally {
      await this.sendCommand(contents, "Runtime.releaseObjectGroup", {
        objectGroup: ACTION_OBJECT_GROUP,
      }).catch(() => undefined);
    }
  }

  private nodeGoneError(ref?: string): Error {
    if (ref) {
      return new Error(
        `Stale browser ref ${ref}: its element is no longer in the page. ` +
          "Call browser_snapshot and retry with a current ref.",
      );
    }
    return new BrowserActionError(
      "The matched element was removed from the page during the action. Retry, or take a browser_snapshot.",
    );
  }

  /** Resolve a selector in the page (CSS, text=, :has-text(), role=, xpath=) to a DOM node. */
  private async resolveSelectorNode(contents: Any, selector: string): Promise<number> {
    const evaluated = await this.sendCommand(contents, "Runtime.evaluate", {
      expression: buildSelectorResolverExpression(selector),
      returnByValue: false,
      objectGroup: ACTION_OBJECT_GROUP,
    });
    if (evaluated?.exceptionDetails) {
      const details = evaluated.exceptionDetails;
      throw new BrowserActionError(
        `Could not evaluate selector ${JSON.stringify(selector)}: ${
          details.exception?.description || details.text || "page error"
        }`,
      );
    }
    const remote = evaluated?.result;
    if (remote?.type === "string") {
      const message = String(remote.value || "");
      if (message.startsWith("invalid:")) {
        throw new BrowserActionError(
          `Invalid selector ${JSON.stringify(selector)}: ${message.slice("invalid:".length)}. ` +
            'Use CSS (optionally with :has-text("...")), text=..., role=button[name="..."], ' +
            "xpath=..., or a ref from browser_snapshot.",
        );
      }
      throw new BrowserActionError(
        `No element matches selector ${JSON.stringify(selector)}. ` +
          "Take a browser_snapshot and use a ref, or check the selector.",
      );
    }
    if (remote?.subtype !== "node" || !remote.objectId) {
      throw new BrowserActionError(
        `Selector ${JSON.stringify(selector)} did not resolve to an element.`,
      );
    }
    const described = await this.sendCommand(contents, "DOM.describeNode", {
      objectId: remote.objectId,
    });
    const backendNodeId = described?.node?.backendNodeId;
    if (typeof backendNodeId !== "number") {
      throw new BrowserActionError(
        `Selector ${JSON.stringify(selector)} did not resolve to an element.`,
      );
    }
    return backendNodeId;
  }

  private async describeBackendNode(contents: Any, backendNodeId: number): Promise<string> {
    const described = await this.callOnBackendNode(
      contents,
      backendNodeId,
      DESCRIBE_NODE_FUNCTION,
    ).catch(() => null);
    const value = described?.result?.value;
    return typeof value === "string" && value ? value : "the element";
  }

  private async getViewport(contents: Any): Promise<ViewportSize | null> {
    const metrics = await this.sendCommand(contents, "Page.getLayoutMetrics").catch(() => null);
    const viewport = metrics?.cssLayoutViewport || metrics?.layoutViewport;
    const width = Number(viewport?.clientWidth);
    const height = Number(viewport?.clientHeight);
    if (!(width > 0 && height > 0)) return null;
    return {
      width,
      height,
      pageX: Number(viewport?.pageX) || 0,
      pageY: Number(viewport?.pageY) || 0,
    };
  }

  private async scrollNodeIntoView(
    contents: Any,
    backendNodeId: number,
    ref?: string,
  ): Promise<void> {
    try {
      await this.sendCommand(contents, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } catch (error) {
      if (NODE_GONE_ERROR_PATTERN.test(String((error as Error)?.message || error))) {
        throw this.nodeGoneError(ref);
      }
      // Nodes without a layout box cannot be scrolled; getActionPoint reports that.
    }
  }

  /**
   * Scroll the node into view and return the center of its visible part, in
   * viewport coordinates. Fails instead of guessing when the node is gone
   * (stale ref), has no box, or still lies outside the viewport.
   */
  private async getActionPoint(
    contents: Any,
    backendNodeId: number,
    ref?: string,
    options: { scroll?: boolean } = {},
  ): Promise<ActionPoint> {
    if (options.scroll !== false) await this.scrollNodeIntoView(contents, backendNodeId, ref);
    let quads: unknown[] = [];
    try {
      const result = await this.sendCommand(contents, "DOM.getContentQuads", { backendNodeId });
      quads = Array.isArray(result?.quads) ? result.quads : [];
    } catch (error) {
      if (NODE_GONE_ERROR_PATTERN.test(String((error as Error)?.message || error))) {
        throw this.nodeGoneError(ref);
      }
      quads = [];
    }
    if (quads.length === 0) {
      const label = await this.describeBackendNode(contents, backendNodeId);
      throw new BrowserActionError(
        `${label} is not visible (it has no layout box). It may be hidden or collapsed; ` +
          "open the containing menu or section first, then take a new browser_snapshot.",
      );
    }
    const viewport = await this.getViewport(contents);
    let best: { x: number; y: number; area: number } | null = null;
    let firstBox: BrowserBounds | undefined;
    for (const quad of quads) {
      const box = quadBounds(quad);
      if (!box || box.width < 1 || box.height < 1) continue;
      firstBox = firstBox || box;
      const left = viewport ? Math.max(0, box.x) : box.x;
      const top = viewport ? Math.max(0, box.y) : box.y;
      const right = viewport ? Math.min(viewport.width, box.x + box.width) : box.x + box.width;
      const bottom = viewport ? Math.min(viewport.height, box.y + box.height) : box.y + box.height;
      const area = (right - left) * (bottom - top);
      if (right - left < 1 || bottom - top < 1) continue;
      if (!best || area > best.area) {
        best = { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2), area };
      }
    }
    if (!best) {
      const label = await this.describeBackendNode(contents, backendNodeId);
      const where = firstBox
        ? ` (its box is at x=${Math.round(firstBox.x)}, y=${Math.round(firstBox.y)}` +
          (viewport ? `; viewport is ${viewport.width}x${viewport.height})` : ")")
        : "";
      throw new BrowserActionError(
        `${label} is outside the visible viewport even after scrolling it into view${where}. ` +
          "It may be clipped by a scrolling container or positioned off-screen.",
      );
    }
    return { x: best.x, y: best.y, pageX: viewport?.pageX || 0, pageY: viewport?.pageY || 0 };
  }

  /**
   * Hit-test the point and fail when another element (overlay, sticky header,
   * cookie banner) would receive the input. Returns false when the browser
   * cannot hit-test, true when the target is confirmed.
   */
  private async assertHitTarget(
    contents: Any,
    backendNodeId: number,
    point: ActionPoint,
  ): Promise<boolean> {
    // getNodeForLocation hit-tests in document coordinates, not viewport ones.
    const hit = await this.sendCommand(contents, "DOM.getNodeForLocation", {
      x: Math.round(point.x + point.pageX),
      y: Math.round(point.y + point.pageY),
      includeUserAgentShadowDOM: false,
    }).catch(() => null);
    const hitNodeId = hit?.backendNodeId;
    if (typeof hitNodeId !== "number") return false;
    if (hitNodeId === backendNodeId) return true;
    const hitObject = await this.sendCommand(contents, "DOM.resolveNode", {
      backendNodeId: hitNodeId,
      objectGroup: ACTION_OBJECT_GROUP,
    }).catch(() => null);
    const hitObjectId = hitObject?.object?.objectId;
    if (!hitObjectId) return false;
    const checked = await this.callOnBackendNode(
      contents,
      backendNodeId,
      HIT_TARGET_CHECK_FUNCTION,
      [{ objectId: hitObjectId }],
    ).catch(() => null);
    const verdict = checked?.result?.value;
    if (!verdict || typeof verdict !== "object") return false;
    if (verdict.ok === true) return true;
    throw new BrowserActionError(
      `${verdict.target || "The element"} is covered by ${verdict.hit || "another element"} ` +
        `at (${point.x}, ${point.y}), so the input would land on the covering element. ` +
        "Dismiss the overlay, dialog or banner (or scroll), then take a new browser_snapshot.",
    );
  }

  private async clickBackendNode(
    contents: Any,
    backendNodeId: number,
    ref?: string,
  ): Promise<Record<string, unknown>> {
    const point = await this.getActionPoint(contents, backendNodeId, ref);
    const hitVerified = await this.assertHitTarget(contents, backendNodeId, point);
    const probeInstalled = await this.installEventProbe(contents, backendNodeId, [
      "mousedown",
      "click",
    ]);
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
    let confirmed = "unverified";
    if (probeInstalled) {
      try {
        const probe = (
          await this.callOnBackendNode(contents, backendNodeId, READ_EVENT_PROBE_FUNCTION)
        )?.result?.value;
        if (probe?.seen?.click) confirmed = "click";
        else if (probe?.seen?.mousedown) confirmed = "mousedown";
        else if (probe && probe.connected === false) confirmed = "element-removed";
        else if (probe?.installed) {
          const label = await this.describeBackendNode(contents, backendNodeId);
          throw new BrowserActionError(
            `The click at (${point.x}, ${point.y}) did not reach ${label}: no mousedown or click ` +
              "event arrived (the element may be disabled or the page changed). " +
              "Take a new browser_snapshot before retrying.",
          );
        }
      } catch (error) {
        if (error instanceof BrowserActionError) throw error;
        const message = String((error as Error)?.message || error);
        if (NODE_GONE_ERROR_PATTERN.test(message) || CONTEXT_GONE_ERROR_PATTERN.test(message)) {
          confirmed = "navigated";
        }
      }
    }
    return { success: true, x: point.x, y: point.y, hitVerified, confirmed };
  }

  private async installEventProbe(
    contents: Any,
    backendNodeId: number,
    types: string[],
  ): Promise<boolean> {
    return await this.callOnBackendNode(contents, backendNodeId, INSTALL_EVENT_PROBE_FUNCTION, [
      { value: types },
    ])
      .then((result) => result?.result?.value === true)
      .catch(() => false);
  }

  private async readField(
    contents: Any,
    backendNodeId: number,
    ref?: string,
  ): Promise<{ kind: string; value: string; secret: boolean; connected: boolean }> {
    try {
      const result = await this.callOnBackendNode(contents, backendNodeId, READ_FIELD_FUNCTION);
      const value = result?.result?.value || {};
      return {
        kind: String(value.kind || "none"),
        value: String(value.value ?? ""),
        secret: value.secret === true,
        connected: value.connected !== false,
      };
    } catch (error) {
      if (NODE_GONE_ERROR_PATTERN.test(String((error as Error)?.message || error))) {
        throw this.nodeGoneError(ref);
      }
      throw error;
    }
  }

  private unfillableMessage(prepared: Any): string {
    const target = typeof prepared?.target === "string" ? prepared.target : "The element";
    const kind = String(prepared?.kind || "none");
    if (prepared?.reason === "disabled") return `${target} is disabled and cannot be filled.`;
    if (prepared?.reason === "readonly") return `${target} is read-only and cannot be filled.`;
    if (kind === "select") return `${target} is a <select>; use browser_select instead.`;
    if (kind === "input-checkbox" || kind === "input-radio") {
      return `${target} is a ${kind.slice("input-".length)}; use browser_click instead.`;
    }
    if (kind === "input-file") return `${target} is a file input; use browser_upload_file instead.`;
    return (
      `${target} is not a text field (input, textarea or contenteditable). ` +
      "Take a browser_snapshot and pick a textbox ref."
    );
  }

  /**
   * Replace a field's contents the way a user does: focus, select all, then
   * trusted text insertion, so React/Vue/editor state sees the change. The
   * value is read back and the action fails when it did not take.
   */
  private async fillBackendNode(
    contents: Any,
    backendNodeId: number,
    rawValue: unknown,
    ref?: string,
  ): Promise<Record<string, unknown>> {
    const value = String(rawValue ?? "");
    await this.scrollNodeIntoView(contents, backendNodeId, ref);
    const before = await this.readField(contents, backendNodeId, ref);
    const prepared = (
      await this.callOnBackendNode(contents, backendNodeId, PREPARE_FILL_FUNCTION, [{ value }])
    )?.result?.value;
    if (!prepared?.ok) throw new BrowserActionError(this.unfillableMessage(prepared));
    let method = prepared.kind === "set" ? "set-value" : "insertText";
    let inputSeen = true;
    if (method === "insertText") {
      if (!prepared.focused) {
        throw new BrowserActionError(
          `Could not focus ${prepared.target || "the field"} to fill it; another element keeps focus.`,
        );
      }
      const probed = await this.installEventProbe(contents, backendNodeId, [
        "beforeinput",
        "input",
      ]);
      if (value) {
        await this.sendCommand(contents, "Input.insertText", { text: value });
      } else {
        await this.dispatchKeyCombo(contents, { modifiers: [], key: NAMED_KEYS.Delete });
      }
      if (probed) {
        const probe = (
          await this.callOnBackendNode(contents, backendNodeId, READ_EVENT_PROBE_FUNCTION).catch(
            () => null,
          )
        )?.result?.value;
        inputSeen = Boolean(probe?.seen?.input || probe?.seen?.beforeinput);
      } else {
        inputSeen = false;
      }
    }
    const matches = (field: { kind: string; value: string }) =>
      field.kind === "editable"
        ? field.value.replace(/\s+/g, " ").trim() === value.replace(/\s+/g, " ").trim()
        : field.value === value;
    let after = await this.readField(contents, backendNodeId, ref);
    if (!matches(after) && method === "insertText" && !inputSeen && after.value === before.value) {
      // The trusted insertion never reached the field (no input event, value unchanged):
      // set it through the native setter. When the page did process the insertion
      // (maxlength, masks), the read-back below reports the mismatch instead.
      await this.callOnBackendNode(contents, backendNodeId, SET_FIELD_VALUE_FUNCTION, [{ value }]);
      method = "native-setter";
      after = await this.readField(contents, backendNodeId, ref);
    }
    const reported = after.secret ? undefined : after.value;
    if (matches(after)) return { success: true, value: reported, method };
    if (looselyEqual(after.value, value)) {
      return { success: true, value: reported, method, normalizedByPage: true };
    }
    const label = await this.describeBackendNode(contents, backendNodeId);
    const actual = after.secret
      ? `${after.value.length} characters`
      : JSON.stringify(after.value.slice(0, 200));
    throw new BrowserActionError(
      `Fill did not take: ${label} contains ${actual} instead of the requested value ` +
        `(${value.length} characters). The field may be read-only, limited by maxlength, or ` +
        "re-rendered by the page; take a new browser_snapshot and retry.",
    );
  }

  private async typeIntoBackendNode(
    contents: Any,
    backendNodeId: number,
    rawText: unknown,
    ref?: string,
  ): Promise<Record<string, unknown>> {
    const text = String(rawText ?? "");
    await this.scrollNodeIntoView(contents, backendNodeId, ref);
    const focus = (await this.callOnBackendNode(contents, backendNodeId, FOCUS_FUNCTION))?.result
      ?.value;
    if (!focus?.ok) {
      throw new BrowserActionError(
        `Could not focus ${focus?.target || "the element"} to type into it; another element keeps focus.`,
      );
    }
    const isField = focus.kind === "text" || focus.kind === "editable";
    const before = isField ? await this.readField(contents, backendNodeId, ref) : null;
    await this.typeText(contents, text);
    if (!isField || !before || !text.trim() || /[\r\n]/.test(text)) {
      return { success: true, verified: false };
    }
    const after = await this.readField(contents, backendNodeId, ref).catch(() => null);
    if (!after || !after.connected) return { success: true, verified: false };
    if (looselyContains(after.value, text)) return { success: true, verified: true };
    if (after.value !== before.value) {
      return {
        success: true,
        verified: false,
        note: "The field changed but does not contain the typed text verbatim (the page may reformat input).",
      };
    }
    const label = await this.describeBackendNode(contents, backendNodeId);
    throw new BrowserActionError(
      `Typed text did not appear in ${label}. The field may be read-only or the page may ` +
        "ignore keyboard input; take a new browser_snapshot and retry.",
    );
  }

  private async typeText(contents: Any, text: string): Promise<void> {
    const characters = [...text];
    if (characters.length > MAX_PER_KEY_TYPE_LENGTH) {
      await this.sendCommand(contents, "Input.insertText", { text });
      return;
    }
    for (const character of characters) {
      const definition = resolveKeyDefinition(character);
      if (definition && definition.text !== undefined) {
        await this.dispatchKeyCombo(contents, { modifiers: [], key: definition });
      } else {
        await this.sendCommand(contents, "Input.insertText", { text: character });
      }
    }
  }

  private async dispatchKeyCombo(
    contents: Any,
    combo: { modifiers: KeyDefinition[]; key: KeyDefinition },
  ): Promise<void> {
    let modifiers = 0;
    for (const modifier of combo.modifiers) {
      modifiers |= MODIFIER_BITS[modifier.key] || 0;
      await this.sendKeyEvent(contents, "rawKeyDown", modifier, modifiers);
    }
    const onlyShift = (modifiers & ~MODIFIER_BITS.Shift) === 0;
    let text = onlyShift ? combo.key.text : undefined;
    if (text && modifiers & MODIFIER_BITS.Shift && /^[a-z]$/.test(text)) text = text.toUpperCase();
    const commands =
      modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta) &&
      combo.key.key.toLowerCase() === "a"
        ? ["selectAll"]
        : undefined;
    await this.sendKeyEvent(
      contents,
      text ? "keyDown" : "rawKeyDown",
      combo.key,
      modifiers,
      text,
      commands,
    );
    await this.sendKeyEvent(contents, "keyUp", combo.key, modifiers);
    for (const modifier of [...combo.modifiers].reverse()) {
      modifiers &= ~(MODIFIER_BITS[modifier.key] || 0);
      await this.sendKeyEvent(contents, "keyUp", modifier, modifiers);
    }
  }

  private async sendKeyEvent(
    contents: Any,
    type: "keyDown" | "rawKeyDown" | "keyUp",
    definition: KeyDefinition,
    modifiers: number,
    text?: string,
    commands?: string[],
  ): Promise<void> {
    await this.sendCommand(contents, "Input.dispatchKeyEvent", {
      type,
      modifiers,
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode,
      ...(text !== undefined ? { text, unmodifiedText: text } : {}),
      ...(commands ? { commands } : {}),
    });
  }

  private async callOnBackendNode(
    contents: Any,
    backendNodeId: number,
    functionDeclaration: string,
    args: Array<Record<string, unknown>> = [],
  ): Promise<Any> {
    const resolved = await this.sendCommand(contents, "DOM.resolveNode", {
      backendNodeId,
      objectGroup: ACTION_OBJECT_GROUP,
    });
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
    } else if (method === "Page.frameNavigated" && params?.frame && !params.frame.parentId) {
      // A new main-frame document: every backend node id from the last snapshot is gone.
      this.invalidateRefs(
        session,
        `the page navigated to ${redactBrowserText(params.frame.url || "a new document", 200)}`,
      );
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
