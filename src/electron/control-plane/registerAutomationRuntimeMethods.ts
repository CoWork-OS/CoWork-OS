import { getAutomationRuntime } from "../automation/AutomationRuntime";
import type { ControlPlaneServer } from "./server";
import { Methods } from "./protocol";
export function registerAutomationRuntimeMethods(input: {
  server: ControlPlaneServer;
  requireScope: (client: unknown, scope: "read") => void;
}): void {
  input.server.registerMethod(Methods.AUTOMATION_RUNTIME_STATUS, async (client) => {
    input.requireScope(client, "read");
    return (
      getAutomationRuntime()?.snapshot() ?? {
        runtime: "unavailable",
        producers: [],
        capabilities: {},
      }
    );
  });
}
