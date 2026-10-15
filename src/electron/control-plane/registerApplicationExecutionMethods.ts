import { z } from "zod";
import type { AgentDaemon } from "../agent/daemon";
import type { ControlPlaneServer } from "./server";
import { ErrorCodes, Methods } from "./protocol";
import { runApplicationTool } from "../agent/tools/application-tools";

/** Both desktop and Node daemon expose the same bounded lifecycle; adapter registration is host-only. */
export function registerApplicationExecutionMethods(input: {
  server: ControlPlaneServer;
  agentDaemon: AgentDaemon;
  requireScope: (client: unknown, scope: "admin" | "read" | "write" | "operator") => void;
}): void {
  const identity = z.string().trim().min(1).max(256);
  const register = <T>(
    method: string,
    scope: "read" | "operator",
    schema: z.ZodType<T>,
    run: (value: T) => Promise<unknown>,
  ) => {
    input.server.registerMethod(method, async (client, raw) => {
      input.requireScope(client, scope);
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success)
        throw {
          code: ErrorCodes.INVALID_PARAMS,
          message: parsed.error.issues[0]?.message ?? "Invalid application request",
        };
      return run(parsed.data);
    });
  };
  const service = () => input.agentDaemon.getApplicationExecutionService();
  register(
    Methods.APPLICATION_OPERATION_RESOLVE_UNKNOWN,
    "operator",
    z
      .object({
        operationId: identity,
        expectedRevision: z.number().int().positive(),
        resolutionKey: identity,
        status: z.enum(["applied", "not_applied", "stopped"]),
        summary: z.string().trim().min(1).max(8_000),
      })
      .strict(),
    async (p) => service().projection(await service().resolveUnknown(p)),
  );
  register(Methods.APPLICATION_CAPABILITIES, "read", z.object({}).strict(), async () => ({
    routes: service().catalog.list(),
  }));
  register(
    Methods.APPLICATION_OPERATION_LIST,
    "read",
    z.object({ taskId: identity }).strict(),
    async (p) => ({
      operations: (await service().repository.list(p.taskId)).map((op) => service().projection(op)),
    }),
  );
  register(
    Methods.APPLICATION_OPERATION_GET,
    "read",
    z.object({ operationId: identity }).strict(),
    async (p) => {
      const operation = await service().get(p.operationId);
      return {
        operation,
        projection: service().projection(operation),
        attempts: await service().repository.attempts(operation.id),
        events: await service().repository.events(operation.id),
      };
    },
  );
  register(
    Methods.APPLICATION_OPERATION_CREATE,
    "operator",
    z.object({ taskId: identity, request: z.record(z.string(), z.json()) }).strict(),
    async (p) =>
      runApplicationTool(input.agentDaemon, p.taskId, { action: "create", request: p.request }),
  );
  for (const [method, action] of [
    [Methods.APPLICATION_OPERATION_PREPARE, "prepare"],
    [Methods.APPLICATION_OPERATION_EXECUTE, "execute"],
    [Methods.APPLICATION_OPERATION_RECONCILE, "reconcile"],
    [Methods.APPLICATION_OPERATION_CANCEL, "cancel"],
  ] as const) {
    register(method, "operator", z.object({ operationId: identity }).strict(), async (p) => {
      const operation = await service().get(p.operationId);
      return runApplicationTool(input.agentDaemon, operation.request.taskId, {
        action,
        operationId: operation.id,
      });
    });
  }
  register(
    Methods.APPLICATION_DECISION_RESOLVE,
    "operator",
    z
      .object({
        operationId: identity,
        decisionId: identity,
        binding: identity,
        resolutionKey: identity,
        status: z.enum(["accepted", "rejected", "revise"]),
        feedback: z.string().max(8_000).optional(),
      })
      .strict(),
    async (p) => service().projection(await service().decide(p)),
  );
}
