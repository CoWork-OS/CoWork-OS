import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { BrowserTools } from "../browser-tools";
import { BrowserService } from "../../browser/browser-service";
import { GuardrailManager } from "../../../guardrails/guardrail-manager";
import { BuiltinToolsSettingsManager } from "../builtin-settings";
import { BrowserUseCloudClient } from "../../browser/browser-use-cloud-client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BrowserTools browser_navigate", () => {
  const workspace = {
    id: "workspace-1",
    path: "/tmp",
    permissions: {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: true,
    },
  } as Any;

  const makeTools = (browserWorkbenchService?: Any, workspaceOverride: Any = workspace) => {
    const daemon = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
      requestApproval: vi.fn(),
      recordSensitiveSourceRead: vi.fn(),
    } as Any;

    return {
      tools: new BrowserTools(workspaceOverride, daemon, "task-1", browserWorkbenchService),
      daemon,
    };
  };

  it("does not advertise Browser Use Cloud options when Cloud is not configured", () => {
    vi.spyOn(BrowserUseCloudClient, "resolveApiKey").mockReturnValue("");

    const navigateTool = BrowserTools.getToolDefinitions().find(
      (tool) => tool.name === "browser_navigate",
    );

    expect(navigateTool?.input_schema.properties).not.toHaveProperty("browser_provider");
    expect(navigateTool?.input_schema.properties).not.toHaveProperty("proxy_country_code");
  });

  it("advertises Browser Use Cloud options only when Cloud is configured", () => {
    vi.spyOn(BrowserUseCloudClient, "resolveApiKey").mockReturnValue("browser-use-key");

    const navigateTool = BrowserTools.getToolDefinitions().find(
      (tool) => tool.name === "browser_navigate",
    );

    expect(navigateTool?.input_schema.properties).toHaveProperty("browser_provider");
  });

  it("returns success=false when navigation receives HTTP 4xx/5xx", async () => {
    const { tools } = makeTools();

    (tools as Any).browserService = {
      navigate: vi.fn().mockResolvedValue({
        url: "https://example.com/paywall",
        title: "Forbidden",
        status: 403,
        isError: true,
      }),
      close: vi.fn(),
    };

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com/paywall",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 403");
  });

  it("returns success=true for successful navigation", async () => {
    const { tools } = makeTools();

    (tools as Any).browserService = {
      navigate: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example Domain",
        status: 200,
        isError: false,
      }),
      close: vi.fn(),
    };

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com",
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
  });

  it("does not treat WhatsApp's unsupported-browser page as usable access", async () => {
    const { tools } = makeTools();

    (tools as Any).browserService = {
      navigate: vi.fn().mockResolvedValue({
        url: "https://web.whatsapp.com/",
        title: "WhatsApp",
        status: 200,
        isError: false,
      }),
      getContent: vi.fn().mockResolvedValue({
        url: "https://web.whatsapp.com/",
        title: "WhatsApp",
        text: "WhatsApp works with Google Chrome 100+ To use WhatsApp, update Chrome.",
        links: [],
        forms: [],
      }),
      close: vi.fn(),
    };

    const result = await tools.executeTool("browser_navigate", {
      url: "https://web.whatsapp.com",
    });

    expect(result.success).toBe(false);
    expect(result.browserCompatibilityError).toBe(true);
    expect(result.error).toContain("supported Chrome 100+");
    expect(result.nextActions).toContain(
      "Use channel_list_chats with channel=whatsapp, then channel_history for the selected chat.",
    );
  });

  it("uses headless Playwright by default even when the visible workbench service is available", async () => {
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn().mockResolvedValue({
        success: true,
        url: "https://example.com",
        title: "Example Domain",
        status: null,
        visible: true,
      }),
    };
    const { tools } = makeTools(browserWorkbenchService);
    const headlessNavigate = vi.fn();
    (tools as Any).browserService = {
      navigate: headlessNavigate.mockResolvedValue({
        url: "https://example.com",
        title: "Example Domain",
        status: 200,
        isError: false,
      }),
      close: vi.fn(),
    };

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com",
    });

    expect(result.success).toBe(true);
    expect(browserWorkbenchService.navigate).not.toHaveBeenCalled();
    expect(headlessNavigate).toHaveBeenCalled();
  });

  it("keeps using an active visible workbench when profile options are supplied later", async () => {
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue({
        taskId: "task-1",
        sessionId: "default",
        webContentsId: 123,
      }),
      navigate: vi.fn().mockResolvedValue({
        success: true,
        url: "https://example.com/chat",
        title: "Signed in",
        status: null,
        visible: true,
      }),
    };
    const { tools } = makeTools(browserWorkbenchService);
    const headlessNavigate = vi.fn();
    (tools as Any).browserService = {
      navigate: headlessNavigate,
      close: vi.fn(),
    };

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com/chat",
      profile: "user",
      browser_channel: "chrome",
      confirm_real_browser_control: true,
    });

    expect(result.success).toBe(true);
    expect(result.visible).toBe(true);
    expect(browserWorkbenchService.navigate).toHaveBeenCalledWith({
      taskId: "task-1",
      sessionId: undefined,
      url: "https://example.com/chat",
      waitUntil: "load",
    });
    expect(headlessNavigate).not.toHaveBeenCalled();
  });

  it("uses the visible workbench when visible mode is enabled", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getComputerUseAutomationSettings").mockReturnValue({
      browserAutomationMode: "visible",
      nativeComputerUseMode: "background_first",
    });
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn().mockResolvedValue({
        success: true,
        url: "https://example.com",
        title: "Example Domain",
        status: null,
        visible: true,
      }),
    };
    const { tools } = makeTools(browserWorkbenchService);
    (tools as Any).browserService = {
      navigate: vi.fn(),
      close: vi.fn(),
    };

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com",
    });

    expect(result.success).toBe(true);
    expect(result.visible).toBe(true);
    expect(browserWorkbenchService.navigate).toHaveBeenCalledWith({
      taskId: "task-1",
      sessionId: undefined,
      url: "https://example.com",
      waitUntil: "load",
    });
    expect((tools as Any).browserService.navigate).not.toHaveBeenCalled();
  });

  it("asks before opening the visible workbench in ask mode", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getComputerUseAutomationSettings").mockReturnValue({
      browserAutomationMode: "ask",
      nativeComputerUseMode: "background_first",
    });
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn().mockResolvedValue({
        success: true,
        url: "https://example.com",
        title: "Example Domain",
        status: null,
        visible: true,
      }),
    };
    const { tools, daemon } = makeTools(browserWorkbenchService);
    daemon.requestApproval.mockResolvedValue(true);
    (tools as Any).browserService = {
      navigate: vi.fn(),
      close: vi.fn(),
    };

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com",
      visible: true,
    });

    expect(result.success).toBe(true);
    expect(result.visible).toBe(true);
    expect(daemon.requestApproval).toHaveBeenCalledWith(
      "task-1",
      "browser",
      expect.stringContaining("visible browser workbench"),
      expect.objectContaining({ kind: "browser_visible_workbench", tool: "browser_navigate" }),
      { allowAutoApprove: false },
    );
    expect(browserWorkbenchService.navigate).toHaveBeenCalled();
    expect((tools as Any).browserService.navigate).not.toHaveBeenCalled();
  });

  it("uses headless Playwright when visible workbench ask mode is denied", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getComputerUseAutomationSettings").mockReturnValue({
      browserAutomationMode: "ask",
      nativeComputerUseMode: "background_first",
    });
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn(),
    };
    const { tools, daemon } = makeTools(browserWorkbenchService);
    daemon.requestApproval.mockResolvedValue(false);
    (tools as Any).browserService = {
      navigate: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example Domain",
        status: 200,
        isError: false,
      }),
      close: vi.fn(),
    };

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com",
      visible: true,
    });

    expect(result.success).toBe(true);
    expect(browserWorkbenchService.navigate).not.toHaveBeenCalled();
    expect((tools as Any).browserService.navigate).toHaveBeenCalled();
  });

  it("uses headless Playwright when forced", async () => {
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn(),
    };
    const { tools } = makeTools(browserWorkbenchService);
    (tools as Any).browserService = {
      navigate: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example Domain",
        status: 200,
        isError: false,
      }),
      close: vi.fn(),
    };

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com",
      force_headless: true,
    });

    expect(result.success).toBe(true);
    expect(browserWorkbenchService.navigate).not.toHaveBeenCalled();
    expect((tools as Any).browserService.navigate).toHaveBeenCalled();
  });

  it("routes explicit Browser Use Cloud navigation through the remote CDP backend", async () => {
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn(),
    };
    const { tools, daemon } = makeTools(browserWorkbenchService);
    const cloudSession = {
      id: "browser-session-1",
      cdpUrl: "https://cdp.browser-use.example/session?apiKey=secret",
      liveUrl: "https://live.browser-use.example/session",
    };
    (tools as Any).browserUseCloudClient = {};
    (tools as Any).ensureBrowserUseCloudConfigured = vi.fn().mockImplementation(async () => {
      (tools as Any).browserService = {
        navigate: vi.fn().mockResolvedValue({
          url: "https://example.com",
          title: "Example Domain",
          status: 200,
          isError: false,
        }),
        close: vi.fn(),
      };
      return cloudSession;
    });

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com",
      browser_provider: "browser-use-cloud",
      proxy_country_code: "us",
    });

    expect(result).toMatchObject({
      success: true,
      browserProvider: "browser-use-cloud",
      browserUseSession: {
        id: "browser-session-1",
        liveUrl: "https://live.browser-use.example/session",
      },
    });
    expect(browserWorkbenchService.navigate).not.toHaveBeenCalled();
    expect((tools as Any).ensureBrowserUseCloudConfigured).toHaveBeenCalled();
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "browser_action",
      expect.objectContaining({
        action: "navigate",
        browserProvider: "browser-use-cloud",
        browserUseSessionId: "browser-session-1",
      }),
    );
  });

  it("falls back to local navigation when Browser Use Cloud is requested but unconfigured", async () => {
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn(),
    };
    const { tools, daemon } = makeTools(browserWorkbenchService);
    (tools as Any).getBrowserUseCloudClient = vi.fn().mockReturnValue(null);
    (tools as Any).ensureBrowserUseCloudConfigured = vi.fn();
    (tools as Any).browserService = {
      navigate: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example Domain",
        status: 200,
        isError: false,
      }),
      close: vi.fn(),
    };

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com",
      browser_provider: "browser-use-cloud",
    });

    expect(result.success).toBe(true);
    expect(result.browserProvider).toBeUndefined();
    expect((tools as Any).ensureBrowserUseCloudConfigured).not.toHaveBeenCalled();
    expect((tools as Any).browserService.navigate).toHaveBeenCalledWith(
      "https://example.com",
      "load",
    );
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "browser_action",
      expect.objectContaining({
        action: "browser_use_cloud_fallback_unconfigured",
        fallback: "local",
      }),
    );
  });

  it("rejects Browser Use Cloud navigation for local and private targets", async () => {
    const { tools } = makeTools({
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn(),
    });
    (tools as Any).browserUseCloudClient = {};
    (tools as Any).ensureBrowserUseCloudConfigured = vi.fn();

    const result = await tools.executeTool("browser_navigate", {
      url: "http://localhost:5173",
      browser_provider: "browser-use-cloud",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot be used for localhost");
    expect((tools as Any).ensureBrowserUseCloudConfigured).not.toHaveBeenCalled();
  });

  it("cleans up and retries once when a Browser Use Cloud CDP session is stale", async () => {
    const { tools } = makeTools({
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn(),
    });
    const stopBrowserSession = vi.fn().mockResolvedValue({ status: "stopped" });
    (tools as Any).browserUseCloudClient = {
      stopBrowserSession,
    };
    const sessions = [
      {
        id: "browser-session-stale",
        cdpUrl: "https://cdp.browser-use.example/stale",
      },
      {
        id: "browser-session-fresh",
        cdpUrl: "https://cdp.browser-use.example/fresh",
        liveUrl: "https://live.browser-use.example/fresh",
      },
    ];
    (tools as Any).ensureBrowserUseCloudConfigured = vi.fn().mockImplementation(async function () {
      const session = sessions.shift();
      (tools as Any).browserUseCloudSession = session;
      (tools as Any).browserService = {
        close: vi.fn().mockResolvedValue(undefined),
        navigate:
          session?.id === "browser-session-stale"
            ? vi.fn().mockRejectedValue(new Error("Target closed"))
            : vi.fn().mockResolvedValue({
                url: "https://example.com",
                title: "Example Domain",
                status: 200,
                isError: false,
              }),
      };
      return session;
    });

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com",
      browser_provider: "browser-use-cloud",
    });

    expect(result).toMatchObject({
      success: true,
      browserUseSession: {
        id: "browser-session-fresh",
      },
    });
    expect(stopBrowserSession).toHaveBeenCalledWith("browser-session-stale");
    expect((tools as Any).ensureBrowserUseCloudConfigured).toHaveBeenCalledTimes(2);
  });

  it("reports Browser Use Cloud navigation cleanup failure and preserves the pending session", async () => {
    const { tools } = makeTools({
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn(),
    });
    const stopBrowserSession = vi.fn().mockRejectedValue(new Error("stop failed"));
    (tools as Any).browserUseCloudClient = {
      stopBrowserSession,
    };
    (tools as Any).ensureBrowserUseCloudConfigured = vi.fn().mockImplementation(async () => {
      const session = {
        id: "browser-session-pending",
        cdpUrl: "https://cdp.browser-use.example/pending",
      };
      (tools as Any).browserUseCloudSession = session;
      (tools as Any).browserService = {
        close: vi.fn().mockResolvedValue(undefined),
        navigate: vi.fn().mockRejectedValue(new Error("Target closed")),
      };
      return session;
    });

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com",
      browser_provider: "browser-use-cloud",
    });

    expect(result).toMatchObject({
      success: false,
      retryable: true,
      browserUseSession: {
        id: "browser-session-pending",
        pendingStop: true,
      },
    });
    expect((tools as Any).browserUseCloudSession?.id).toBe("browser-session-pending");
  });

  it("starts a new Browser Use Cloud session when create-time screen options change", async () => {
    const { tools } = makeTools();
    const createBrowserSession = vi
      .fn()
      .mockResolvedValueOnce({
        id: "browser-session-1",
        cdpUrl: "https://cdp.browser-use.example/one",
      })
      .mockResolvedValueOnce({
        id: "browser-session-2",
        cdpUrl: "https://cdp.browser-use.example/two",
      });
    const stopBrowserSession = vi.fn().mockResolvedValue({ status: "stopped" });
    (tools as Any).browserUseCloudClient = {
      createBrowserSession,
      stopBrowserSession,
    };

    await (tools as Any).ensureBrowserUseCloudConfigured({
      browser_screen_width: 1280,
      browser_screen_height: 720,
      allow_resizing: true,
    });
    await (tools as Any).ensureBrowserUseCloudConfigured({
      browser_screen_width: 1280,
      browser_screen_height: 720,
      allow_resizing: true,
    });
    await (tools as Any).ensureBrowserUseCloudConfigured({
      browser_screen_width: 1440,
      browser_screen_height: 720,
      allow_resizing: true,
    });

    expect(createBrowserSession).toHaveBeenCalledTimes(2);
    expect(stopBrowserSession).toHaveBeenCalledWith("browser-session-1");
    expect((tools as Any).browserUseCloudSession?.id).toBe("browser-session-2");
  });

  it("stops an active Browser Use Cloud session on browser_close", async () => {
    const { tools, daemon } = makeTools();
    const stopBrowserSession = vi.fn().mockResolvedValue({
      id: "browser-session-1",
      status: "stopped",
    });
    (tools as Any).browserService = {
      close: vi.fn(),
    };
    (tools as Any).browserUseCloudClient = {
      stopBrowserSession,
    };
    (tools as Any).browserUseCloudSession = {
      id: "browser-session-1",
      cdpUrl: "https://cdp.browser-use.example/session",
    };

    const result = await tools.executeTool("browser_close", {});

    expect(result.success).toBe(true);
    expect(stopBrowserSession).toHaveBeenCalledWith("browser-session-1");
    expect((tools as Any).browserUseCloudSession).toBeNull();
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "browser_action",
      expect.objectContaining({
        action: "close",
        browserUseCloudStopped: true,
      }),
    );
  });

  it("returns retryable failure and keeps Browser Use Cloud session when browser_close cannot stop it", async () => {
    const { tools } = makeTools();
    const stopBrowserSession = vi.fn().mockRejectedValue(new Error("network down"));
    (tools as Any).browserService = {
      close: vi.fn(),
    };
    (tools as Any).browserUseCloudClient = {
      stopBrowserSession,
    };
    (tools as Any).browserUseCloudSession = {
      id: "browser-session-1",
      cdpUrl: "https://cdp.browser-use.example/session",
    };

    const result = await tools.executeTool("browser_close", {});

    expect(result).toMatchObject({
      success: false,
      retryable: true,
      browserUseSession: {
        id: "browser-session-1",
        pendingStop: true,
      },
    });
    expect((tools as Any).browserUseCloudSession?.id).toBe("browser-session-1");
  });

  it("returns a structured result when system Chrome profile launch is locked", async () => {
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn(),
    };
    const { tools } = makeTools(browserWorkbenchService);
    (tools as Any).ensureBrowserConfigured = vi
      .fn()
      .mockRejectedValue(new Error("Failed to create /Users/test/Chrome/SingletonLock"));
    (tools as Any).browserService = {
      navigate: vi.fn(),
      close: vi.fn(),
    };

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com/chat",
      profile: "user",
      browser_channel: "chrome",
      confirm_real_browser_control: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Chrome is already running with that profile");
    expect(result.retryableWithVisibleWorkbench).toBe(true);
    expect(result.nextActions).toEqual([
      "Use the visible Browser Workbench for this URL",
      "Attach to Chrome with browser_attach and debugger_url after enabling remote debugging",
    ]);
    expect(browserWorkbenchService.navigate).not.toHaveBeenCalled();
    expect((tools as Any).browserService.navigate).not.toHaveBeenCalled();
  });

  it("resets the local browser state when a changed profile cannot start", async () => {
    const { tools } = makeTools();
    const initSpy = vi
      .spyOn(BrowserService.prototype, "init")
      .mockRejectedValueOnce(new Error("Failed to create /Users/test/Chrome/SingletonLock"));

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com",
      profile: "user",
      browser_channel: "chrome",
      confirm_real_browser_control: true,
    });

    expect(result.success).toBe(false);
    expect((tools as Any).browserState).toEqual({
      headless: true,
      profile: null,
      browserChannel: "chromium",
      debuggerUrl: null,
      browserProvider: "local",
    });
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it("requires explicit consent before reusing the system Chrome profile", async () => {
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn(),
    };
    const { tools } = makeTools(browserWorkbenchService);
    (tools as Any).ensureBrowserConfigured = vi.fn();

    const result = await tools.executeTool("browser_navigate", {
      url: "https://example.com/chat",
      profile: "user",
      browser_channel: "chrome",
    });

    expect(result.success).toBe(false);
    expect(result.consentRequired).toBe(true);
    expect((tools as Any).ensureBrowserConfigured).not.toHaveBeenCalled();
  });

  it("preserves the managed session when external attachment is refused", async () => {
    const { tools } = makeTools();
    const original = { close: vi.fn() };
    (tools as Any).browserService = original;
    await expect(
      tools.executeTool("browser_attach", {
        debugger_url: "http://localhost:9222",
        confirm_real_browser_control: true,
      }),
    ).rejects.toThrow("External browser attachment");
    expect((tools as Any).browserService).toBe(original);
    expect(original.close).not.toHaveBeenCalled();
  });
  it("requires explicit consent before attaching to a real browser", async () => {
    const { tools } = makeTools();
    (tools as Any).browserService = {
      close: vi.fn(),
      init: vi.fn(),
    };

    const result = await tools.executeTool("browser_attach", {
      debugger_url: "http://localhost:9222",
    });

    expect(result.success).toBe(false);
    expect(result.consentRequired).toBe(true);
    expect((tools as Any).browserService.init).not.toHaveBeenCalled();
  });

  it("applies viewport emulation to the visible workbench and returns dimensions", async () => {
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue({
        taskId: "task-1",
        sessionId: "default",
        webContentsId: 123,
      }),
      emulate: vi.fn().mockResolvedValue({
        success: true,
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      }),
    };
    const { tools, daemon } = makeTools(browserWorkbenchService);

    const result = await tools.executeTool("browser_emulate", {
      width: 390,
      height: 844,
      device_scale_factor: 2,
      mobile: true,
    });

    expect(result).toMatchObject({
      success: true,
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
      visible: true,
    });
    expect(browserWorkbenchService.emulate).toHaveBeenCalledWith({
      taskId: "task-1",
      sessionId: undefined,
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "browser_action",
      expect.objectContaining({
        action: "emulate",
        width: 390,
        height: 844,
        mobile: true,
        visible: true,
      }),
    );
  });

  it("enforces guardrails before visible workbench navigation", async () => {
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue(null),
      navigate: vi.fn(),
    };
    const { tools } = makeTools(browserWorkbenchService);
    vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValueOnce(false);
    vi.spyOn(GuardrailManager, "loadSettings").mockReturnValueOnce({
      allowedDomains: ["allowed.example"],
    } as Any);

    await expect(
      tools.executeTool("browser_navigate", {
        url: "https://blocked.example",
      }),
    ).rejects.toThrow("Domain not allowed");
    expect(browserWorkbenchService.navigate).not.toHaveBeenCalled();
  });

  it("routes ref clicks to the visible Browser V2 session", async () => {
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue({
        taskId: "task-1",
        sessionId: "default",
        webContentsId: 123,
      }),
      clickRef: vi.fn().mockResolvedValue({
        success: true,
        ref: "b2:snap:1",
      }),
    };
    const { tools } = makeTools(browserWorkbenchService);

    const result = await tools.executeTool("browser_click", {
      ref: "b2:snap:1",
    });

    expect(result.success).toBe(true);
    expect(browserWorkbenchService.clickRef).toHaveBeenCalledWith("task-1", "b2:snap:1", undefined);
  });

  it("rejects browser_upload_file when a workspace path resolves outside through a symlink", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-upload-workspace-"));
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-upload-external-"));
    const externalFile = path.join(externalRoot, "secret.txt");
    const linkPath = path.join(workspaceRoot, "upload.txt");
    fs.writeFileSync(externalFile, "secret");
    try {
      fs.symlinkSync(externalFile, linkPath);
    } catch {
      return;
    }

    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue({
        taskId: "task-1",
        sessionId: "default",
        webContentsId: 123,
      }),
      uploadFile: vi.fn(),
    };
    const { tools } = makeTools(browserWorkbenchService, {
      ...workspace,
      path: workspaceRoot,
      permissions: {
        ...workspace.permissions,
        allowedPaths: [],
        unrestrictedFileAccess: false,
      },
    });

    await expect(
      tools.executeTool("browser_upload_file", {
        file_path: "upload.txt",
        selector: "input[type=file]",
      }),
    ).rejects.toThrow("Read permission not granted");
    expect(browserWorkbenchService.uploadFile).not.toHaveBeenCalled();
  });

  it("does not emit fake Browser V2 refs for headless snapshot fallback", async () => {
    const { tools } = makeTools({
      getSession: vi.fn().mockReturnValue(null),
    });
    (tools as Any).browserService = {
      getContent: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example",
        links: [{ text: "Docs", href: "https://example.com/docs" }],
      }),
    };

    const result = await tools.executeTool("browser_snapshot", {});

    expect(result.success).toBe(true);
    expect(result.refSupport).toBe(false);
    expect(result.nodes[0].ref).toBeUndefined();
  });

  it("lists buttons and inputs with usable selectors in the headless snapshot", async () => {
    const { tools } = makeTools({
      getSession: vi.fn().mockReturnValue(null),
    });
    (tools as Any).browserService = {
      getContent: vi.fn().mockResolvedValue({
        url: "https://example.com/signup",
        title: "Sign up",
        text: "Create your account",
        links: [{ text: "Docs", href: "https://example.com/docs" }],
        forms: [],
        interactive: [
          { role: "textbox", name: "Email", selector: "#email", type: "email" },
          { role: "button", name: "Create account", selector: 'button[name="create"]' },
          { role: "link", name: "Docs", selector: 'a[href="/docs"]', href: "/docs" },
        ],
      }),
    };

    const result = await tools.executeTool("browser_snapshot", {});

    expect(result.refSupport).toBe(false);
    expect(result.nodes).toEqual([
      { role: "textbox", name: "Email", selector: "#email", type: "email" },
      { role: "button", name: "Create account", selector: 'button[name="create"]' },
      { role: "link", name: "Docs", selector: 'a[href="/docs"]', href: "/docs" },
    ]);
    expect(result.nodes.every((node: Any) => node.ref === undefined)).toBe(true);
    expect(result.message).toContain("selector");
  });

  it("passes pagination and scope options to the headless content reader", async () => {
    const { tools } = makeTools({
      getSession: vi.fn().mockReturnValue(null),
    });
    const getContent = vi.fn().mockResolvedValue({
      url: "https://example.com/report",
      title: "Report",
      textScope: "page",
      offset: 10_000,
      totalChars: 30_000,
      truncated: true,
      nextOffset: 15_000,
      text: "...",
      links: [],
      forms: [],
      interactive: [],
    });
    (tools as Any).browserService = { getContent };

    const result = await tools.executeTool("browser_get_content", {
      offset: 10_000,
      max_chars: 5_000,
      scope: "page",
    });

    expect(getContent).toHaveBeenCalledWith({ offset: 10_000, maxChars: 5_000, scope: "page" });
    expect(result).toMatchObject({ truncated: true, nextOffset: 15_000 });
  });

  it("paginates visible workbench content when max_chars is requested", async () => {
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue({
        taskId: "task-1",
        sessionId: "default",
        webContentsId: 123,
      }),
      getContent: vi.fn().mockResolvedValue({
        url: "https://example.com/long",
        title: "Long page",
        text: "x".repeat(12_000),
        links: [],
        forms: [],
      }),
    };
    const { tools, daemon } = makeTools(browserWorkbenchService);

    const result = await tools.executeTool("browser_get_content", {
      offset: 4_000,
      max_chars: 5_000,
    });
    // Page text taints the task, so a later agent memory write goes to the inbox.
    expect(daemon.recordSensitiveSourceRead).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ path: "https://example.com/long", trustLevel: "untrusted" }),
    );

    expect(result).toMatchObject({
      success: true,
      offset: 4_000,
      totalChars: 12_000,
      truncated: true,
      nextOffset: 9_000,
    });
    expect(result.text).toHaveLength(5_000);
  });

  it("documents pagination options on browser_get_content", () => {
    const getContentTool = BrowserTools.getToolDefinitions().find(
      (tool) => tool.name === "browser_get_content",
    );

    expect(getContentTool?.input_schema.properties).toHaveProperty("offset");
    expect(getContentTool?.input_schema.properties).toHaveProperty("max_chars");
    expect(getContentTool?.input_schema.properties).toHaveProperty("scope");
  });

  const visibleSession = () =>
    vi.fn().mockReturnValue({ taskId: "task-1", sessionId: "default", webContentsId: 123 });

  it("passes snapshot paging and filter options to the visible workbench", async () => {
    const browserWorkbenchService = {
      getSession: visibleSession(),
      snapshot: vi.fn().mockResolvedValue({
        success: true,
        url: "https://shop.example/",
        nodes: [],
        truncated: true,
        nextOffset: 280,
      }),
    };
    const { tools } = makeTools(browserWorkbenchService);

    const result = await tools.executeTool("browser_snapshot", {
      offset: 140,
      limit: 140,
      interactive_only: true,
      query: "cart",
    });

    expect(result).toMatchObject({ truncated: true, nextOffset: 280 });
    expect(browserWorkbenchService.snapshot).toHaveBeenCalledWith("task-1", undefined, {
      offset: 140,
      limit: 140,
      interactiveOnly: true,
      query: "cart",
    });
  });

  it("runs visible act_batch actions by ref and stops when the workbench returns nothing", async () => {
    const browserWorkbenchService = {
      getSession: visibleSession(),
      clickRef: vi.fn().mockResolvedValue({ success: true }),
      fillRef: vi.fn().mockResolvedValue({ success: true, value: "a@b.co" }),
      click: vi.fn().mockResolvedValue(null),
    };
    const { tools } = makeTools(browserWorkbenchService);

    const result = await tools.executeTool("browser_act_batch", {
      actions: [
        { type: "fill", ref: "b2:snap-1:2", value: "a@b.co" },
        { type: "click", ref: "b2:snap-1:3" },
        { type: "click", selector: "text=Continue" },
        { type: "click", selector: "text=Never reached" },
      ],
    });

    expect(browserWorkbenchService.fillRef).toHaveBeenCalledWith(
      "task-1",
      "b2:snap-1:2",
      "a@b.co",
      undefined,
    );
    expect(browserWorkbenchService.clickRef).toHaveBeenCalledWith(
      "task-1",
      "b2:snap-1:3",
      undefined,
    );
    expect(result.success).toBe(false);
    expect(result.completed).toBe(3);
    expect(result.results[2]).toMatchObject({
      success: false,
      error: expect.stringContaining("no longer available"),
    });
    expect(browserWorkbenchService.click).toHaveBeenCalledTimes(1);
  });

  it("hovers by selector in the visible workbench", async () => {
    const browserWorkbenchService = {
      getSession: visibleSession(),
      hover: vi.fn().mockResolvedValue({ success: true, x: 10, y: 20 }),
    };
    const { tools } = makeTools(browserWorkbenchService);

    const result = await tools.executeTool("browser_hover", { selector: "text=Menu" });

    expect(result).toMatchObject({ success: true });
    expect(browserWorkbenchService.hover).toHaveBeenCalledWith("task-1", "text=Menu", undefined);
  });

  it("teaches observe -> act -> verify with refs in the visible browser tool descriptions", () => {
    const definitions = BrowserTools.getToolDefinitions();
    const descriptionOf = (name: string) =>
      definitions.find((tool) => tool.name === name)?.description || "";

    expect(descriptionOf("browser_snapshot")).toContain("observe -> act -> verify");
    expect(descriptionOf("browser_snapshot")).toContain("snapshot again");
    expect(descriptionOf("browser_click")).toContain("preferably by ref from browser_snapshot");
    expect(descriptionOf("browser_click")).toContain("call browser_snapshot to verify");
    expect(descriptionOf("browser_fill")).toContain("success:false means the value did not take");
  });
});

describe("BrowserTools headless browser capabilities", () => {
  const workspace = {
    id: "workspace-1",
    path: "/tmp",
    permissions: { read: true, write: true, delete: false, network: true, shell: false },
  } as Any;

  const makeHeadlessTools = (browserService: Any, workspaceOverride: Any = workspace) => {
    const daemon = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
      requestApproval: vi.fn(),
    } as Any;
    const browserWorkbenchService = {
      getSession: vi.fn().mockReturnValue(null),
      getTabs: vi.fn().mockReturnValue([]),
      getConsole: vi.fn().mockReturnValue(null),
      getNetwork: vi.fn().mockReturnValue(null),
      getDownloads: vi.fn().mockReturnValue(null),
      uploadFile: vi.fn(),
      handleDialog: vi.fn(),
    };
    const tools = new BrowserTools(
      workspaceOverride,
      daemon,
      "task-1",
      browserWorkbenchService as Any,
    );
    (tools as Any).browserService = { hasSession: () => true, close: vi.fn(), ...browserService };
    return { tools, daemon, browserWorkbenchService };
  };

  it("lists, switches and closes headless tabs", async () => {
    const tabs = [
      { tabId: "tab-1", url: "https://example.com/", title: "Home", active: false },
      { tabId: "tab-2", url: "https://example.com/popup", title: "Popup", active: true },
    ];
    const browserService = {
      listTabs: vi.fn().mockResolvedValue(tabs),
      switchTab: vi.fn().mockResolvedValue({ success: true, tab: { ...tabs[0], active: true } }),
      closeTab: vi.fn().mockResolvedValue({ success: true, closedTabId: "tab-2" }),
    };
    const { tools } = makeHeadlessTools(browserService);

    const listed = await tools.executeTool("browser_tabs", {});
    expect(listed).toMatchObject({ success: true, tabs });

    const switched = await tools.executeTool("browser_switch_tab", { tab_id: "tab-1" });
    expect(browserService.switchTab).toHaveBeenCalledWith("tab-1");
    expect(switched).toMatchObject({ success: true, tab: { tabId: "tab-1", active: true } });

    const closed = await tools.executeTool("browser_close_tab", { tab_id: "tab-2" });
    expect(browserService.closeTab).toHaveBeenCalledWith("tab-2");
    expect(closed).toMatchObject({ success: true, closedTabId: "tab-2" });
  });

  it("arms the next headless dialog decision instead of requiring the visible workbench", async () => {
    const armNextDialog = vi.fn().mockReturnValue({
      nextDialog: { action: "accept", promptText: "my-project" },
      lastDialog: { type: "prompt", message: "Name?", action: "dismissed", timestamp: 1 },
    });
    const { tools, browserWorkbenchService } = makeHeadlessTools({ armNextDialog });

    const result = await tools.executeTool("browser_handle_dialog", {
      accept: true,
      prompt_text: "my-project",
    });

    expect(browserWorkbenchService.handleDialog).not.toHaveBeenCalled();
    expect(armNextDialog).toHaveBeenCalledWith({ accept: true, promptText: "my-project" });
    expect(result).toMatchObject({
      success: true,
      nextDialog: { action: "accept", promptText: "my-project" },
    });
    expect(result.message).toContain("repeat");

    await tools.executeTool("browser_handle_dialog", { accept: false });
    expect(armNextDialog).toHaveBeenLastCalledWith({ accept: false });
  });

  it("stops a headless batch when a confirm dialog was dismissed", async () => {
    const click = vi.fn().mockResolvedValue({
      success: true,
      dialog: { type: "confirm", message: "Delete?", action: "dismissed", timestamp: 1 },
    });
    const fill = vi.fn();
    const { tools } = makeHeadlessTools({ click, fill });

    const result = await tools.executeTool("browser_act_batch", {
      actions: [
        { type: "click", selector: "#delete" },
        { type: "fill", selector: "#name", value: "x" },
      ],
    });

    expect(fill).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.results[0]).toMatchObject({
      type: "click",
      dialog: { type: "confirm", action: "dismissed" },
    });
    expect(result.error).toContain("browser_handle_dialog");
  });

  it("lists headless downloads saved into the workspace", async () => {
    const entries = [
      {
        id: "download-1",
        status: "saved",
        suggestedFilename: "report.csv",
        url: "https://example.com/export",
        path: "downloads/report.csv",
        size: 8,
        timestamp: 1,
      },
    ];
    const { tools } = makeHeadlessTools({ listDownloads: vi.fn().mockReturnValue(entries) });

    const result = await tools.executeTool("browser_downloads", {});

    expect(result).toMatchObject({ success: true, directory: "downloads", entries });
    const definition = BrowserTools.getToolDefinitions().find(
      (tool) => tool.name === "browser_downloads",
    );
    expect(definition?.description).toContain("downloads/");
  });

  describe("headless browser_upload_file", () => {
    let workspaceRoot: string;
    let externalRoot: string;
    let uploadWorkspace: Any;

    const setup = () => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-upload-headless-ws-"));
      externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-upload-headless-ext-"));
      uploadWorkspace = {
        ...workspace,
        path: workspaceRoot,
        permissions: { ...workspace.permissions, allowedPaths: [], unrestrictedFileAccess: false },
      };
    };
    const cleanup = () => {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(externalRoot, { recursive: true, force: true });
    };

    it("uploads a workspace file into a headless file input", async () => {
      setup();
      try {
        fs.writeFileSync(path.join(workspaceRoot, "resume.pdf"), "pdf");
        const uploadFile = vi.fn().mockResolvedValue({ success: true, selector: "#cv" });
        const { tools, browserWorkbenchService } = makeHeadlessTools(
          { uploadFile },
          uploadWorkspace,
        );

        const result = await tools.executeTool("browser_upload_file", {
          file_path: "resume.pdf",
          selector: "#cv",
        });

        expect(result.success).toBe(true);
        expect(browserWorkbenchService.uploadFile).not.toHaveBeenCalled();
        expect(uploadFile).toHaveBeenCalledWith(
          "#cv",
          fs.realpathSync(path.join(workspaceRoot, "resume.pdf")),
          undefined,
        );
      } finally {
        cleanup();
      }
    });

    it("asks before uploading a file outside the workspace and honours a denial", async () => {
      setup();
      try {
        const externalFile = path.join(externalRoot, "id-card.png");
        fs.writeFileSync(externalFile, "png");
        const uploadFile = vi.fn().mockResolvedValue({ success: true });
        const { tools, daemon } = makeHeadlessTools({ uploadFile }, uploadWorkspace);
        daemon.requestApproval.mockResolvedValue(false);

        await expect(
          tools.executeTool("browser_upload_file", { file_path: externalFile, selector: "#id" }),
        ).rejects.toThrow("Read permission not granted");
        expect(daemon.requestApproval).toHaveBeenCalled();
        expect(uploadFile).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it("rejects a symlink that escapes the workspace before touching the page", async () => {
      setup();
      try {
        const externalFile = path.join(externalRoot, "secret.txt");
        fs.writeFileSync(externalFile, "secret");
        try {
          fs.symlinkSync(externalFile, path.join(workspaceRoot, "upload.txt"));
        } catch {
          return;
        }
        const uploadFile = vi.fn();
        const { tools } = makeHeadlessTools({ uploadFile }, uploadWorkspace);

        await expect(
          tools.executeTool("browser_upload_file", { file_path: "upload.txt", selector: "#f" }),
        ).rejects.toThrow("Read permission not granted");
        expect(uploadFile).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it("requires a selector for headless uploads", async () => {
      setup();
      try {
        fs.writeFileSync(path.join(workspaceRoot, "resume.pdf"), "pdf");
        const uploadFile = vi.fn();
        const { tools } = makeHeadlessTools({ uploadFile }, uploadWorkspace);

        const result = await tools.executeTool("browser_upload_file", {
          file_path: "resume.pdf",
          ref: "b2:snap:4",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("selector");
        expect(uploadFile).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });
  });

  it("returns captured headless console and network entries", async () => {
    const consoleLog = {
      entries: [{ level: "error", text: "boom", timestamp: 1 }],
      dropped: 0,
    };
    const networkLog = {
      entries: [{ url: "https://example.com/api", status: 500, timestamp: 1 }],
      dropped: 0,
    };
    const { tools } = makeHeadlessTools({
      getConsoleLog: vi.fn().mockReturnValue(consoleLog),
      getNetworkLog: vi.fn().mockReturnValue(networkLog),
    });

    expect(await tools.executeTool("browser_console", {})).toMatchObject({
      success: true,
      ...consoleLog,
    });
    expect(await tools.executeTool("browser_network", {})).toMatchObject({
      success: true,
      ...networkLog,
    });
  });

  it("does not report an empty console as success when no browser was opened", async () => {
    const { tools } = makeHeadlessTools({
      hasSession: () => false,
      getConsoleLog: vi.fn().mockReturnValue({ entries: [], dropped: 0 }),
      getNetworkLog: vi.fn().mockReturnValue({ entries: [], dropped: 0 }),
    });

    const consoleResult = await tools.executeTool("browser_console", {});
    const networkResult = await tools.executeTool("browser_network", {});

    expect(consoleResult.success).toBe(false);
    expect(consoleResult.error).toContain("No browser session");
    expect(networkResult.success).toBe(false);
  });

  it("summarizes captured diagnostics in the headless snapshot", async () => {
    const { tools } = makeHeadlessTools({
      getContent: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example",
        links: [],
        interactive: [],
      }),
      getDiagnosticsSummary: vi.fn().mockReturnValue({
        console: { count: 2, recent: ["boom"] },
        network: { count: 1, recent: ["500 https://example.com/api"] },
      }),
    });

    const result = await tools.executeTool("browser_snapshot", {});

    expect(result.consoleSummary).toEqual({ count: 2, recent: ["boom"] });
    expect(result.networkSummary).toEqual({ count: 1, recent: ["500 https://example.com/api"] });
  });

  it("reports requested and executed counts when action selection runs only a prefix", async () => {
    const click = vi.fn().mockResolvedValue({ success: true });
    const fill = vi.fn().mockResolvedValue({ success: true });
    const { tools } = makeHeadlessTools({ click, fill });
    const actions = [
      { type: "click", selector: "#open" },
      { type: "fill", selector: "#name", value: "x" },
      { type: "click", selector: "#save" },
    ];
    vi.spyOn(tools as Any, "selectBrowserActionsWithJev").mockResolvedValue(actions.slice(0, 1));

    const result = await tools.executeTool("browser_act_batch", { actions });

    expect(click).toHaveBeenCalledTimes(1);
    expect(fill).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      total: 3,
      requested: 3,
      completed: 1,
      deferred: 2,
      incomplete: true,
    });
    expect(result.message).toContain("1 of 3");
  });

  it("describes headless popup handling on the tab tools", () => {
    const definitions = BrowserTools.getToolDefinitions();
    const descriptionOf = (name: string) =>
      definitions.find((tool) => tool.name === name)?.description;
    expect(descriptionOf("browser_tabs")).toContain("popup");
    expect(descriptionOf("browser_switch_tab")).toContain("browser_tabs");
    expect(descriptionOf("browser_close_tab")).toContain("headless");
  });
});

describe("BrowserTools current effect authority", () => {
  const workspace = {
    id: "scope",
    path: "/tmp",
    permissions: {
      read: true,
      write: false,
      delete: false,
      shell: false,
      network: true,
    },
  } as Any;
  it("refuses navigation when asynchronous setup changes workspace authority", async () => {
    const daemon = { logEvent: vi.fn(), registerArtifact: vi.fn() } as Any;
    const tools = new BrowserTools(structuredClone(workspace), daemon, "task-1");
    const navigate = vi.fn();
    (tools as Any).browserService = { navigate };
    vi.spyOn(tools as Any, "ensureVisibleNavigationAllowed").mockImplementation(async () => {
      tools.setWorkspace({
        ...workspace,
        permissions: { ...workspace.permissions, network: false },
      });
      return "https://example.com";
    });
    vi.spyOn(tools as Any, "shouldUseVisibleWorkbenchForNavigation").mockResolvedValue(true);
    const visibleNavigate = vi.spyOn((tools as Any).browserWorkbenchService, "navigate");
    await expect(
      tools.executeTool("browser_navigate", { url: "https://example.com" }),
    ).rejects.toThrow("Browser authority changed");
    expect(navigate).not.toHaveBeenCalled();
    expect(visibleNavigate).not.toHaveBeenCalled();
  });
  it("fails closed for a governed task without responsibility storage", async () => {
    const daemon = {
      logEvent: vi.fn(),
      getTaskById: vi.fn().mockResolvedValue({
        agentConfig: { responsibilityRun: { responsibilityId: "r" } },
      }),
    } as Any;
    const tools = new BrowserTools(workspace, daemon, "task-1");
    const click = vi.fn().mockResolvedValue({ success: true });
    (tools as Any).browserService = { click };
    await expect(tools.executeTool("browser_click", { selector: "button" })).rejects.toThrow(
      "Responsibility policy storage is unavailable",
    );
    expect(click).not.toHaveBeenCalled();
  });
  it("stops a batch when a durable stop intent appears after its first effect", async () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE tasks(id TEXT PRIMARY KEY,workspace_id TEXT,parent_task_id TEXT,agent_config TEXT);CREATE TABLE bot_task_stop_intents(task_id TEXT PRIMARY KEY,active INTEGER)",
    );
    db.prepare("INSERT INTO tasks VALUES(?,?,NULL,NULL)").run("task-1", workspace.id);
    const daemon = { logEvent: vi.fn(), getDatabase: () => db } as Any;
    const tools = new BrowserTools(workspace, daemon, "task-1");
    const click = vi.fn().mockImplementation(async () => {
      db.prepare("INSERT OR IGNORE INTO bot_task_stop_intents VALUES (?,1)").run("task-1");
      return { success: true };
    });
    (tools as Any).browserService = { click };
    vi.spyOn(tools as Any, "selectBrowserActionsWithJev").mockResolvedValue(null);
    vi.spyOn(tools as Any, "shouldPreferVisibleWorkbench").mockReturnValue(false);
    try {
      const result = await tools.executeTool("browser_act_batch", {
        actions: [
          { type: "click", selector: "#first" },
          { type: "click", selector: "#second", delay_ms: 1 },
        ],
      });
      expect(result.success).toBe(false);
      expect(result.results[1].error).toContain("persisted stop request");
      expect(click).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });
});
