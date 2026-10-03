import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../registry";
import { MCPClientManager } from "../../../mcp/client/MCPClientManager";
import { MCPSettingsManager } from "../../../mcp/settings";

afterEach(() => vi.restoreAllMocks());

describe("MCP elicitation task approval", () => {
  it.each([true, false])(
    "requires explicit task approval and preserves decision %s",
    async (approved) => {
      const controller = new AbortController();
      const requestApproval = vi.fn().mockResolvedValue(approved);
      const registry = Object.create(ToolRegistry.prototype) as Any;
      Object.assign(registry, {
        taskId: "calculator-test",
        daemon: { requestApproval },
        evaluateMcpEndpointNetworkPolicy: () => null,
        getMcpServerName: () => "codex-cu",
        formatMCPResult: async (result: Any) => result,
      });
      vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({
        toolNamePrefix: "mcp_",
      } as Any);
      const callTool = vi.fn(async (_name, _input, options) => {
        expect(options.signal).toBe(controller.signal);
        return options.onElicitation({ message: 'Allow Computer Use to use "Calculator"?' });
      });
      vi.spyOn(MCPClientManager, "getInstance").mockReturnValue({
        hasTool: () => true,
        getAllTools: () => [{ name: "js" }],
        callTool,
      } as Any);
      const result = await registry.tryExecuteMCPTool("mcp_js", {}, { signal: controller.signal });
      expect(result).toEqual(approved ? { action: "accept", content: {} } : { action: "decline" });
      expect(requestApproval).toHaveBeenCalledWith(
        "calculator-test",
        "external_service",
        'Allow Computer Use to use "Calculator"?',
        expect.objectContaining({ tool: "mcp_js", serverName: "codex-cu" }),
        { allowAutoApprove: false, requireExplicitApproval: true, signal: controller.signal },
      );
    },
  );
});

describe("Codex app consent scopes", () => {
  function setup() {
    let authority: string | null = "authority-1";
    const daemon = {
      requestApproval: vi.fn().mockResolvedValue(true),
      canAutoApproveComputerUseApp: vi.fn().mockResolvedValue(false),
      getTaskConsentAuthority: vi.fn(async () => authority),
      evaluateToolPermission: vi.fn().mockResolvedValue({ decision: "ask" }),
    };
    const server = {
      id: "codex",
      name: "codex-cu",
      transport: "stdio",
      enabled: true,
      args: ["/local/@oai/cua-repl/bin/cua-repl.mjs"],
      env: { CUA_REPL_ENABLED_SURFACES: "computer" },
    };
    vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({
      toolNamePrefix: "mcp_",
      servers: [server],
    } as Any);
    const registry = Object.create(ToolRegistry.prototype) as Any;
    Object.assign(registry, {
      taskId: "task-1",
      daemon,
      evaluateMcpEndpointNetworkPolicy: () => null,
      getMcpServerName: () => "codex-cu",
      formatMCPResult: async (result: Any) => result,
    });
    let appId = "com.apple.calculator";
    const manager = {
      hasTool: () => true,
      getServerIdForTool: () => "codex",
      getAllTools: () => [{ name: "js" }],
      callTool: vi.fn(async (_name, _input, options) =>
        options.onElicitation({
          message: 'Allow Computer Use to use "Calculator"?',
          computerUseApp: { id: appId, name: "Calculator" },
        }),
      ),
    };
    vi.spyOn(MCPClientManager, "getInstance").mockReturnValue(manager as Any);
    const call = (signal?: AbortSignal) =>
      registry.tryExecuteMCPTool("mcp_js", { code: "await app.getAXState()" }, { signal });
    return {
      registry,
      daemon,
      call,
      setApp: (id: string) => {
        appId = id;
      },
      setAuthority: (key: string | null) => {
        authority = key;
      },
    };
  }

  it("does not apply driver consent handling to names outside the configured MCP prefix", () => {
    const fixture = setup();
    expect(fixture.registry.getCodexConsentServer("get_js")).toBeNull();
    expect(fixture.registry.getCodexConsentServer("mcp_js")?.id).toBe("codex");
  });

  it("uses Full access without app cards and still blocks a subsequent policy denial", async () => {
    const fixture = setup();
    fixture.daemon.evaluateToolPermission.mockResolvedValue({ decision: "allow" });
    fixture.daemon.canAutoApproveComputerUseApp.mockResolvedValue(true);
    for (let i = 0; i < 12; i++)
      expect(await fixture.call()).toEqual({ action: "accept", content: {} });
    expect(fixture.daemon.requestApproval).not.toHaveBeenCalled();
    expect(fixture.daemon.canAutoApproveComputerUseApp).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        params: { code: "await app.getAXState()", app: "com.apple.calculator" },
      }),
    );
    fixture.daemon.evaluateToolPermission.mockResolvedValue({ decision: "deny" });
    expect(await fixture.call()).toEqual({ action: "decline" });
    const controller = new AbortController();
    controller.abort();
    expect(await fixture.call(controller.signal)).toEqual({ action: "decline" });
    expect(fixture.daemon.requestApproval).not.toHaveBeenCalled();
  });

  it("asks once per app per task across repeated calls, and asks for a second app", async () => {
    const fixture = setup();
    for (let i = 0; i < 12; i++)
      expect(await fixture.call()).toEqual({ action: "accept", content: {} });
    expect(fixture.daemon.requestApproval).toHaveBeenCalledTimes(1);
    expect(fixture.daemon.requestApproval.mock.calls[0][3].taskConsentScope).toContain(
      "Calculator",
    );
    fixture.setApp("com.apple.TextEdit");
    await fixture.call();
    expect(fixture.daemon.requestApproval).toHaveBeenCalledTimes(2);
    const other = Object.create(ToolRegistry.prototype) as Any;
    Object.assign(other, fixture.registry, { taskId: "task-2", codexTaskConsents: new Map() });
    await other.tryExecuteMCPTool("mcp_js", {}, {});
    expect(fixture.daemon.requestApproval).toHaveBeenCalledTimes(3);
  });

  it("re-prompts when authority changes and never reuses a grant after denial or cancellation", async () => {
    const fixture = setup();
    await fixture.call();
    fixture.setAuthority("authority-2");
    await fixture.call();
    expect(fixture.daemon.requestApproval).toHaveBeenCalledTimes(2);
    fixture.setAuthority(null);
    expect(await fixture.call()).toEqual({ action: "decline" });
    const controller = new AbortController();
    controller.abort();
    expect(await fixture.call(controller.signal)).toEqual({ action: "decline" });
    fixture.setAuthority("authority-2");
    fixture.daemon.evaluateToolPermission.mockResolvedValue({ decision: "deny" });
    expect(await fixture.call()).toEqual({ action: "decline" });
  });

  it("does not cache denied, late, or explicit rule approvals", async () => {
    const fixture = setup();
    fixture.daemon.requestApproval.mockResolvedValue(false);
    await fixture.call();
    await fixture.call();
    expect(fixture.daemon.requestApproval).toHaveBeenCalledTimes(2);
    fixture.daemon.requestApproval.mockImplementation(async () => {
      fixture.setAuthority("changed");
      return true;
    });
    expect(await fixture.call()).toEqual({ action: "decline" });
    fixture.daemon.requestApproval.mockResolvedValue(true);
    fixture.daemon.evaluateToolPermission.mockResolvedValue({
      decision: "ask",
      matchedRule: { effect: "ask" },
    } as Any);
    await fixture.call();
    await fixture.call();
    expect(fixture.daemon.requestApproval).toHaveBeenCalledTimes(5);
  });

  it("cannot revive consent after task cleanup, including a late response", async () => {
    const fixture = setup();
    fixture.daemon.requestApproval.mockImplementation(async () => {
      fixture.registry.codexConsentClosed = true;
      return true;
    });
    expect(await fixture.call()).toEqual({ action: "decline" });
    expect(fixture.registry.codexTaskConsents.size).toBe(0);
    expect(await fixture.call()).toEqual({ action: "decline" });
    expect(fixture.daemon.requestApproval).toHaveBeenCalledTimes(1);
  });

  it("remembers engine consent for the task but invalidates a changed configuration", async () => {
    const fixture = setup();
    const details = {
      tool: "mcp_js",
      params: { serverId: "codex", configuration: "v1" },
      taskConsentScope: "engine calls",
    };
    await fixture.registry.requestCodexTaskConsent("Allow engine?", details);
    await fixture.registry.requestCodexTaskConsent("Allow engine?", details);
    expect(fixture.daemon.requestApproval).toHaveBeenCalledTimes(1);
    await fixture.registry.requestCodexTaskConsent("Allow engine?", {
      ...details,
      params: { ...details.params, configuration: "v2" },
    });
    expect(fixture.daemon.requestApproval).toHaveBeenCalledTimes(2);
  });
});
