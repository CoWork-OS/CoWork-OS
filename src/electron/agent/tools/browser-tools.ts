import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { BrowserService } from "../browser/browser-service";
import {
  BrowserUseCloudClient,
  BrowserUseCloudSettings,
  BrowserUseBrowserSession,
  isPrivateOrLocalBrowserTarget,
  normalizeBrowserUseProxyCountryCode,
  normalizeBrowserUseTimeoutMinutes,
  redactBrowserUseUrl,
} from "../browser/browser-use-cloud-client";
import {
  BrowserWorkbenchService,
  getBrowserWorkbenchService,
} from "../../browser/browser-workbench-service";
import { normalizeBrowserUrl } from "../../browser/browser-session-manager";
import { evaluateNetworkPolicy } from "../../security/network-policy";
import { BuiltinToolsSettingsManager } from "./builtin-settings";

// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Any = any;
type BrowserProvider = "local" | "browser-use-cloud";

interface BrowserUseCloudSessionState {
  id: string;
  cdpUrl: string;
  liveUrl?: string | null;
  proxyCountryCode?: string | null;
  profileId?: string | null;
  timeoutMinutes?: number;
  browserScreenWidth?: number;
  browserScreenHeight?: number;
  allowResizing?: boolean;
  enableRecording?: boolean;
}

/**
 * BrowserTools provides browser automation capabilities to the agent
 */
export class BrowserTools {
  private browserService: BrowserService;
  private browserState: {
    headless: boolean;
    profile: string | null;
    browserChannel: "chromium" | "chrome" | "brave";
    debuggerUrl: string | null;
    browserProvider: BrowserProvider;
  } = {
    headless: true,
    profile: null,
    browserChannel: "chromium",
    debuggerUrl: null,
    browserProvider: "local",
  };
  private browserUseCloudClient: BrowserUseCloudClient | null = null;
  private browserUseCloudSession: BrowserUseCloudSessionState | null = null;
  private visibleWorkbenchApprovals = new Set<string>();

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
    private browserWorkbenchService: BrowserWorkbenchService = getBrowserWorkbenchService(),
  ) {
    this.browserService = new BrowserService(workspace, {
      headless: true,
      timeout: 90000, // 90 seconds - time for browser launch + navigation + consent popup handling
    });
  }

  /**
   * Update the workspace for this tool
   * Recreates the browser service with the new workspace
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    // Recreate browser service with new workspace (and reset to defaults)
    this.browserService = new BrowserService(workspace, {
      headless: true,
      timeout: 90000,
    });
    this.browserState = {
      headless: true,
      profile: null,
      browserChannel: "chromium",
      debuggerUrl: null,
      browserProvider: "local",
    };
  }

  private getTimeoutMs(input: unknown): number | undefined {
    const toolInput = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const rawTimeout = toolInput?.timeout_ms;
    if (typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0) {
      return Math.round(rawTimeout);
    }
    return undefined;
  }

  private getSessionId(input: unknown): string | undefined {
    const toolInput = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return typeof toolInput.session_id === "string" && toolInput.session_id.trim()
      ? toolInput.session_id.trim()
      : undefined;
  }

  private ensureVisibleNavigationAllowed(rawUrl: unknown): string {
    const url = normalizeBrowserUrl(rawUrl);
    if (!url) {
      throw new Error("url is required");
    }
    if (!this.workspace.permissions?.network) {
      throw new Error("Workspace does not have network permission for browser navigation");
    }
    const decision = evaluateNetworkPolicy({ url, toolName: "browser_navigate" });
    this.daemon.logEvent(this.taskId, "network_policy_decision", decision);
    if (decision.action !== "allow") {
      if (decision.reason === "legacy_guardrail_domain_denied") {
        throw new Error(`Domain not allowed: "${url}"`);
      }
      throw new Error(`Network access denied for "${url}": ${decision.reason}`);
    }
    return url;
  }

  private hasExplicitRealBrowserConsent(input: unknown): boolean {
    const toolInput = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return (
      toolInput.confirm_real_browser_control === true ||
      toolInput.real_browser_consent === true ||
      toolInput.user_confirmed === true
    );
  }

  private isSystemBrowserProfileRequest(input: unknown): boolean {
    const toolInput = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return typeof toolInput.profile === "string" && toolInput.profile.trim().toLowerCase() === "user";
  }

  private async realpathIfExists(candidatePath: string): Promise<string | null> {
    try {
      return await fs.realpath(candidatePath);
    } catch {
      return null;
    }
  }

  private async resolveWorkspaceReadablePath(rawPath: unknown): Promise<string> {
    const value = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!value) throw new Error("file_path is required");
    const resolved = path.resolve(this.workspace.path, value);
    const realResolved = await this.realpathIfExists(resolved);
    if (!realResolved) {
      throw new Error("Upload file not found");
    }
    const allowedRootCandidates = [
      this.workspace.path,
      ...((this.workspace.permissions?.allowedPaths || []) as string[]),
    ];
    const allowedRoots = (
      await Promise.all(
        allowedRootCandidates.map((item) => this.realpathIfExists(path.resolve(item))),
      )
    ).filter((item): item is string => typeof item === "string" && item.length > 0);
    const isAllowed =
      this.workspace.permissions?.unrestrictedFileAccess === true ||
      allowedRoots.some((root) => realResolved === root || realResolved.startsWith(`${root}${path.sep}`));
    if (!this.workspace.permissions?.read || !isAllowed) {
      throw new Error("Read permission not granted for this upload path");
    }
    return realResolved;
  }

  private shouldPreferVisibleWorkbench(input: unknown): boolean {
    const toolInput = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (this.shouldRouteToBrowserUseCloud(input)) return false;
    const automationMode =
      BuiltinToolsSettingsManager.getComputerUseAutomationSettings().browserAutomationMode;
    const forceHeadless =
      toolInput.force_headless === true ||
      toolInput.mode === "headless" ||
      toolInput.visible === false ||
      toolInput.browser_surface === "headless";
    if (forceHeadless) return false;
    if (typeof toolInput.debugger_url === "string" && toolInput.debugger_url.trim()) return false;
    if (this.hasVisibleWorkbenchSession(input)) return true;
    if (automationMode === "background") return false;
    if (automationMode === "ask") return false;
    if (typeof toolInput.profile === "string" && toolInput.profile.trim()) return false;
    if (typeof toolInput.browser_channel === "string" && toolInput.browser_channel.trim()) return false;
    if (this.browserState.profile || this.browserState.debuggerUrl) return false;
    return automationMode === "visible";
  }

  private hasExplicitVisibleWorkbenchRequest(input: unknown): boolean {
    const toolInput = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return toolInput.browser_surface === "visible" || toolInput.visible === true;
  }

  private canStartVisibleWorkbench(input: unknown): boolean {
    const toolInput = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (this.shouldRouteToBrowserUseCloud(input)) return false;
    if (
      toolInput.force_headless === true ||
      toolInput.mode === "headless" ||
      toolInput.visible === false ||
      toolInput.browser_surface === "headless"
    ) {
      return false;
    }
    if (typeof toolInput.debugger_url === "string" && toolInput.debugger_url.trim()) return false;
    if (typeof toolInput.profile === "string" && toolInput.profile.trim()) return false;
    if (typeof toolInput.browser_channel === "string" && toolInput.browser_channel.trim()) return false;
    if (this.browserState.profile || this.browserState.debuggerUrl) return false;
    return true;
  }

  private visibleWorkbenchApprovalKey(input: unknown): string {
    return this.getSessionId(input) || "default";
  }

  private async requestVisibleWorkbenchApproval(input: unknown, url: string): Promise<boolean> {
    const key = this.visibleWorkbenchApprovalKey(input);
    if (this.visibleWorkbenchApprovals.has(key)) return true;
    const requester = (this.daemon as Any)?.requestApproval;
    if (typeof requester !== "function") return false;
    const approved = await requester.call(
      this.daemon,
      this.taskId,
      "browser",
      "Open a visible browser workbench for this task?",
      {
        kind: "browser_visible_workbench",
        tool: "browser_navigate",
        url,
        sessionId: key,
      },
      { allowAutoApprove: false },
    );
    if (approved) {
      this.visibleWorkbenchApprovals.add(key);
    }
    return approved;
  }

  private async shouldUseVisibleWorkbenchForNavigation(input: unknown): Promise<boolean> {
    if (this.shouldPreferVisibleWorkbench(input)) return true;
    const automationMode =
      BuiltinToolsSettingsManager.getComputerUseAutomationSettings().browserAutomationMode;
    if (automationMode !== "ask") return false;
    if (!this.hasExplicitVisibleWorkbenchRequest(input)) return false;
    if (!this.canStartVisibleWorkbench(input)) return false;
    const rawUrl = input && typeof input === "object" ? (input as Record<string, unknown>).url : undefined;
    const url = typeof rawUrl === "string" ? rawUrl : "";
    return await this.requestVisibleWorkbenchApproval(input, url);
  }

  private isBrowserUseCloudProviderRequested(input: unknown): boolean {
    const toolInput = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const provider = typeof toolInput.browser_provider === "string" ? toolInput.browser_provider.trim() : "";
    return provider === "browser-use-cloud";
  }

  private isBrowserUseCloudConfigured(): boolean {
    return Boolean(
      this.browserUseCloudClient || BrowserUseCloudClient.resolveApiKey(this.getBrowserUseCloudSettings()),
    );
  }

  private shouldRouteToBrowserUseCloud(input: unknown): boolean {
    return this.isBrowserUseCloudProviderRequested(input) && this.isBrowserUseCloudConfigured();
  }

  private static isBrowserUseCloudConfiguredForToolSchema(): boolean {
    return Boolean(BrowserUseCloudClient.resolveApiKey(BrowserUseCloudClient.loadSettings()));
  }

  private getBrowserUseCloudSettings(): BrowserUseCloudSettings {
    return BrowserUseCloudClient.loadSettings();
  }

  private getBrowserUseCloudClient(): BrowserUseCloudClient | null {
    if (this.browserUseCloudClient) return this.browserUseCloudClient;
    const apiKey = BrowserUseCloudClient.resolveApiKey(this.getBrowserUseCloudSettings());
    if (!apiKey) return null;
    this.browserUseCloudClient = new BrowserUseCloudClient(apiKey);
    return this.browserUseCloudClient;
  }

  private readBrowserUseCloudOptions(input: unknown): {
    profileId?: string | null;
    proxyCountryCode?: string | null;
    timeoutMinutes?: number;
    browserScreenWidth?: number;
    browserScreenHeight?: number;
    allowResizing?: boolean;
    enableRecording?: boolean;
  } {
    const settings = this.getBrowserUseCloudSettings();
    const toolInput = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const rawProfileId =
      typeof toolInput.browser_use_profile_id === "string"
        ? toolInput.browser_use_profile_id.trim()
        : typeof settings.defaultProfileId === "string"
          ? settings.defaultProfileId.trim()
          : "";
    const rawProxy =
      "proxy_country_code" in toolInput
        ? toolInput.proxy_country_code
        : "browser_use_proxy_country_code" in toolInput
          ? toolInput.browser_use_proxy_country_code
          : settings.defaultProxyCountryCode;
    const rawTimeout =
      typeof toolInput.browser_timeout_minutes === "number"
        ? toolInput.browser_timeout_minutes
        : typeof toolInput.timeout_minutes === "number"
          ? toolInput.timeout_minutes
          : undefined;
    const timeoutMinutes = normalizeBrowserUseTimeoutMinutes(rawTimeout, settings.defaultTimeoutMinutes);
    return {
      profileId: rawProfileId || undefined,
      proxyCountryCode: normalizeBrowserUseProxyCountryCode(rawProxy),
      timeoutMinutes,
      browserScreenWidth:
        typeof toolInput.browser_screen_width === "number"
          ? Math.max(320, Math.min(6144, Math.round(toolInput.browser_screen_width)))
          : undefined,
      browserScreenHeight:
        typeof toolInput.browser_screen_height === "number"
          ? Math.max(320, Math.min(3456, Math.round(toolInput.browser_screen_height)))
          : undefined,
      allowResizing: toolInput.allow_resizing === true,
      enableRecording:
        typeof toolInput.enable_recording === "boolean"
          ? toolInput.enable_recording
          : settings.defaultEnableRecording === true,
    };
  }

  private browserUseSessionMatches(
    existing: BrowserUseCloudSessionState | null,
    next: ReturnType<BrowserTools["readBrowserUseCloudOptions"]>,
  ): boolean {
    if (!existing) return false;
    return (
      existing.profileId === (next.profileId ?? undefined) &&
      existing.proxyCountryCode === next.proxyCountryCode &&
      existing.timeoutMinutes === next.timeoutMinutes &&
      existing.browserScreenWidth === next.browserScreenWidth &&
      existing.browserScreenHeight === next.browserScreenHeight &&
      existing.allowResizing === next.allowResizing &&
      existing.enableRecording === next.enableRecording
    );
  }

  private isRetryableBrowserUseCloudSessionError(error: unknown): boolean {
    const message = String((error as Error)?.message || error || "").toLowerCase();
    return /target.*closed|browser.*closed|context.*closed|websocket|web socket|socket hang up|econnreset|econnrefused|protocol error|cdp|session.*closed|session.*expired|browser.*expired|not connected/.test(
      message,
    );
  }

  private async ensureBrowserUseCloudConfigured(input: unknown): Promise<BrowserUseCloudSessionState> {
    const client = this.getBrowserUseCloudClient();
    if (!client) {
      throw new Error(
        "Browser Use Cloud is not configured. Set BROWSER_USE_API_KEY or save Browser Use credentials in encrypted settings.",
      );
    }
    const options = this.readBrowserUseCloudOptions(input);
    if (
      this.browserUseSessionMatches(this.browserUseCloudSession, options) &&
      this.browserState.browserProvider === "browser-use-cloud" &&
      this.browserState.debuggerUrl === this.browserUseCloudSession?.cdpUrl
    ) {
      return this.browserUseCloudSession;
    }

    await this.browserService.close();
    await this.stopBrowserUseCloudSession();

    const session = await client.createBrowserSession({
      profileId: options.profileId,
      proxyCountryCode: options.proxyCountryCode,
      timeout: options.timeoutMinutes,
      browserScreenWidth: options.browserScreenWidth,
      browserScreenHeight: options.browserScreenHeight,
      allowResizing: options.allowResizing,
      enableRecording: options.enableRecording,
    });
    const state: BrowserUseCloudSessionState = {
      id: session.id,
      cdpUrl: session.cdpUrl || "",
      liveUrl: session.liveUrl,
      proxyCountryCode: options.proxyCountryCode,
      profileId: options.profileId,
      timeoutMinutes: options.timeoutMinutes,
      browserScreenWidth: options.browserScreenWidth,
      browserScreenHeight: options.browserScreenHeight,
      allowResizing: options.allowResizing,
      enableRecording: options.enableRecording,
    };
    if (!state.cdpUrl) {
      await this.stopBrowserUseCloudSessionById(client, state.id).catch(() => {});
      throw new Error("Browser Use Cloud session did not include a CDP URL");
    }
    this.browserUseCloudSession = state;
    this.browserService = new BrowserService(this.workspace, {
      headless: true,
      timeout: 90000,
      debuggerUrl: state.cdpUrl,
    });
    this.browserState = {
      headless: true,
      profile: null,
      browserChannel: "chromium",
      debuggerUrl: state.cdpUrl,
      browserProvider: "browser-use-cloud",
    };
    return state;
  }

  private async stopBrowserUseCloudSession(): Promise<BrowserUseBrowserSession | null> {
    const existing = this.browserUseCloudSession;
    if (!existing) return null;
    const client = this.getBrowserUseCloudClient();
    if (!client) {
      throw new Error(`Cannot stop Browser Use Cloud session ${existing.id}: client is not configured`);
    }
    const stopped = await this.stopBrowserUseCloudSessionById(client, existing.id);
    if (this.browserUseCloudSession?.id === existing.id) {
      this.browserUseCloudSession = null;
    }
    return stopped;
  }

  private async stopBrowserUseCloudSessionById(
    client: BrowserUseCloudClient,
    sessionId: string,
  ): Promise<BrowserUseBrowserSession> {
    return await client.stopBrowserSession(sessionId);
  }

  private isProfileLaunchConflict(error: unknown): boolean {
    const message = String((error as Error)?.message || error || "");
    return /ProcessSingleton|SingletonLock|profile.*in use|already running with this profile|already in use/i.test(
      message,
    );
  }

  private profileLaunchConflictResult(error: unknown): Any {
    const message = String((error as Error)?.message || error || "");
    return {
      success: false,
      error:
        "Chrome is already running with that profile, so I could not launch a separate profile-backed browser. Continue in the visible Browser Use session, or attach to an already-running Chrome instance with browser_attach and a debugger_url.",
      details: message,
      browserMode: "external_profile",
      retryableWithVisibleWorkbench: true,
    };
  }

  private hasVisibleWorkbenchSession(input: unknown): boolean {
    return Boolean(this.browserWorkbenchService.getSession(this.taskId, this.getSessionId(input)));
  }

  private getPersistentUserDataDir(profile: string): string {
    const trimmed = profile.trim().toLowerCase();
    if (trimmed === "user") {
      return this.getSystemChromeUserDataDir();
    }
    if (trimmed === "chrome-relay") {
      return path.join(this.workspace.path, ".cowork", "browser-profiles", "chrome-relay");
    }
    if (trimmed === "workspace") {
      return path.join(this.workspace.path, ".cowork", "browser-profiles", "default");
    }
    const safe =
      path
        .basename(profile.trim())
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .slice(0, 64) || "default";
    return path.join(this.workspace.path, ".cowork", "browser-profiles", safe);
  }

  private getSystemChromeUserDataDir(): string {
    const home = os.homedir();
    if (process.platform === "darwin") {
      return path.join(home, "Library", "Application Support", "Google", "Chrome");
    }
    if (process.platform === "win32") {
      const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      return path.join(local, "Google", "Chrome", "User Data");
    }
    return path.join(home, ".config", "google-chrome");
  }

  private async ensureBrowserConfigured(opts: {
    headless?: unknown;
    profile?: unknown;
    browser_channel?: unknown;
    debugger_url?: unknown;
  }): Promise<void> {
    const requestedHeadless = typeof opts.headless === "boolean" ? opts.headless : undefined;
    const profileRaw = typeof opts.profile === "string" ? opts.profile.trim() : undefined;
    const requestedProfile =
      profileRaw !== undefined ? (profileRaw ? profileRaw : null) : undefined;
    const channelRaw =
      typeof opts.browser_channel === "string" ? opts.browser_channel.trim().toLowerCase() : "";
    const requestedChannel =
      channelRaw === "chrome" || channelRaw === "chromium" || channelRaw === "brave"
        ? channelRaw
        : undefined;
    const debuggerUrlRaw =
      typeof opts.debugger_url === "string" ? opts.debugger_url.trim() || null : null;

    const nextHeadless = requestedHeadless ?? this.browserState.headless;
    const nextProfile = requestedProfile ?? this.browserState.profile;
    const nextChannel =
      requestedChannel ??
      (nextProfile?.toLowerCase() === "user" ? "chrome" : this.browserState.browserChannel);
    const nextDebuggerUrl =
      requestedProfile !== undefined || requestedChannel !== undefined
        ? null
        : debuggerUrlRaw ?? this.browserState.debuggerUrl;

    if (
      nextHeadless === this.browserState.headless &&
      nextProfile === this.browserState.profile &&
      nextChannel === this.browserState.browserChannel &&
      nextDebuggerUrl === this.browserState.debuggerUrl &&
      this.browserState.browserProvider === "local"
    ) {
      return;
    }

    await this.browserService.close();
    await this.stopBrowserUseCloudSession();
    this.browserService = new BrowserService(this.workspace, {
      headless: nextHeadless,
      timeout: 90000,
      userDataDir: nextProfile ? this.getPersistentUserDataDir(nextProfile) : undefined,
      channel: nextChannel,
      debuggerUrl: nextDebuggerUrl ?? undefined,
    });
    this.browserState = {
      headless: nextHeadless,
      profile: nextProfile,
      browserChannel: nextChannel,
      debuggerUrl: nextDebuggerUrl,
      browserProvider: "local",
    };
  }

  /**
   * Get the tool definitions for browser automation
   */
  static getToolDefinitions() {
    const browserUseCloudConfigured = BrowserTools.isBrowserUseCloudConfiguredForToolSchema();
    const browserNavigateProperties: Record<string, Any> = {
      url: {
        type: "string",
        description: "The URL to navigate to",
      },
      wait_until: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        description: "When to consider navigation complete. Default: load",
      },
      headless: {
        type: "boolean",
        description:
          "Compatibility flag for legacy Playwright fallback. Ignored for normal visible in-app browser workbench routing.",
      },
      force_headless: {
        type: "boolean",
        description:
          "Force the legacy headless Playwright path. Use only when the user explicitly asks for background/headless browsing.",
      },
      profile: {
        type: "string",
        description:
          "Optional profile. Presets: 'user' (system Chrome signed-in), 'chrome-relay' (extension relay), 'workspace' (workspace default). " +
          "Or any name for .cowork/browser-profiles/<name>.",
      },
      browser_channel: {
        type: "string",
        enum: ["chromium", "chrome", "brave"],
        description:
          'Which browser binary to use (default: chromium). "chrome" requires Google Chrome; "brave" requires Brave (or BRAVE_PATH).',
      },
      confirm_real_browser_control: {
        type: "boolean",
        description: "Required only when profile='user' asks CoWork to control the system Chrome profile.",
      },
      session_id: {
        type: "string",
        description: "Optional visible in-app browser workbench session id. Defaults to the active task browser session.",
      },
    };
    if (browserUseCloudConfigured) {
      Object.assign(browserNavigateProperties, {
        browser_provider: {
          type: "string",
          enum: ["browser-use-cloud"],
          description:
            'Explicitly use a configured Browser Use Cloud stealth browser. Omit for local browser control.',
        },
        proxy_country_code: {
          type: "string",
          description:
            "Browser Use Cloud proxy country code, such as 'us' or 'de'. Use 'none' to disable Browser Use proxy routing.",
        },
        browser_use_profile_id: {
          type: "string",
          description: "Optional Browser Use profile id for persistent cloud browser cookies/state.",
        },
        browser_timeout_minutes: {
          type: "number",
          description: "Browser Use Cloud session timeout in minutes. Clamped to 1-240.",
        },
        enable_recording: {
          type: "boolean",
          description: "Enable Browser Use Cloud recording for this browser session.",
        },
        browser_screen_width: {
          type: "number",
          description: "Optional Browser Use Cloud browser screen width.",
        },
        browser_screen_height: {
          type: "number",
          description: "Optional Browser Use Cloud browser screen height.",
        },
        allow_resizing: {
          type: "boolean",
          description: "Allow Browser Use Cloud viewport resizing for this session.",
        },
      });
    }
    return [
      {
        name: "browser_attach",
        description:
          "Attach to an existing Chrome browser session via Chrome DevTools Protocol. " +
          "Use when you need to control a signed-in browser (e.g. Gmail, social media). " +
          "Setup: Launch Chrome with --remote-debugging-port=9222, or visit chrome://inspect/#devices. " +
          "The debugger_url is typically http://localhost:9222 or the WebSocket URL from the version endpoint. " +
          "After attach, use browser_navigate and other browser_* tools on the attached session.",
        input_schema: {
          type: "object" as const,
          properties: {
            debugger_url: {
              type: "string",
              description:
                "Chrome DevTools endpoint (e.g. http://localhost:9222 or ws://127.0.0.1:9222/... from chrome://inspect)",
            },
            confirm_real_browser_control: {
              type: "boolean",
              description:
                "Required explicit user consent flag for controlling a real signed-in browser. Must be true.",
            },
          },
          required: ["debugger_url", "confirm_real_browser_control"],
        },
      },
      {
        name: "browser_navigate",
        description:
          "Navigate the browser to a URL. By default, CoWork uses background/headless browser control unless settings or the tool input request a visible workbench. " +
          "If a visible workbench session already exists, continue using it even when profile/browser_channel options are supplied. " +
          "Optional: set visible=true or browser_surface='visible' when the user wants to watch or interact with the shared browser. " +
          "Optional: set force_headless=true or browser_surface='headless' when the user explicitly asks for background/headless Playwright. " +
          "Optional: set profile to use a Playwright browser profile or external signed-in Chrome fallback (not the embedded workbench). " +
          'Optional: set browser_channel to "chrome" (system Google Chrome) or "brave" (system Brave); default is bundled Chromium. ' +
          "NOTE: For RESEARCH tasks (finding news, trends, discussions), use web_search instead - it aggregates results from multiple sources. " +
          "For simply reading a specific URL, use web_fetch - it is faster and lighter. " +
          "Use browser_navigate ONLY when you need to interact with the page (click, fill forms, take screenshots) or when the page requires JavaScript rendering.",
        input_schema: {
          type: "object" as const,
          properties: browserNavigateProperties,
          required: ["url"],
        },
      },
      {
        name: "browser_screenshot",
        description: "Take a screenshot of the current page",
        input_schema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: "Filename for the screenshot (optional, will generate if not provided)",
            },
            full_page: {
              type: "boolean",
              description: "Capture the full scrollable page. Default: false",
            },
            require_selector: {
              type: "string",
              description:
                "Optional CSS selector that must be present/visible before taking the screenshot",
            },
            disallow_url_contains: {
              type: "array",
              items: { type: "string" },
              description: "If current URL contains any of these substrings, abort screenshot",
            },
            max_wait_ms: {
              type: "number",
              description: "Max wait time for require_selector (ms). Default: 10000",
            },
            allow_consent: {
              type: "boolean",
              description: "Allow screenshots of consent pages (default: false)",
            },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_snapshot",
        description:
          "Get a compact accessibility snapshot of the current browser tab. Prefer refs from this snapshot for browser_click, browser_fill, browser_type, browser_get_text, browser_hover, browser_drag, and browser_upload_file.",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_tabs",
        description: "List tabs for the active browser session",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_switch_tab",
        description: "Switch to a browser tab by tab id",
        input_schema: {
          type: "object" as const,
          properties: {
            tab_id: { type: "string", description: "Tab id from browser_tabs" },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["tab_id"],
        },
      },
      {
        name: "browser_close_tab",
        description: "Close a browser tab by tab id",
        input_schema: {
          type: "object" as const,
          properties: {
            tab_id: { type: "string", description: "Tab id from browser_tabs" },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["tab_id"],
        },
      },
      {
        name: "browser_get_content",
        description:
          "Get the text content, links, and forms from the current page. " +
          "NOTE: For RESEARCH tasks, use web_search first - it is more efficient for finding information across multiple sources. " +
          "If you just need to read a specific URL, use web_fetch - it is faster and does not require opening a browser. " +
          "Use this only after browser_navigate when you need JavaScript-rendered content or to inspect forms/links for interaction.",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_click",
        description: "Click on an element on the page",
        input_schema: {
          type: "object" as const,
          properties: {
            ref: {
              type: "string",
              description: "Preferred Browser V2 ref from browser_snapshot",
            },
            selector: {
              type: "string",
              description:
                'CSS selector or text selector (e.g., "button.submit", "text=Login", "#myButton")',
            },
            timeout_ms: {
              type: "number",
              description: "Action timeout in ms. Use 60000+ for slow pages (default: 90_000)",
            },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_hover",
        description: "Move the browser pointer over an element, preferably by browser_snapshot ref",
        input_schema: {
          type: "object" as const,
          properties: {
            ref: { type: "string", description: "Preferred Browser V2 ref from browser_snapshot" },
            selector: { type: "string", description: "CSS selector fallback" },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_drag",
        description: "Drag from one Browser V2 snapshot ref to another",
        input_schema: {
          type: "object" as const,
          properties: {
            from_ref: { type: "string", description: "Drag start ref from browser_snapshot" },
            to_ref: { type: "string", description: "Drag end ref from browser_snapshot" },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["from_ref", "to_ref"],
        },
      },
      {
        name: "browser_fill",
        description: "Fill a form field with text",
        input_schema: {
          type: "object" as const,
          properties: {
            ref: {
              type: "string",
              description: "Preferred Browser V2 ref from browser_snapshot",
            },
            selector: {
              type: "string",
              description:
                'CSS selector for the input field (e.g., "input[name=email]", "#username")',
            },
            value: {
              type: "string",
              description: "The text to fill in",
            },
            timeout_ms: {
              type: "number",
              description: "Action timeout in ms. Use 60000+ for slow pages (default: 90_000)",
            },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["value"],
        },
      },
      {
        name: "browser_type",
        description: "Type text character by character (useful for search boxes with autocomplete)",
        input_schema: {
          type: "object" as const,
          properties: {
            ref: {
              type: "string",
              description: "Preferred Browser V2 ref from browser_snapshot",
            },
            selector: {
              type: "string",
              description: "CSS selector for the input field",
            },
            text: {
              type: "string",
              description: "The text to type",
            },
            delay: {
              type: "number",
              description: "Delay between keystrokes in ms. Default: 50",
            },
            timeout_ms: {
              type: "number",
              description: "Action timeout in ms. Use 60000+ for slow pages (default: 90_000)",
            },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "browser_press",
        description: "Press a keyboard key (e.g., Enter, Tab, Escape)",
        input_schema: {
          type: "object" as const,
          properties: {
            key: {
              type: "string",
              description: 'The key to press (e.g., "Enter", "Tab", "Escape", "ArrowDown")',
            },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "browser_wait",
        description: "Wait for an element to appear on the page",
        input_schema: {
          type: "object" as const,
          properties: {
            selector: {
              type: "string",
              description: "CSS selector to wait for",
            },
            timeout: {
              type: "number",
              description: "Max time to wait in ms. Default: 30000",
            },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["selector"],
        },
      },
      {
        name: "browser_scroll",
        description: "Scroll the page",
        input_schema: {
          type: "object" as const,
          properties: {
            direction: {
              type: "string",
              enum: ["up", "down", "top", "bottom"],
              description: "Direction to scroll",
            },
            amount: {
              type: "number",
              description: "Pixels to scroll (for up/down). Default: 500",
            },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["direction"],
        },
      },
      {
        name: "browser_select",
        description: "Select an option from a dropdown",
        input_schema: {
          type: "object" as const,
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the select element",
            },
            value: {
              type: "string",
              description: "Value to select",
            },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["selector", "value"],
        },
      },
      {
        name: "browser_get_text",
        description: "Get the text content of an element",
        input_schema: {
          type: "object" as const,
          properties: {
            ref: {
              type: "string",
              description: "Preferred Browser V2 ref from browser_snapshot",
            },
            selector: {
              type: "string",
              description: "CSS selector for the element",
            },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_upload_file",
        description:
          "Upload a workspace-readable file into a file input, preferably using a Browser V2 ref from browser_snapshot",
        input_schema: {
          type: "object" as const,
          properties: {
            file_path: { type: "string", description: "Workspace file path to upload" },
            ref: { type: "string", description: "Preferred Browser V2 ref for an input[type=file]" },
            selector: { type: "string", description: "CSS selector fallback for input[type=file]" },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["file_path"],
        },
      },
      {
        name: "browser_handle_dialog",
        description: "Accept or dismiss the latest JavaScript dialog in the browser",
        input_schema: {
          type: "object" as const,
          properties: {
            accept: { type: "boolean", description: "Accept the dialog. Default: true" },
            prompt_text: { type: "string", description: "Optional prompt text for prompt dialogs" },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_console",
        description: "Return recent browser console messages with secrets redacted",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_network",
        description: "Return recent browser network requests/responses with secrets redacted",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_downloads",
        description: "Return recent downloads observed in the browser session",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_storage",
        description: "Return redacted local/session storage for the current page",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_emulate",
        description:
          "Set the visible in-app browser viewport/device emulation for responsive testing. " +
          "Use this before screenshot/snapshot passes at common breakpoints such as desktop 1440x900, tablet 768x1024, and mobile 390x844.",
        input_schema: {
          type: "object" as const,
          properties: {
            width: { type: "number", description: "Viewport width" },
            height: { type: "number", description: "Viewport height" },
            device_scale_factor: { type: "number", description: "Device scale factor" },
            mobile: { type: "boolean", description: "Use mobile emulation metrics" },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_trace_start",
        description: "Start a lightweight browser trace for diagnostics",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_trace_stop",
        description: "Stop the active lightweight browser trace",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_evaluate",
        description: "Execute JavaScript code in the browser context",
        input_schema: {
          type: "object" as const,
          properties: {
            script: {
              type: "string",
              description: "JavaScript code to execute",
            },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["script"],
        },
      },
      {
        name: "browser_back",
        description: "Go back in browser history",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_forward",
        description: "Go forward in browser history",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_reload",
        description: "Reload the current page",
        input_schema: {
          type: "object" as const,
          properties: {
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
        },
      },
      {
        name: "browser_save_pdf",
        description: "Save the current page as a PDF",
        input_schema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: "Filename for the PDF (optional)",
            },
          },
        },
      },
      {
        name: "browser_act_batch",
        description:
          "Execute a batch of browser actions in sequence. Use for multi-step interactions (e.g. fill form, click submit, wait for result). " +
          "Each action can have an optional delay_ms before it runs. Actions: click, fill, type, press, wait, scroll.",
        input_schema: {
          type: "object" as const,
          properties: {
            actions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["click", "fill", "type", "press", "wait", "scroll"],
                    description: "Action type",
                  },
                  selector: {
                    type: "string",
                    description: "CSS selector (required for click, fill, type, wait)",
                  },
                  value: { type: "string", description: "Value for fill" },
                  text: { type: "string", description: "Text for type" },
                  key: { type: "string", description: "Key for press (e.g. Enter, Tab)" },
                  direction: {
                    type: "string",
                    enum: ["up", "down", "top", "bottom"],
                    description: "Scroll direction",
                  },
                  amount: { type: "number", description: "Scroll amount in pixels" },
                  timeout_ms: { type: "number", description: "Wait timeout for wait action" },
                  delay_ms: {
                    type: "number",
                    description: "Delay before this action (ms)",
                  },
                },
                required: ["type"],
              },
              description: "Array of actions to execute in order",
            },
            session_id: {
              type: "string",
              description: "Optional visible in-app browser workbench session id.",
            },
          },
          required: ["actions"],
        },
      },
      {
        name: "browser_close",
        description: "Close the browser",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
      },
    ];
  }

  /**
   * Execute a browser tool
   */
  async executeTool(toolName: string, input: Any): Promise<Any> {
    switch (toolName) {
      case "browser_attach": {
        const debuggerUrl = typeof input?.debugger_url === "string" ? input.debugger_url.trim() : "";
        if (!debuggerUrl) {
          return {
            success: false,
            error: "debugger_url is required. Use http://localhost:9222 or the WebSocket URL from chrome://inspect",
          };
        }
        if (!this.hasExplicitRealBrowserConsent(input)) {
          return {
            success: false,
            error:
              "Explicit consent is required before controlling a real signed-in browser. Retry with confirm_real_browser_control=true only after the user approves the target browser/profile/tab.",
            consentRequired: true,
          };
        }
        await this.browserService.close();
        this.browserService = new BrowserService(this.workspace, {
          headless: true,
          timeout: 90000,
          debuggerUrl,
        });
        this.browserState = {
          ...this.browserState,
          debuggerUrl,
        };
        await this.browserService.init();
        const url = this.browserService.getUrl();
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "attach",
          debuggerUrl: debuggerUrl.replace(/\/[^/]*$/, "/..."),
        });
        return {
          success: true,
          message: "Attached to existing Chrome session",
          currentUrl: url || "(new tab)",
        };
      }

      case "browser_navigate": {
        if (await this.shouldUseVisibleWorkbenchForNavigation(input)) {
          const visibleUrl = this.ensureVisibleNavigationAllowed(input?.url);
          const visibleResult = await this.browserWorkbenchService.navigate({
            taskId: this.taskId,
            sessionId: this.getSessionId(input),
            url: visibleUrl,
            waitUntil: input?.wait_until || "load",
          });
          if (visibleResult) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "navigate",
              url: visibleResult.url,
              title: visibleResult.title,
              sessionId: this.getSessionId(input) || "default",
              visible: true,
            });
            return visibleResult;
          }
        }
        if (this.isBrowserUseCloudProviderRequested(input) && !this.isBrowserUseCloudConfigured()) {
          this.daemon.logEvent(this.taskId, "browser_action", {
            action: "browser_use_cloud_fallback_unconfigured",
            url: input?.url,
            fallback: "local",
          });
        }
        if (this.shouldRouteToBrowserUseCloud(input)) {
          const url = this.ensureVisibleNavigationAllowed(input?.url);
          if (isPrivateOrLocalBrowserTarget(url)) {
            return {
              success: false,
              error:
                "Browser Use Cloud cannot be used for localhost, private IP, link-local, or file targets. Use the default visible Browser Workbench for local/private sites.",
            };
          }
          let lastError: unknown;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            let cloudSession: BrowserUseCloudSessionState | null = null;
            try {
              cloudSession = await this.ensureBrowserUseCloudConfigured(input);
              const result = await this.browserService.navigate(url, input?.wait_until || "load");
              this.daemon.logEvent(this.taskId, "browser_action", {
                action: "navigate",
                url: result.url,
                title: result.title,
                browserProvider: "browser-use-cloud",
                browserUseSessionId: cloudSession.id,
                liveUrl: redactBrowserUseUrl(cloudSession.liveUrl),
              });
              if (result.isError) {
                const statusText =
                  typeof result.status === "number" ? `HTTP ${result.status}` : "unknown HTTP status";
                return {
                  success: false,
                  error: `Navigation failed with ${statusText}`,
                  browserProvider: "browser-use-cloud",
                  browserUseSession: {
                    id: cloudSession.id,
                    liveUrl: cloudSession.liveUrl,
                  },
                  ...result,
                };
              }
              return {
                success: true,
                browserProvider: "browser-use-cloud",
                browserUseSession: {
                  id: cloudSession.id,
                  liveUrl: cloudSession.liveUrl,
                },
                ...result,
              };
            } catch (error) {
              lastError = error;
              const retryable = this.isRetryableBrowserUseCloudSessionError(error);
              const pendingSessionId = cloudSession?.id || this.browserUseCloudSession?.id;
              await this.browserService.close().catch(() => {});
              if (pendingSessionId) {
                try {
                  await this.stopBrowserUseCloudSession();
                  this.daemon.logEvent(this.taskId, "browser_action", {
                    action: "browser_use_cloud_cleanup_after_failure",
                    browserUseSessionId: pendingSessionId,
                    retryable,
                  });
                } catch (stopError) {
                  this.daemon.logEvent(this.taskId, "browser_action", {
                    action: "browser_use_cloud_stop_failed",
                    browserUseSessionId: pendingSessionId,
                    error: stopError instanceof Error ? stopError.message : String(stopError),
                  });
                  return {
                    success: false,
                    error:
                      `Browser Use Cloud navigation failed and cleanup also failed. ` +
                      `Retry browser_close to stop the pending Browser Use session. Navigation error: ${
                        error instanceof Error ? error.message : String(error)
                      } Cleanup error: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
                    browserProvider: "browser-use-cloud",
                    browserUseSession: {
                      id: pendingSessionId,
                      pendingStop: true,
                    },
                    retryable: true,
                  };
                }
              }
              if (retryable && attempt === 0) {
                continue;
              }
              break;
            }
          }
          return {
            success: false,
            error: lastError instanceof Error ? lastError.message : String(lastError),
            browserProvider: "browser-use-cloud",
          };
        }
        let result;
        try {
          if (this.isSystemBrowserProfileRequest(input) && !this.hasExplicitRealBrowserConsent(input)) {
            return {
              success: false,
              error:
                "Explicit consent is required before reusing the system Chrome profile. Use the visible workspace Browser Workbench by default, or retry with confirm_real_browser_control=true only after the user approves real-browser profile control.",
              consentRequired: true,
            };
          }
          await this.ensureBrowserConfigured({
            headless: input?.force_headless === true ? true : input?.headless,
            profile: input?.profile,
            browser_channel: input?.browser_channel,
            debugger_url:
              this.browserState.browserProvider === "browser-use-cloud"
                ? null
                : this.browserState.debuggerUrl,
          });
          result = await this.browserService.navigate(input.url, input.wait_until || "load");
        } catch (error) {
          if (this.isProfileLaunchConflict(error)) {
            const conflictResult = this.profileLaunchConflictResult(error);
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "navigate",
              url: input?.url,
              success: false,
              browserMode: "external_profile",
              profileLaunchConflict: true,
            });
            return conflictResult;
          }
          throw error;
        }
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "navigate",
          url: result.url,
          title: result.title,
        });
        if (result.isError) {
          const statusText =
            typeof result.status === "number" ? `HTTP ${result.status}` : "unknown HTTP status";
          return {
            success: false,
            error: `Navigation failed with ${statusText}`,
            ...result,
          };
        }

        return {
          success: true,
          ...result,
        };
      }

      case "browser_screenshot": {
        const {
          filename,
          full_page,
          require_selector,
          disallow_url_contains,
          max_wait_ms,
          allow_consent,
        } = input || {};

        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          if (require_selector) {
            const waitResult = await this.browserWorkbenchService.waitForSelector(
              this.taskId,
              require_selector,
              max_wait_ms || 10000,
              this.getSessionId(input),
            );
            if (!waitResult?.success) {
              throw new Error(`Required selector not found: ${require_selector}`);
            }
          }
          const current = await this.browserWorkbenchService.getContent(
            this.taskId,
            this.getSessionId(input),
          );
          const currentUrl = typeof current?.url === "string" ? current.url : "";
          if (!allow_consent && currentUrl.includes("consent.google.com")) {
            throw new Error("Consent page detected; dismiss consent before taking screenshot.");
          }
          if (Array.isArray(disallow_url_contains) && disallow_url_contains.length > 0) {
            for (const fragment of disallow_url_contains) {
              if (fragment && currentUrl.includes(fragment)) {
                throw new Error(`Current URL matches disallowed fragment: ${fragment}`);
              }
            }
          }
          const result = await this.browserWorkbenchService.screenshot({
            taskId: this.taskId,
            sessionId: this.getSessionId(input),
            workspacePath: this.workspace.path,
            filename,
            fullPage: full_page === true,
          });
          if (result) {
            const fullPath = path.join(this.workspace.path, result.path);
            this.daemon.logEvent(this.taskId, "file_created", {
              path: result.path,
              type: "screenshot",
            });
            this.daemon.registerArtifact(this.taskId, fullPath, "image/png");
            return { success: true, ...result, visible: true };
          }
        }

        if (require_selector) {
          const waitResult = await this.browserService.waitForSelector(
            require_selector,
            max_wait_ms || 10000,
          );
          if (!waitResult.success) {
            throw new Error(`Required selector not found: ${require_selector}`);
          }
        }

        if (!allow_consent) {
          const currentUrl = await this.browserService.getCurrentUrl();
          if (currentUrl.includes("consent.google.com")) {
            throw new Error("Consent page detected; dismiss consent before taking screenshot.");
          }
        }

        if (Array.isArray(disallow_url_contains) && disallow_url_contains.length > 0) {
          const currentUrl = await this.browserService.getCurrentUrl();
          for (const fragment of disallow_url_contains) {
            if (fragment && currentUrl.includes(fragment)) {
              throw new Error(`Current URL matches disallowed fragment: ${fragment}`);
            }
          }
        }

        const result = await this.browserService.screenshot(filename, full_page || false);
        // Construct full path for the screenshot
        const fullPath = path.join(this.workspace.path, result.path);

        this.daemon.logEvent(this.taskId, "file_created", {
          path: result.path,
          type: "screenshot",
        });

        // Register as artifact so it can be sent back to the user
        this.daemon.registerArtifact(this.taskId, fullPath, "image/png");

        return result;
      }

      case "browser_snapshot": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.snapshot(
            this.taskId,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "snapshot",
              url: result.url,
              nodeCount: Array.isArray(result.nodes) ? result.nodes.length : undefined,
              visible: true,
            });
            return result;
          }
        }
        const content = await this.browserService.getContent();
        return {
          success: true,
          sessionId: "headless",
          tabId: "active",
          url: content.url,
          title: content.title,
          nodes: content.links.slice(0, 60).map((link) => ({
            role: "link",
            name: link.text,
            text: link.href,
          })),
          refSupport: false,
          message:
            "Headless snapshot is read-only and does not provide Browser V2 refs. Use selector-based tools or open a visible Browser Workbench session for ref actions.",
          consoleSummary: { count: 0, recent: [] },
          networkSummary: { count: 0, recent: [] },
        };
      }

      case "browser_tabs": {
        const tabs = this.browserWorkbenchService.getTabs(this.taskId, this.getSessionId(input));
        if (tabs.length > 0) return { success: true, tabs };
        return {
          success: true,
          tabs: [
            {
              tabId: "active",
              title: "",
              url: this.browserService.getUrl() || "",
              active: true,
              backend: "playwright-local",
            },
          ],
        };
      }

      case "browser_switch_tab": {
        const tabs = this.browserWorkbenchService.getTabs(this.taskId, this.getSessionId(input));
        const target = tabs.find((tab: Any) => tab.tabId === input?.tab_id);
        if (target?.active) return { success: true, tab: target };
        return {
          success: false,
          error: "Only the active visible workbench tab is available in this Browser V2 build.",
        };
      }

      case "browser_close_tab": {
        return {
          success: false,
          error: "Closing the active Browser Workbench tab from tools is disabled to avoid hiding the shared user/agent surface. Use browser_close to close background browser state.",
        };
      }

      case "browser_get_content": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.getContent(
            this.taskId,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "get_content",
              url: result.url,
              visible: true,
            });
            return { success: true, ...result };
          }
        }
        const result = await this.browserService.getContent();
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "get_content",
          url: result.url,
        });
        return result;
      }

      case "browser_click": {
        if (typeof input?.ref === "string" && input.ref.trim()) {
          if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
            const result = await this.browserWorkbenchService.clickRef(
              this.taskId,
              input.ref.trim(),
              this.getSessionId(input),
            );
            if (result) {
              this.daemon.logEvent(this.taskId, "browser_action", {
                action: "click_ref",
                success: result.success,
                visible: true,
              });
              return result;
            }
          }
          return {
            success: false,
            error: "browser_click ref requires an active visible Browser V2 snapshot. Call browser_snapshot and retry, or use selector.",
          };
        }
        if (typeof input?.selector !== "string" || !input.selector.trim()) {
          return { success: false, error: "selector or ref is required" };
        }
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.click(
            this.taskId,
            input.selector,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "click",
              selector: input.selector,
              success: result.success,
              visible: true,
            });
            return result;
          }
        }
        const result = await this.browserService.click(input.selector, this.getTimeoutMs(input));
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "click",
          selector: input.selector,
          success: result.success,
        });
        return result;
      }

      case "browser_hover": {
        if (typeof input?.ref === "string" && input.ref.trim()) {
          if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
            const result = await this.browserWorkbenchService.hoverRef(
              this.taskId,
              input.ref.trim(),
              this.getSessionId(input),
            );
            if (result) return result;
          }
          return {
            success: false,
            error: "browser_hover ref requires an active visible Browser V2 snapshot.",
          };
        }
        return {
          success: false,
          error: "browser_hover currently requires a Browser V2 ref from browser_snapshot.",
        };
      }

      case "browser_drag": {
        const fromRef = typeof input?.from_ref === "string" ? input.from_ref.trim() : "";
        const toRef = typeof input?.to_ref === "string" ? input.to_ref.trim() : "";
        if (!fromRef || !toRef) {
          return { success: false, error: "from_ref and to_ref are required" };
        }
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.dragRef(
            this.taskId,
            fromRef,
            toRef,
            this.getSessionId(input),
          );
          if (result) return result;
        }
        return {
          success: false,
          error: "browser_drag requires an active visible Browser V2 snapshot.",
        };
      }

      case "browser_fill": {
        if (typeof input?.ref === "string" && input.ref.trim()) {
          if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
            const result = await this.browserWorkbenchService.fillRef(
              this.taskId,
              input.ref.trim(),
              String(input.value ?? ""),
              this.getSessionId(input),
            );
            if (result) {
              this.daemon.logEvent(this.taskId, "browser_action", {
                action: "fill_ref",
                success: result.success,
                visible: true,
              });
              return result;
            }
          }
          return {
            success: false,
            error: "browser_fill ref requires an active visible Browser V2 snapshot. Call browser_snapshot and retry, or use selector.",
          };
        }
        if (typeof input?.selector !== "string" || !input.selector.trim()) {
          return { success: false, error: "selector or ref is required" };
        }
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.fill(
            this.taskId,
            input.selector,
            input.value,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "fill",
              selector: input.selector,
              success: result.success,
              visible: true,
            });
            return result;
          }
        }
        const result = await this.browserService.fill(
          input.selector,
          input.value,
          this.getTimeoutMs(input),
        );
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "fill",
          selector: input.selector,
          success: result.success,
        });
        return result;
      }

      case "browser_type": {
        if (typeof input?.ref === "string" && input.ref.trim()) {
          if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
            const result = await this.browserWorkbenchService.typeRef(
              this.taskId,
              input.ref.trim(),
              String(input.text ?? ""),
              this.getSessionId(input),
            );
            if (result) {
              this.daemon.logEvent(this.taskId, "browser_action", {
                action: "type_ref",
                success: result.success,
                visible: true,
              });
              return result;
            }
          }
          return {
            success: false,
            error: "browser_type ref requires an active visible Browser V2 snapshot. Call browser_snapshot and retry, or use selector.",
          };
        }
        if (typeof input?.selector !== "string" || !input.selector.trim()) {
          return { success: false, error: "selector or ref is required" };
        }
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.type(
            this.taskId,
            input.selector,
            input.text,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "type",
              selector: input.selector,
              success: result.success,
              visible: true,
            });
            return result;
          }
        }
        const result = await this.browserService.type(
          input.selector,
          input.text,
          input.delay || 50,
          this.getTimeoutMs(input),
        );
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "type",
          selector: input.selector,
          success: result.success,
        });
        return result;
      }

      case "browser_press": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.press(
            this.taskId,
            input.key,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "press",
              key: input.key,
              success: result.success,
              visible: true,
            });
            return result;
          }
        }
        const result = await this.browserService.press(input.key);
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "press",
          key: input.key,
          success: result.success,
        });
        return result;
      }

      case "browser_wait": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.waitForSelector(
            this.taskId,
            input.selector,
            input.timeout,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "wait",
              selector: input.selector,
              success: result.success,
              visible: true,
            });
            return result;
          }
        }
        const result = await this.browserService.waitForSelector(input.selector, input.timeout);
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "wait",
          selector: input.selector,
          success: result.success,
        });
        return result;
      }

      case "browser_scroll": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.scroll(
            this.taskId,
            input.direction,
            input.amount,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "scroll",
              direction: input.direction,
              visible: true,
            });
            return result;
          }
        }
        const result = await this.browserService.scroll(input.direction, input.amount);
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "scroll",
          direction: input.direction,
        });
        return result;
      }

      case "browser_select": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.select(
            this.taskId,
            input.selector,
            input.value,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "select",
              selector: input.selector,
              success: result.success,
              visible: true,
            });
            return result;
          }
        }
        const result = await this.browserService.select(input.selector, input.value);
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "select",
          selector: input.selector,
          success: result.success,
        });
        return result;
      }

      case "browser_get_text": {
        if (typeof input?.ref === "string" && input.ref.trim()) {
          if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
            const result = await this.browserWorkbenchService.getTextRef(
              this.taskId,
              input.ref.trim(),
              this.getSessionId(input),
            );
            if (result) return result;
          }
          return {
            success: false,
            error: "browser_get_text ref requires an active visible Browser V2 snapshot. Call browser_snapshot and retry, or use selector.",
          };
        }
        if (typeof input?.selector !== "string" || !input.selector.trim()) {
          return { success: false, error: "selector or ref is required" };
        }
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.getText(
            this.taskId,
            input.selector,
            this.getSessionId(input),
          );
          if (result) return result;
        }
        const result = await this.browserService.getText(input.selector);
        return result;
      }

      case "browser_upload_file": {
        const filePath = await this.resolveWorkspaceReadablePath(input?.file_path);
        await fs.access(filePath);
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.uploadFile({
            taskId: this.taskId,
            sessionId: this.getSessionId(input),
            filePath,
            ref: typeof input?.ref === "string" ? input.ref.trim() : undefined,
            selector: typeof input?.selector === "string" ? input.selector.trim() : undefined,
          });
          if (result) return result;
        }
        return {
          success: false,
          error: "browser_upload_file requires an active visible Browser V2 session and a file input ref or selector.",
        };
      }

      case "browser_handle_dialog": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.handleDialog({
            taskId: this.taskId,
            sessionId: this.getSessionId(input),
            accept: input?.accept !== false,
            promptText: typeof input?.prompt_text === "string" ? input.prompt_text : undefined,
          });
          if (result) return result;
        }
        return {
          success: false,
          error: "browser_handle_dialog requires an active visible Browser V2 session.",
        };
      }

      case "browser_console": {
        const result = this.browserWorkbenchService.getConsole(this.taskId, this.getSessionId(input));
        if (result) return result;
        return { success: true, entries: [] };
      }

      case "browser_network": {
        const result = this.browserWorkbenchService.getNetwork(this.taskId, this.getSessionId(input));
        if (result) return result;
        return { success: true, entries: [] };
      }

      case "browser_downloads": {
        const result = this.browserWorkbenchService.getDownloads(this.taskId, this.getSessionId(input));
        if (result) return result;
        return { success: true, entries: [] };
      }

      case "browser_storage": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.getStorage(
            this.taskId,
            this.getSessionId(input),
          );
          if (result) return result;
        }
        return {
          success: false,
          error: "browser_storage requires an active visible Browser V2 session.",
        };
      }

      case "browser_emulate": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.emulate({
            taskId: this.taskId,
            sessionId: this.getSessionId(input),
            width: typeof input?.width === "number" ? input.width : undefined,
            height: typeof input?.height === "number" ? input.height : undefined,
            deviceScaleFactor:
              typeof input?.device_scale_factor === "number" ? input.device_scale_factor : undefined,
            mobile: input?.mobile === true,
          });
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "emulate",
              width: result.width,
              height: result.height,
              mobile: result.mobile,
              visible: true,
            });
            return { ...result, visible: true };
          }
        }
        return {
          success: false,
          error: "browser_emulate requires an active visible Browser V2 session.",
        };
      }

      case "browser_trace_start": {
        const result = await this.browserWorkbenchService.traceStart(
          this.taskId,
          this.getSessionId(input),
        );
        return result || { success: false, error: "No active visible Browser V2 session" };
      }

      case "browser_trace_stop": {
        const result = await this.browserWorkbenchService.traceStop(
          this.taskId,
          this.getSessionId(input),
        );
        return result || { success: false, error: "No active visible Browser V2 session" };
      }

      case "browser_evaluate": {
        const script = typeof input?.script === "string" ? input.script : "";
        if (/(require\s*\(|child_process|execSync|exec\(|spawn\()/i.test(script)) {
          throw new Error(
            "browser_evaluate cannot run Node.js APIs. Use run_command for shell commands.",
          );
        }
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.evaluate(
            this.taskId,
            input.script,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "evaluate",
              success: result.success,
              visible: true,
            });
            return result;
          }
        }
        const result = await this.browserService.evaluate(input.script);
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "evaluate",
          success: result.success,
        });
        return result;
      }

      case "browser_back": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.goBack(
            this.taskId,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "back",
              url: result.url,
              visible: true,
            });
            return result;
          }
        }
        const result = await this.browserService.goBack();
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "back",
          url: result.url,
        });
        return result;
      }

      case "browser_forward": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.goForward(
            this.taskId,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "forward",
              url: result.url,
              visible: true,
            });
            return result;
          }
        }
        const result = await this.browserService.goForward();
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "forward",
          url: result.url,
        });
        return result;
      }

      case "browser_reload": {
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const result = await this.browserWorkbenchService.reload(
            this.taskId,
            this.getSessionId(input),
          );
          if (result) {
            this.daemon.logEvent(this.taskId, "browser_action", {
              action: "reload",
              url: result.url,
              visible: true,
            });
            return result;
          }
        }
        const result = await this.browserService.reload();
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "reload",
          url: result.url,
        });
        return result;
      }

      case "browser_save_pdf": {
        const result = await this.browserService.savePdf(input.filename);
        this.daemon.logEvent(this.taskId, "file_created", {
          path: result.path,
          type: "pdf",
        });
        return result;
      }

      case "browser_act_batch": {
        const actions = Array.isArray(input?.actions) ? input.actions : [];
        if (actions.length === 0) {
          return { success: false, error: "actions array is required and must not be empty" };
        }
        if (this.shouldPreferVisibleWorkbench(input) && this.hasVisibleWorkbenchSession(input)) {
          const results: Array<{ type: string; success: boolean; error?: string }> = [];
          for (let i = 0; i < actions.length; i++) {
            const act = actions[i] as Record<string, unknown>;
            const delayMs = typeof act.delay_ms === "number" && act.delay_ms > 0 ? act.delay_ms : 0;
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            const actType = String(act.type || "").toLowerCase();
            try {
              let result: Any = null;
              if (actType === "click") {
                result = await this.browserWorkbenchService.click(
                  this.taskId,
                  String(act.selector || ""),
                  this.getSessionId(input),
                );
              } else if (actType === "fill") {
                result = await this.browserWorkbenchService.fill(
                  this.taskId,
                  String(act.selector || ""),
                  String(act.value ?? ""),
                  this.getSessionId(input),
                );
              } else if (actType === "type") {
                result = await this.browserWorkbenchService.type(
                  this.taskId,
                  String(act.selector || ""),
                  String(act.text ?? ""),
                  this.getSessionId(input),
                );
              } else if (actType === "press") {
                result = await this.browserWorkbenchService.press(
                  this.taskId,
                  String(act.key || ""),
                  this.getSessionId(input),
                );
              } else if (actType === "wait") {
                result = await this.browserWorkbenchService.waitForSelector(
                  this.taskId,
                  String(act.selector || ""),
                  (act.timeout_ms as number) || 10000,
                  this.getSessionId(input),
                );
              } else if (actType === "scroll") {
                const direction =
                  act.direction === "up" ||
                  act.direction === "down" ||
                  act.direction === "top" ||
                  act.direction === "bottom"
                    ? act.direction
                    : "down";
                result = await this.browserWorkbenchService.scroll(
                  this.taskId,
                  direction,
                  typeof act.amount === "number" ? act.amount : undefined,
                  this.getSessionId(input),
                );
              } else {
                results.push({ type: actType, success: false, error: `Unknown action type: ${actType}` });
                break;
              }
              results.push({
                type: actType,
                success: result?.success !== false,
                error: result?.error,
              });
              if (result?.success === false) break;
            } catch (err) {
              results.push({
                type: actType,
                success: false,
                error: err instanceof Error ? err.message : String(err),
              });
              break;
            }
          }
          const allSuccess = results.every((r) => r.success);
          this.daemon.logEvent(this.taskId, "browser_action", {
            action: "act_batch",
            count: actions.length,
            completed: results.length,
            success: allSuccess,
            visible: true,
          });
          return {
            success: allSuccess,
            results,
            completed: results.length,
            total: actions.length,
          };
        }
        const results: Array<{ type: string; success: boolean; error?: string }> = [];
        const timeoutMs = this.getTimeoutMs(input);
        for (let i = 0; i < actions.length; i++) {
          const act = actions[i] as Record<string, unknown>;
          const delayMs = typeof act.delay_ms === "number" && act.delay_ms > 0 ? act.delay_ms : 0;
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
          const actType = String(act.type || "").toLowerCase();
          try {
            if (actType === "click") {
              const r = await this.browserService.click(
                String(act.selector || ""),
                (act.timeout_ms as number) || timeoutMs,
              );
              results.push({ type: "click", success: r.success, error: r.error });
              if (!r.success) break;
            } else if (actType === "fill") {
              const r = await this.browserService.fill(
                String(act.selector || ""),
                String(act.value ?? ""),
                (act.timeout_ms as number) || timeoutMs,
              );
              results.push({ type: "fill", success: r.success, error: r.error });
              if (!r.success) break;
            } else if (actType === "type") {
              const r = await this.browserService.type(
                String(act.selector || ""),
                String(act.text ?? ""),
                typeof act.delay_ms === "number" ? act.delay_ms : 50,
                (act.timeout_ms as number) || timeoutMs,
              );
              results.push({ type: "type", success: r.success, error: r.error });
              if (!r.success) break;
            } else if (actType === "press") {
              const r = await this.browserService.press(String(act.key || ""));
              results.push({ type: "press", success: r.success, error: (r as Any).error });
              if (!r.success) break;
            } else if (actType === "wait") {
              const r = await this.browserService.waitForSelector(
                String(act.selector || ""),
                (act.timeout_ms as number) || timeoutMs || 10000,
              );
              results.push({ type: "wait", success: r.success, error: (r as Any).error });
              if (!r.success) break;
            } else if (actType === "scroll") {
              const direction =
                act.direction === "up" ||
                act.direction === "down" ||
                act.direction === "top" ||
                act.direction === "bottom"
                  ? act.direction
                  : "down";
              const r = await this.browserService.scroll(
                direction,
                typeof act.amount === "number" ? act.amount : undefined,
              );
              results.push({ type: "scroll", success: (r as Any).success });
            } else {
              results.push({ type: actType, success: false, error: `Unknown action type: ${actType}` });
              break;
            }
          } catch (err) {
            results.push({
              type: actType,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
            break;
          }
        }
        const allSuccess = results.every((r) => r.success);
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "act_batch",
          count: actions.length,
          completed: results.length,
          success: allSuccess,
        });
        return {
          success: allSuccess,
          results,
          completed: results.length,
          total: actions.length,
        };
      }

      case "browser_close": {
        await this.browserService.close();
        const pendingCloudSessionId = this.browserUseCloudSession?.id;
        let stoppedCloudSession: BrowserUseBrowserSession | null = null;
        try {
          stoppedCloudSession = await this.stopBrowserUseCloudSession();
        } catch (error) {
          this.daemon.logEvent(this.taskId, "browser_action", {
            action: "browser_use_cloud_stop_failed",
            browserUseSessionId: pendingCloudSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            success: false,
            error:
              `Closed the local browser connection, but failed to stop Browser Use Cloud session ${
                pendingCloudSessionId || "(unknown)"
              }. Retry browser_close to stop the pending remote browser. ${error instanceof Error ? error.message : String(error)}`,
            browserProvider: "browser-use-cloud",
            browserUseSession: pendingCloudSessionId
              ? {
                  id: pendingCloudSessionId,
                  pendingStop: true,
                }
              : undefined,
            retryable: true,
          };
        }
        this.browserState = {
          headless: true,
          profile: null,
          browserChannel: "chromium",
          debuggerUrl: null,
          browserProvider: "local",
        };
        this.daemon.logEvent(this.taskId, "browser_action", {
          action: "close",
          browserUseCloudStopped: Boolean(stoppedCloudSession),
        });
        return { success: true };
      }

      default:
        throw new Error(`Unknown browser tool: ${toolName}`);
    }
  }

  /**
   * Check if a tool name is a browser tool
   */
  static isBrowserTool(toolName: string): boolean {
    return toolName.startsWith("browser_");
  }

  /**
   * Close the browser when done
   */
  async cleanup(): Promise<void> {
    await this.browserService.close();
    await this.stopBrowserUseCloudSession().catch(() => {});
  }
}
