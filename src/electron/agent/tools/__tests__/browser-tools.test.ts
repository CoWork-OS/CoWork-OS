import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { BrowserTools } from "../browser-tools";
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
    expect(browserWorkbenchService.navigate).not.toHaveBeenCalled();
    expect((tools as Any).browserService.navigate).not.toHaveBeenCalled();
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
    expect(browserWorkbenchService.clickRef).toHaveBeenCalledWith(
      "task-1",
      "b2:snap:1",
      undefined,
    );
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
});
