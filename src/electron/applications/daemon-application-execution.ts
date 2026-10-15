import type { AgentDaemon } from "../agent/daemon";
import type {
  ApplicationAdapterContext,
  ApplicationToolGateway,
} from "./ApplicationAdapterCatalog";
import { ApplicationNotDispatchedError } from "./ApplicationAdapterCatalog";
import { ApplicationExecutionService } from "./ApplicationExecutionService";
import { ApplicationOperationRepository } from "./ApplicationOperationRepository";
import { redactWorkSessionValue } from "../database/WorkSessionProtocolRepository";
import { registerNativeApplicationPilots } from "./native-application-pilots";

/** Live task registries retain their original tool restrictions, policy context, and gateway identity. */
export class ApplicationTaskToolGateway implements ApplicationToolGateway {
  private readonly tasks = new Map<string, ApplicationToolGateway>();
  bind(taskId: string, port: ApplicationToolGateway): void {
    this.tasks.set(taskId, port);
  }
  unbind(taskId: string): void {
    this.tasks.delete(taskId);
  }
  call(
    name: string,
    input: Record<string, unknown>,
    context: ApplicationAdapterContext,
  ): Promise<unknown> {
    const port = this.tasks.get(context.operation.request.taskId);
    if (!port)
      throw new ApplicationNotDispatchedError(
        "The original task tool gateway must be reattached before execution",
      );
    return port.call(name, input, context);
  }
}

export function createDaemonApplicationExecution(
  daemon: AgentDaemon,
  tools: ApplicationTaskToolGateway,
): ApplicationExecutionService {
  const service = new ApplicationExecutionService(
    new ApplicationOperationRepository(daemon.getDatabase()),
    tools,
    {
      changed: (operation) => {
        const projection = service.projection(operation);
        daemon.logEvent(operation.request.taskId, "application_operation", {
          ...projection,
          execution: operation.execution,
          cancellation: operation.cancellation,
          revision: operation.revision,
        });
        const contracts = daemon.getWorkSessionContractService();
        const pending =
          ["planned", "prepared", "submitting", "running", "unknown"].includes(
            operation.execution,
          ) ||
          (operation.verification === "pending" && operation.execution === "completed");
        if (pending)
          contracts.beginWait(operation.request.taskId, {
            kind: "external",
            requestId: operation.id,
            reason:
              operation.decision?.status === "pending"
                ? operation.decision.question
                : "Application operation is incomplete",
            payload: { operationId: operation.id, projection },
          });
        else
          contracts.resolveWait(
            operation.request.taskId,
            "external",
            operation.id,
            operation.execution === "cancelled" ? "cancelled" : "resolved",
            { projection },
          );
        if (operation.verificationResult)
          contracts.recordEvidence(operation.request.taskId, {
            claim: operation.verificationResult.summary,
            sourceType: "tool_output",
            sourceRef: `application:${operation.id}`,
            status:
              operation.verification === "verified"
                ? "supporting"
                : operation.verification === "contradicted"
                  ? "contradicting"
                  : "neutral",
            confidence: operation.verification === "verified" ? 1 : 0,
            freshnessExpiresAt: operation.verificationResult.expiresAt,
            snippet: JSON.stringify(operation.verificationResult.evidence),
            idempotencyKey: `application:${operation.id}:verification:${operation.revision}`,
          });
        if (!pending && !service.isTaskCancellationRequested(operation.request.taskId))
          void daemon
            .resumeAfterApplicationOperations(operation.request.taskId)
            .catch((error) =>
              console.warn(
                "[application-execution] Could not resume the waiting task",
                error instanceof Error ? error.name : "unknown error",
              ),
            );
      },
      warning: (error) =>
        console.warn(
          "[application-execution]",
          error instanceof Error ? error.message : String(error),
        ),
    },
  );
  // Legacy tools can be journalled, but gain no invented replay or domain verification guarantees.
  service.catalog.register({
    route: {
      id: "cowork.tool.v1",
      adapterId: "cowork-tools",
      adapterVersion: "1",
      capability: "cowork.tool",
      protocol: "native",
      control: "structured",
      environment: {
        id: "cowork-task",
        kind: "local",
        locality: "local",
        background: false,
        isolated: false,
      },
      resourceKinds: ["file", "native_project", "remote_entity", "query", "application_state"],
      effect: "unknown",
      replay: "never",
      supports: {
        prepare: false,
        observe: false,
        cancel: false,
        verify: false,
        conditionalWrite: false,
        remoteFencing: false,
      },
      qualified: false,
      preparationEffect: "unknown",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, arguments: { type: "object" } },
        required: ["name", "arguments"],
      },
      description:
        "Durable execution through an existing task tool. No automatic replay or domain verifier; qualify an app adapter for stronger guarantees.",
    },
    validateInput: (input) => {
      if (
        typeof input.name !== "string" ||
        !input.name.trim() ||
        input.name.length > 256 ||
        input.name.startsWith("application_")
      )
        throw new ApplicationNotDispatchedError("Select an existing non-application tool");
      if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments))
        throw new ApplicationNotDispatchedError("Tool arguments must be an object");
    },
    readiness: async () => ({ ready: true }),
    execute: async (context) => {
      const input = context.operation.request.input;
      const output = await context.tools.call(
        input.name as string,
        input.arguments as Record<string, unknown>,
        context,
      );
      return {
        status: "completed",
        result: {
          kind: "application_state",
          summary: `${input.name} returned. Application completion requires domain verification.`,
          resources: context.operation.request.resources,
          data: {
            output: JSON.stringify(redactWorkSessionValue(output)).slice(0, 16_000),
          },
          unmetCriteria: [],
        },
      };
    },
  });
  registerNativeApplicationPilots(service.catalog);
  service.start();
  return service;
}
