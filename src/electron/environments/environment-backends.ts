import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { ExecutionEnvironmentBinding } from "../../shared/execution-environment";
import { BotDesktopManager, findBotDesktopResources } from "../computer-use/bot-desktop-manager";
import { StdioTransport } from "../mcp/client/transports/StdioTransport";
import { MCP_METHODS } from "../mcp/types";

export interface EnvironmentBackend {
  allocate(binding: ExecutionEnvironmentBinding): Promise<{ resourceId: string; cwd: string }>;
  request(
    binding: ExecutionEnvironmentBinding,
    tool: string,
    input: Record<string, unknown>,
    operation: string,
    signal?: AbortSignal,
  ): Promise<Any>;
  release(binding: ExecutionEnvironmentBinding): Promise<void>;
  screenshot?(binding: ExecutionEnvironmentBinding): Promise<Buffer>;
  viewer?(binding: ExecutionEnvironmentBinding, viewOnly: boolean): Promise<string>;
  close?(): Promise<void>;
  cancel?(binding: ExecutionEnvironmentBinding, operation: string): Promise<void>;
}

function workerSource(): string {
  const folder = findBotDesktopResources();
  if (!folder) throw new Error("The computer tool worker is missing from this installation.");
  return readFileSync(join(folder, "cowork-environment.py"), "utf8");
}

export class BotDesktopEnvironmentBackend implements EnvironmentBackend {
  async allocate(binding: ExecutionEnvironmentBinding) {
    const manager = BotDesktopManager.getInstance();
    // Freeze host, group and network into an opaque task-specific alias. Later bot edits
    // cannot redirect the selected desktop or widen its network.
    const resourceId = binding.resourceId.startsWith("environment:")
      ? binding.resourceId
      : manager.bindEnvironment(binding.id, binding.botId, binding.selection.lifetime);
    await manager.withDesktop(resourceId, async () => undefined);
    return { resourceId, cwd: "/home/bot/work" };
  }

  async request(
    binding: ExecutionEnvironmentBinding,
    tool: string,
    input: Record<string, unknown>,
    operation: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const manager = BotDesktopManager.getInstance();
    manager.restoreEnvironment(binding.resourceId);
    return manager.withDesktop(binding.resourceId, async (desktop) => {
      signal?.throwIfAborted();
      const cancel = () => {
        void this.cancel(binding, operation).catch(() => undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      let result;
      try {
        signal?.throwIfAborted();
        result = await desktop.exec(["python3", "-c", workerSource()], {
          input: JSON.stringify({
            environment: binding.id,
            root: binding.cwd,
            tool,
            input,
            operation,
          }),
          timeoutMs: 330_000,
        });
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      signal?.throwIfAborted();
      return JSON.parse(result.stdout.toString("utf8"));
    });
  }

  async cancel(binding: ExecutionEnvironmentBinding, operation: string) {
    await BotDesktopManager.getInstance().controlEnvironment(
      binding.resourceId,
      ["python3", "-c", workerSource()],
      JSON.stringify({
        environment: binding.id,
        root: binding.cwd,
        tool: "cancel_operation",
        input: { id: operation },
      }),
    );
  }

  async release(binding: ExecutionEnvironmentBinding) {
    const manager = BotDesktopManager.getInstance();
    manager.restoreEnvironment(binding.resourceId);
    if (binding.owned && binding.selection.lifetime === "task")
      await manager.deleteEnvironment(binding.resourceId);
  }

  async screenshot(binding: ExecutionEnvironmentBinding) {
    BotDesktopManager.getInstance().restoreEnvironment(binding.resourceId);
    return BotDesktopManager.getInstance().withDesktop(binding.resourceId, (desktop) =>
      desktop.screenshot(),
    );
  }

  async viewer(binding: ExecutionEnvironmentBinding, viewOnly: boolean) {
    BotDesktopManager.getInstance().restoreEnvironment(binding.resourceId);
    return BotDesktopManager.getInstance().viewerUrl(binding.resourceId, { viewOnly });
  }
}

/** Private MCP connection: never registers infrastructure tools in the agent's tool catalog. */
export class CuaEnvironmentBackend implements EnvironmentBackend {
  private transport?: StdioTransport;
  private connecting?: Promise<void>;
  constructor(
    private readonly transportFactory = () =>
      new StdioTransport({
        id: "cowork-environments",
        name: "Cua task computers",
        enabled: true,
        transport: "stdio",
        command: "cua",
        args: ["mcp"],
        requestTimeout: 660_000,
      }),
    private readonly runWorker = (space: string, request: string): Promise<Any> =>
      new Promise((resolve, reject) => {
        // Unlike space_bash's display-oriented 16k text output, interactive CLI transport
        // preserves bounded JSON and binary file/screenshot payloads without truncation.
        const child = execFile(
          "cua",
          ["sandbox", "exec", "-i", space, "--", "python3", "-c", workerSource()],
          { timeout: 330_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
          (error, stdout) => {
            if (error)
              reject(
                new Error("Cua execution was interrupted; reconcile the original operation.", {
                  cause: error,
                }),
              );
            else {
              try {
                resolve(JSON.parse(stdout.trim()));
              } catch {
                reject(new Error("Cua returned no valid completion receipt."));
              }
            }
          },
        );
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(request);
      }),
  ) {}

  private async connect() {
    if (this.transport?.isConnected()) return;
    this.connecting ??= (async () => {
      const transport = this.transportFactory();
      transport.onMessage(() => undefined);
      transport.onError(() => undefined);
      transport.onClose(() => {
        if (this.transport === transport) this.transport = undefined;
      });
      try {
        await transport.connect();
        await transport.sendRequest(MCP_METHODS.INITIALIZE, {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "CoWork-environments", version: "1.0.0" },
        });
        await transport.send({ jsonrpc: "2.0", method: MCP_METHODS.INITIALIZED });
        this.transport = transport;
      } catch (error) {
        await transport.disconnect().catch(() => undefined);
        throw new Error(
          "Cua is unavailable. Install Cua Spaces and verify `cua mcp` before choosing this computer.",
          { cause: error },
        );
      }
    })().finally(() => {
      this.connecting = undefined;
    });
    await this.connecting;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<Any> {
    await this.connect();
    const result = await this.transport!.sendRequest(MCP_METHODS.TOOLS_CALL, {
      name,
      arguments: args,
    });
    if (result?.isError) throw new Error(`Cua ${name} failed. Inspect the Space before retrying.`);
    if (result?.structuredContent) return result.structuredContent;
    const text = (result?.content || [])
      .filter((block: Any) => block.type === "text")
      .map((block: Any) => block.text)
      .join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  async allocate(binding: ExecutionEnvironmentBinding) {
    const selection = binding.selection;
    // Creation intent already carries a deterministic name. Find an earlier allocation after
    // a lost reply; do not issue a second create while an earlier create may still be running.
    let listed;
    try {
      listed = await this.call("list_spaces", {});
    } catch (error) {
      throw Object.assign(error as Error, { notDispatched: true });
    }
    const spaces: Any[] = Array.isArray(listed) ? listed : listed.spaces || [];
    const name = selection.space || binding.resourceId;
    let space = spaces.find((entry) => entry.id === name || entry.name === name);
    if (!space && selection.space)
      throw Object.assign(new Error("The selected Cua Space is unavailable."), {
        notDispatched: true,
      });
    if (!space) {
      if (binding.error && binding.state === "unknown")
        throw new Error(
          "The earlier Space creation has no confirmed result. Inspect Cua Spaces before retrying provisioning.",
        );
      const created = await this.call("create_space", {
        name,
        on: selection.on || "local",
        image: selection.image || "linux",
        reuse: false,
        timeout: 600,
      });
      space = created.space || created;
    }
    if (space.os !== "linux" || typeof space.id !== "string") {
      throw new Error("Unified computer execution currently requires a Linux Cua Space.");
    }
    // Use the Space's unprivileged account. No host environment or credentials are forwarded.
    return { resourceId: space.id, cwd: "/home/cua/work" };
  }

  async request(
    binding: ExecutionEnvironmentBinding,
    tool: string,
    input: Record<string, unknown>,
    operation: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const request = JSON.stringify({
      environment: binding.id,
      root: binding.cwd,
      tool,
      input,
      operation,
    });
    const cancel = () => {
      void this.cancel(binding, operation).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    let result;
    try {
      signal?.throwIfAborted();
      result = await this.runWorker(binding.resourceId, request);
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    signal?.throwIfAborted();
    return result;
  }

  async cancel(binding: ExecutionEnvironmentBinding, operation: string) {
    await this.request(binding, "cancel_operation", { id: operation }, "", undefined);
  }

  async screenshot(binding: ExecutionEnvironmentBinding): Promise<Buffer> {
    const result = await this.request(binding, "desktop_screenshot", {}, "");
    if (!result.imageBase64) throw new Error("Cua desktop capture is unavailable.");
    return Buffer.from(result.imageBase64, "base64");
  }

  async viewer(binding: ExecutionEnvironmentBinding, viewOnly: boolean): Promise<string> {
    if (viewOnly)
      throw new Error(
        "Use the preview while the bot works. Take over before opening Cua's interactive viewer.",
      );
    await this.call("open_space_viewer", { space: binding.resourceId });
    return ""; // The Cua app owns the viewer; never expose a viewer token in renderer state.
  }

  async release(binding: ExecutionEnvironmentBinding) {
    if (!binding.owned || binding.selection.lifetime !== "task") return;
    await this.call("delete_space", { space: binding.resourceId });
    const listed = await this.call("list_spaces", {});
    const spaces = Array.isArray(listed) ? listed : listed.spaces || [];
    if (spaces.some((entry: Any) => entry.id === binding.resourceId))
      throw new Error("Cua computer deletion is still pending.");
  }

  async close() {
    await this.transport?.disconnect();
    this.transport = undefined;
  }
}
