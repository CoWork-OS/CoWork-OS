import { describe, expect, it, vi } from "vitest";
import { CuaEnvironmentBackend } from "../environment-backends";
import type { ExecutionEnvironmentBinding } from "../../../shared/execution-environment";
import { ExecutionEnvironmentSelectionSchema } from "../../../shared/execution-environment";

function binding(): ExecutionEnvironmentBinding {
  return {
    version: 1,
    id: "binding-id",
    generation: 1,
    taskId: "task",
    workspaceId: "workspace",
    resourceId: "cowork-binding-id",
    owned: true,
    os: "linux",
    cwd: "/home/cua/work",
    state: "allocating",
    exported: [],
    createdAt: 1,
    selection: ExecutionEnvironmentSelectionSchema.parse({ backend: "cua", lifetime: "task" }),
  };
}

function fixture(spaces: Any[] = []) {
  const calls: Array<{ name: string; arguments: Any }> = [];
  const transport = {
    onMessage: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    send: vi.fn(),
    sendRequest: vi.fn(async (method, args) => {
      if (method === "initialize") return {};
      calls.push(args);
      if (args.name === "list_spaces")
        return { content: [{ type: "text", text: JSON.stringify(spaces) }] };
      if (args.name === "create_space") {
        const space = { id: "local:created", name: args.arguments.name, os: "linux" };
        spaces.push(space);
        return { structuredContent: space };
      }
      if (args.name === "delete_space") {
        spaces.splice(0);
        return { content: [{ type: "text", text: "Deleted local:created" }] };
      }
      return { content: [{ type: "text", text: "Opened viewer" }] };
    }),
  };
  const worker = vi.fn(async (_space, request) => ({
    success: true,
    content: JSON.parse(request).input.content,
  }));
  const backend = new CuaEnvironmentBackend(() => transport as never, worker);
  return { calls, backend, worker, transport };
}

describe("Cua task-computer backend", () => {
  it("creates one named Linux computer and recovers its identity without another create", async () => {
    const f = fixture();
    const b = binding();
    const created = await f.backend.allocate(b);
    expect(created.resourceId).toBe("local:created");
    b.error = "Creation reply was interrupted";
    b.state = "unknown";
    expect((await f.backend.allocate(b)).resourceId).toBe("local:created");
    expect(f.calls.filter((call) => call.name === "create_space")).toHaveLength(1);
  });

  it("does not repeat an ambiguous creation when no original computer can be found", async () => {
    const f = fixture();
    const b = binding();
    b.error = "Creation outcome unknown";
    b.state = "unknown";
    await expect(f.backend.allocate(b)).rejects.toThrow(/earlier Space creation/);
    expect(f.calls.some((call) => call.name === "create_space")).toBe(false);
  });

  it("attaches an exact existing computer and never deletes it", async () => {
    const f = fixture([{ id: "local:borrowed", name: "borrowed", os: "linux" }]);
    const b = binding();
    b.selection = ExecutionEnvironmentSelectionSchema.parse({
      backend: "cua",
      space: "local:borrowed",
    });
    b.owned = false;
    b.resourceId = (await f.backend.allocate(b)).resourceId;
    await f.backend.release(b);
    expect(f.calls.map((call) => call.name)).toEqual(["list_spaces"]);
  });

  it("uses an interactive worker transport rather than truncating large file output through space_bash", async () => {
    const f = fixture();
    const content = "x".repeat(100000);
    expect(await f.backend.request(binding(), "read_file", { content }, "operation")).toEqual({
      success: true,
      content,
    });
    expect(f.worker).toHaveBeenCalledWith(
      "cowork-binding-id",
      expect.stringContaining('"environment":"binding-id"'),
    );
    expect(f.calls).toEqual([]);
  });

  it("requires takeover before opening an interactive external viewer", async () => {
    const f = fixture();
    await expect(f.backend.viewer(binding(), true)).rejects.toThrow(/Take over/);
    expect(f.calls).toEqual([]);
    await f.backend.viewer(binding(), false);
    expect(f.calls.at(-1)?.name).toBe("open_space_viewer");
  });

  it("requires a confirmed delete response and registry readback", async () => {
    const f = fixture([{ id: "local:created", os: "linux" }]);
    const b = binding();
    b.resourceId = "local:created";
    await f.backend.release(b);
    expect(f.calls.map((call) => call.name)).toEqual(["delete_space", "list_spaces"]);
  });

  it("rejects unqualified operating systems", async () => {
    const f = fixture([{ id: "cowork-binding-id", os: "windows" }]);
    await expect(f.backend.allocate(binding())).rejects.toThrow(/Linux/);
    expect(f.calls.some((call) => call.name === "create_space")).toBe(false);
  });
});
