import type { ControlPlaneServer } from "./server";
import { ErrorCodes, Methods } from "./protocol";
import type { SymphonyService } from "./SymphonyService";

export function registerSymphonyMethods(options: {
  server: ControlPlaneServer;
  getSymphonyService: () => SymphonyService | null;
  requireScope: (client: Any, scope: "admin" | "read" | "write" | "operator") => void;
}): void {
  const { server, getSymphonyService, requireScope } = options;

  const requireService = (): SymphonyService => {
    const service = getSymphonyService();
    if (!service) {
      throw { code: ErrorCodes.METHOD_FAILED, message: "Symphony service is unavailable" };
    }
    return service;
  };

  server.registerMethod(Methods.SYMPHONY_CONFIG_GET, async (client) => {
    requireScope(client, "read");
    return { config: requireService().getConfig() };
  });

  server.registerMethod(Methods.SYMPHONY_CONFIG_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    return { config: requireService().updateConfig((params || {}) as Any) };
  });

  server.registerMethod(Methods.SYMPHONY_STATUS, async (client) => {
    requireScope(client, "read");
    return { status: requireService().getStatus() };
  });

  server.registerMethod(Methods.SYMPHONY_RUN, async (client) => {
    requireScope(client, "admin");
    return { status: await requireService().runOnce("manual") };
  });

  server.registerMethod(Methods.SYMPHONY_PAUSE, async (client) => {
    requireScope(client, "admin");
    return { config: requireService().updateConfig({ enabled: false }) };
  });
}
