import { randomUUID } from "crypto";
import * as fsSync from "fs";
import * as path from "path";
import type { LLMTool } from "../llm/types";
import type { AgentDaemon } from "../daemon";
import type { Workspace } from "../../../shared/types";
import {
  assertWorkspaceReadableFileAccessWithApproval,
  createWorkspaceFilesystemApprovalHandlers,
  evaluateWorkspaceFilesystemAccess,
} from "../../security/access-profile-paths";
import {
  checkProjectAccess,
  getProjectIdFromWorkspaceRelPath,
  getWorkspaceRelativePosixPath,
} from "../../security/project-access";
import { buildWebPagePreviewFromPath } from "../../utils/web-preview";
import { WEB_PREVIEW_CSP } from "../../media/web-preview-protocol";

const PREVIEW_SCHEME = "cowork-preview";
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const LOAD_TIMEOUT_MS = 15_000;
const PAGE_CALL_TIMEOUT_MS = 10_000;
const SETTLE_MS = 400;
const ACTION_SETTLE_MS = 200;
const MAX_ACTIONS = 20;
const MAX_TEXT_CHARS = 4_000;
const MAX_CONSOLE_MESSAGES = 30;

export type WebPreviewAction =
  | { type: "click"; selector: string }
  | { type: "type"; selector: string; text: string }
  | { type: "wait"; ms: number };

type ConsoleEntry = { level: "error" | "warning"; message: string; source?: string };

function requireElectron(): { BrowserWindow: Any; session: Any } {
  try {
    const runtime = require("electron");
    if (typeof runtime.BrowserWindow === "function" && runtime.session?.fromPartition) {
      return runtime;
    }
  } catch {
    // Node-only server packages intentionally do not ship Electron.
  }
  throw new Error("preview_web_page requires the Electron desktop runtime.");
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A page stuck in a script never answers; bound every call into it. */
function withPageTimeout<T>(promise: Promise<T>, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The page stopped responding while ${step}`)),
        PAGE_CALL_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Pages being previewed, keyed by their per-call URL on the shared session. */
const previewPages = new Map<string, string>();
let sharedPreviewSession: Any | null = null;

/**
 * Electron never frees a partition's Session, so every call shares one
 * in-memory session instead of minting a new partition (which would leak).
 * It only resolves registered preview pages; every other request is cancelled.
 */
function getPreviewSession(): Any {
  if (sharedPreviewSession) return sharedPreviewSession;
  const { session } = requireElectron();
  const previewSession = session.fromPartition("web-preview-tool", { cache: false });
  previewSession.setPermissionRequestHandler(
    (_contents: Any, _permission: string, callback: (granted: boolean) => void) => callback(false),
  );
  previewSession.webRequest.onBeforeRequest(
    (details: { url: string }, callback: (response: { cancel: boolean }) => void) =>
      callback({ cancel: !details.url.startsWith(`${PREVIEW_SCHEME}:`) }),
  );
  previewSession.protocol.handle(PREVIEW_SCHEME, async (request: Request) => {
    const html = previewPages.get(request.url);
    return html !== undefined
      ? new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": WEB_PREVIEW_CSP,
            "Cache-Control": "no-store",
          },
        })
      : new Response("Not found", { status: 404 });
  });
  sharedPreviewSession = previewSession;
  return previewSession;
}

export function parseWebPreviewActions(raw: unknown): WebPreviewAction[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("actions must be an array");
  if (raw.length > MAX_ACTIONS) throw new Error(`At most ${MAX_ACTIONS} actions are allowed`);
  return raw.map((item, index) => {
    const action = item as Record<string, unknown>;
    const selector = typeof action?.selector === "string" ? action.selector.trim() : "";
    switch (action?.type) {
      case "click":
        if (!selector) throw new Error(`actions[${index}]: click needs a selector`);
        return { type: "click", selector };
      case "type":
        if (!selector) throw new Error(`actions[${index}]: type needs a selector`);
        if (typeof action.text !== "string") throw new Error(`actions[${index}]: type needs text`);
        return { type: "type", selector, text: action.text };
      case "wait": {
        const ms = Number(action.ms);
        if (!Number.isFinite(ms) || ms < 0) throw new Error(`actions[${index}]: wait needs ms`);
        return { type: "wait", ms: Math.min(ms, 5_000) };
      }
      default:
        throw new Error(`actions[${index}]: type must be click, type or wait`);
    }
  });
}

/** Runs one action inside the page; returns an error message or null. */
function actionScript(action: Exclude<WebPreviewAction, { type: "wait" }>): string {
  const selector = JSON.stringify(action.selector);
  if (action.type === "click") {
    return `(() => { const el = document.querySelector(${selector});
      if (!el) return "No element matches " + ${selector};
      el.scrollIntoView({ block: "center" });
      el.click(); return null; })()`;
  }
  const text = JSON.stringify(action.text);
  return `(() => { const el = document.querySelector(${selector});
    if (!el) return "No element matches " + ${selector};
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, ${text}); else el.value = ${text};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return null; })()`;
}

/**
 * Lets the agent open a page it built and check it the way the user's preview
 * shows it: scripts run, but the page is isolated from everything else.
 *
 * Each call renders in a hidden, sandboxed window on a throwaway in-memory
 * session that only resolves this one page (served with the viewer's strict
 * CSP). Every other request — network, files, other schemes — is cancelled,
 * navigation and pop-ups are refused, and the window is destroyed afterwards.
 */
export class WebPreviewTools {
  constructor(
    private workspace: Workspace,
    private daemon?: AgentDaemon,
    private taskId?: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isAvailable(): boolean {
    if (!process.versions.electron) return false;
    try {
      requireElectron();
      return true;
    } catch {
      return false;
    }
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "preview_web_page",
        description:
          "Open an HTML page from the workspace in a sandboxed preview and check that it works. " +
          "Use this after writing or editing a web page or small web app (for example a build's " +
          "index.html) to verify it renders and its JavaScript runs: it returns a screenshot, the " +
          "page's visible text and any console errors. Optionally run clicks and typing first to " +
          "test interactions (e.g. click a button, then confirm the text changed). The page has " +
          "no network access, so CDN scripts and remote fetches will not load — keep apps " +
          "self-contained. Use this instead of browser_navigate for local pages.",
        input_schema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Path of the .html file, relative to the workspace (e.g. index.html).",
            },
            actions: {
              type: "array",
              description:
                "Steps to run in order after the page loads (max 20). Each is " +
                '{"type":"click","selector":"#add"}, {"type":"type","selector":"input[name=q]","text":"acme"} ' +
                'or {"type":"wait","ms":300}.',
              items: { type: "object" },
            },
            width: { type: "number", description: "Viewport width in px (default 1280)." },
            height: { type: "number", description: "Viewport height in px (default 800)." },
          },
          required: ["path"],
        },
      },
    ];
  }

  async execute(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    if (toolName !== "preview_web_page") throw new Error(`Unknown tool: ${toolName}`);
    return this.previewWebPage(input);
  }

  /** Same checks as parse_document: workspace/profile access, then project ACLs. */
  private async resolveReadableFile(rawPath: string): Promise<string> {
    if (rawPath.includes("\0")) throw new Error("Page path is invalid.");
    const candidatePath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspace.path, rawPath);
    const approvalHandlers =
      this.daemon && this.taskId
        ? createWorkspaceFilesystemApprovalHandlers(this.daemon, this.taskId, "preview_web_page")
        : {};
    const resolvedPath = await assertWorkspaceReadableFileAccessWithApproval(
      this.workspace,
      candidatePath,
      "Web page",
      approvalHandlers,
    );

    await this.assertProjectReadAccess(candidatePath, resolvedPath);
    return resolvedPath;
  }

  private async assertProjectReadAccess(
    candidatePath: string,
    resolvedPath: string,
  ): Promise<void> {
    const workspaceRoot = fsSync.existsSync(this.workspace.path)
      ? fsSync.realpathSync(this.workspace.path)
      : path.resolve(this.workspace.path);
    const projectIds = new Set(
      [
        getWorkspaceRelativePosixPath(path.resolve(this.workspace.path), candidatePath),
        getWorkspaceRelativePosixPath(workspaceRoot, candidatePath),
        getWorkspaceRelativePosixPath(workspaceRoot, resolvedPath),
      ]
        .map((relative) => (relative === null ? null : getProjectIdFromWorkspaceRelPath(relative)))
        .filter((projectId): projectId is string => projectId !== null),
    );
    for (const projectId of projectIds) {
      const task = this.daemon && this.taskId ? this.daemon.getTask(this.taskId) : undefined;
      const access = await checkProjectAccess({
        workspacePath: workspaceRoot,
        projectId,
        agentRoleId: task?.assignedAgentRoleId || null,
      });
      if (!access.allowed) {
        throw new Error(access.reason || `Access denied for project "${projectId}"`);
      }
    }
  }

  private async previewWebPage(input: Record<string, unknown>): Promise<unknown> {
    const rawPath = typeof input.path === "string" ? input.path.trim() : "";
    if (!rawPath) throw new Error("path is required");
    if (!/\.html?$/i.test(rawPath)) throw new Error("path must point to an .html file");
    const actions = parseWebPreviewActions(input.actions);
    const width = Math.round(Math.min(Math.max(Number(input.width) || DEFAULT_WIDTH, 320), 2560));
    const height = Math.round(
      Math.min(Math.max(Number(input.height) || DEFAULT_HEIGHT, 320), 2000),
    );

    const resolvedPath = await this.resolveReadableFile(rawPath);
    const preview = await buildWebPagePreviewFromPath(resolvedPath, this.workspace.path, {
      // The entry read is already authorized, including any consumed one-shot grant.
      // Dependencies each need their own profile and canonical project check.
      authorizeReadPath: async (filePath) => {
        if (filePath !== resolvedPath) return this.resolveReadableFile(filePath);
        // Discovery can wait for another file's approval. Bind the entry grant
        // to its canonical target rather than reusing it for a replaced symlink.
        let currentPath: string;
        try {
          currentPath = fsSync.realpathSync(filePath);
        } catch {
          throw new Error("Web page changed while preparing preview");
        }
        if (currentPath !== resolvedPath)
          throw new Error("Web page changed while preparing preview");
        const access = evaluateWorkspaceFilesystemAccess(this.workspace, currentPath, "read", {
          // This request already authorized this exact target. Preserve that
          // one-shot grant while still enforcing current capability/profile denies.
          externalApprovalGranted: true,
        });
        if (access.decision !== "allow")
          throw new Error(`Access denied for Web page: ${access.reason}`);
        const candidatePath = path.resolve(this.workspace.path, rawPath);
        await this.assertProjectReadAccess(candidatePath, currentPath);
        return currentPath;
      },
    });
    if (!preview.canPreview || !preview.htmlContent) {
      return {
        success: false,
        error: preview.previewMessage || "This page cannot be previewed in-app.",
      };
    }

    const { BrowserWindow } = requireElectron();
    const previewSession = getPreviewSession();
    const pageUrl = `${PREVIEW_SCHEME}://page/${randomUUID()}/index.html`;
    previewPages.set(pageUrl, preview.htmlContent);

    const window = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      webPreferences: {
        session: previewSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        javascript: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    const contents = window.webContents;
    const consoleMessages: ConsoleEntry[] = [];
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event: { preventDefault: () => void }) => event.preventDefault());
    contents.on("will-redirect", (event: { preventDefault: () => void }) => event.preventDefault());
    contents.on(
      "console-message",
      (event: { level?: string; message?: string; lineNumber?: number; sourceId?: string }) => {
        const level = event.level === "error" || event.level === "warning" ? event.level : null;
        if (!level || consoleMessages.length >= MAX_CONSOLE_MESSAGES) return;
        consoleMessages.push({
          level,
          message: String(event.message ?? "").slice(0, 500),
          ...(event.sourceId ? { source: `${event.sourceId}:${event.lineNumber ?? 0}` } : {}),
        });
      },
    );

    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        window.loadURL(pageUrl),
        new Promise<never>((_resolve, reject) => {
          loadTimer = setTimeout(
            () => reject(new Error("The page did not finish loading within 15 seconds")),
            LOAD_TIMEOUT_MS,
          );
        }),
      ]);
      clearTimeout(loadTimer);
      await delay(SETTLE_MS);

      const actionResults: Array<{ action: WebPreviewAction; ok: boolean; error?: string }> = [];
      for (const action of actions) {
        if (action.type === "wait") {
          await delay(action.ms);
          actionResults.push({ action, ok: true });
          continue;
        }
        const error = (await withPageTimeout(
          contents.executeJavaScript(actionScript(action), true),
          `${action.type} on ${action.selector}`,
        )) as string | null;
        actionResults.push(error ? { action, ok: false, error } : { action, ok: true });
        await delay(ACTION_SETTLE_MS);
      }

      const pageInfo = (await withPageTimeout(
        contents.executeJavaScript(
          `({ title: document.title, text: (document.body && document.body.innerText) || "" })`,
          true,
        ),
        "reading the page",
      )) as { title?: string; text?: string };
      // Capture at the viewport size, not the display's pixel density, to keep
      // the image the model receives small.
      const captured: Any = await withPageTimeout(contents.capturePage(), "capturing the page");
      const image =
        captured.getSize().width > width ? captured.resize({ width, quality: "good" }) : captured;
      const size = image.getSize();
      const text = String(pageInfo?.text || "");
      const visibleText = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
      const consoleErrors = consoleMessages.filter((entry) => entry.level === "error");
      const consoleWarnings = consoleMessages.filter((entry) => entry.level === "warning");
      const failedActions = actionResults.filter((result) => !result.ok);
      // The screenshot path forwards only `note` to the model, so the findings go here.
      const note = [
        `Title: ${pageInfo?.title || "(none)"}.`,
        consoleErrors.length > 0
          ? `Console errors (${consoleErrors.length}): ${consoleErrors.map((entry) => entry.message).join(" | ")}.`
          : "No console errors.",
        consoleWarnings.length > 0 ? `Console warnings: ${consoleWarnings.length}.` : "",
        actionResults.length > 0
          ? failedActions.length > 0
            ? `Actions: ${failedActions.length} of ${actionResults.length} failed — ${failedActions.map((result) => result.error).join(" | ")}.`
            : `Actions: all ${actionResults.length} succeeded.`
          : "",
        `Visible text: ${visibleText.replace(/\s+/g, " ").trim().slice(0, 1_500) || "(empty)"}.`,
        "The preview has no network access.",
      ]
        .filter(Boolean)
        .join(" ");
      return {
        success: true,
        path: path.relative(this.workspace.path, resolvedPath) || path.basename(resolvedPath),
        title: pageInfo?.title || "",
        visibleText,
        consoleErrors,
        consoleWarnings,
        ...(actionResults.length > 0 ? { actions: actionResults } : {}),
        action: "preview_web_page",
        note,
        imageBase64: image.toPNG().toString("base64"),
        captureId: `web-preview-${randomUUID()}`,
        mediaType: "image/png",
        width: size.width,
        height: size.height,
      };
    } finally {
      clearTimeout(loadTimer);
      if (!window.isDestroyed()) window.destroy();
      previewPages.delete(pageUrl);
      // The session is shared, so only wipe page storage once no other preview is open.
      if (previewPages.size === 0) {
        try {
          await previewSession.clearStorageData();
        } catch {
          // The session is in-memory; cleanup is best effort.
        }
      }
    }
  }
}
