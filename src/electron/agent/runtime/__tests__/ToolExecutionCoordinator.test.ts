import { expect, it, vi } from "vitest";
import type { ToolRegistry } from "../../tools/registry";
import { ToolExecutionCoordinator } from "../ToolExecutionCoordinator";
import { ApplicationNotDispatchedError } from "../../../applications/ApplicationAdapterCatalog";

it("never uses workspace recovery to work around an application dispatch boundary", async () => {
  const denied = new ApplicationNotDispatchedError("Reconcile the original effect");
  const registry = {
    executeToolWithRuntime: vi.fn().mockRejectedValue(denied),
  } as unknown as ToolRegistry;
  const workspaceRecovery = vi
    .fn()
    .mockResolvedValue({ recovered: true, result: { success: true } });
  const outcome = await new ToolExecutionCoordinator(registry).executeTool(
    "write_file",
    { path: "record" },
    {
      taskId: "task",
      phase: "step",
      workspaceRecovery,
    },
  );
  expect(workspaceRecovery).not.toHaveBeenCalled();
  expect(outcome.error).toBe(denied);
  expect(outcome.envelope.status).toBe("error");
});
