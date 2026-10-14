import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { NativeCreateSchema } from "../../applications/native-application-scripts";
import { nativePilotResources } from "../../applications/native-application-pilots";
import { PhotoshopEditSchema } from "../../applications/photoshop-document-edit";
import { photoshopEditResources } from "../../applications/photoshop-edit-adapter";
import type { AgentDaemon } from "../daemon";
import type { LLMTool } from "../llm/types";
import type { InputRequest, InputRequestResponse } from "../../../shared/types";
import { ApplicationOperationRequestSchema } from "../../../shared/application-execution";
import { getDefaultRuntimeToolMetadata } from "./runtime-tool-definition";
import type { ApplicationExecutionService } from "../../applications/ApplicationExecutionService";

export const APPLICATION_DECISION_PREFIX = "application_decision_";

/** Resolves only a human response to a question created for the original durable decision. */
export async function resolveApplicationInput(
  service: ApplicationExecutionService,
  request: InputRequest,
  response: InputRequestResponse,
): Promise<void> {
  for (const question of request.questions) {
    if (!question.id.startsWith(APPLICATION_DECISION_PREFIX)) continue;
    const [operationId, decisionId, binding] = question.id
      .slice(APPLICATION_DECISION_PREFIX.length)
      .split("_");
    const operation = await service.get(operationId);
    if (
      operation.request.taskId !== request.taskId ||
      !operation.decision ||
      operation.decision.id !== decisionId ||
      operation.decision.binding !== binding
    )
      throw new Error("Application input ownership or decision revision mismatch");
    const answer = response.answers?.[question.id];
    const status =
      response.status === "dismissed" || answer?.optionLabel === "Cancel"
        ? "rejected"
        : answer?.optionLabel === "Continue" && !answer.otherText?.trim()
          ? "accepted"
          : "revise";
    await service.decide({
      operationId,
      decisionId,
      binding,
      resolutionKey: request.id,
      status,
      feedback: answer?.otherText,
    });
  }
}

export const APPLICATION_OPERATION_TOOL: LLMTool = {
  name: "application_operation",
  description:
    "Execute application work with a durable operation and verified result. Discover routes first. Photoshop banner creation, existing PSD layer editing and Excel operating plans have domain verifiers. Prefer local.photoshop.v1 for creation and local.photoshop.edit.v1 for existing PSD edits; read the source layer tree and hash using local_photoshop_read first. Create/prepare/execute, inspect results, reconcile unknown effects, or cancel. Use review only for a requested draft, material ambiguity, or expensive commitment. Feedback does not grant permissions. Never recreate an unknown write to retry it. Legacy cowork.tool supports journalling but no domain verification; qualified adapters provide stronger guarantees.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "capabilities",
          "create",
          "prepare",
          "execute",
          "get",
          "list",
          "reconcile",
          "cancel",
          "review",
        ],
      },
      operationId: { type: "string" },
      request: {
        type: "object",
        description:
          "Create request: idempotencyKey, capability, objective, input, resources; optional routeId, dependsOn, planRevision, decision {reason,question}, constraints. Task/session/workspace are supplied by CoWork. For Photoshop creation, existing PSD editing and Excel operating plans, omit resources to derive exact source/output file references from input.",
      },
    },
    required: ["action"],
  },
  runtime: {
    ...getDefaultRuntimeToolMetadata("application_operation"),
    deferLoad: true,
    exposure: "conditional",
    sideEffectLevel: "high",
    concurrencyClass: "serial_only",
    approvalKind: "workspace_policy",
  },
};

export async function runApplicationTool(
  daemon: AgentDaemon,
  taskId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const service = daemon.getApplicationExecutionService();
  // Keep the projection at the same location for every operation action.
  // The original record supplies ownership and verification provenance to the harness.
  const present = (operation: Awaited<ReturnType<typeof service.get>>) => ({
    ...service.projection(operation),
    operation,
  });
  if (input.action === "capabilities" || input.action === "create") {
    for (const route of service.catalog.list())
      if (route.id.startsWith("worker.")) service.catalog.remove(route.id);
  }
  if (input.action === "capabilities") return { routes: service.catalog.list() };
  if (input.action === "list")
    return {
      operations: (await service.repository.list(taskId)).map((op) => service.projection(op)),
    };
  if (input.action === "create") {
    const task = daemon.getTask(taskId);
    if (!task) throw new Error("Application task not found");
    const session = daemon.getWorkSessionContractService().ensureForTask(task).session;
    const request = input.request;
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new Error("Application request is required");
    const bounded = request as Record<string, unknown>;
    const inferredResources =
      bounded.capability === "photoshop.document.edit" && bounded.resources === undefined
        ? photoshopEditResources(PhotoshopEditSchema.parse(bounded.input))
        : ["photoshop.banner.create", "excel.operating-plan.create"].includes(
              String(bounded.capability),
            ) && bounded.resources === undefined
          ? nativePilotResources(NativeCreateSchema.parse(bounded.input))
          : bounded.resources;
    const parsed = ApplicationOperationRequestSchema.parse({
      ...request,
      resources: inferredResources,
      taskId,
      sessionId: session.id,
      workspaceId: task.workspaceId,
    });
    return present(await service.create(parsed));
  }
  if (typeof input.operationId !== "string") throw new Error("operationId is required");
  const operation = await service.get(input.operationId);
  if (operation.request.taskId !== taskId)
    throw new Error("Application operation belongs to a different task");
  switch (input.action) {
    case "get":
      return {
        ...present(operation),
        projection: service.projection(operation),
      };
    case "prepare":
      return present(await service.prepare(operation.id));
    case "execute":
    case "reconcile": {
      const finished =
        input.action === "execute"
          ? await service.execute(operation.id)
          : await service.reconcile(operation.id);
      if (
        ["local.photoshop.v1", "local.photoshop.edit.v1"].includes(finished.route.id) &&
        finished.verification === "verified"
      ) {
        const native = finished.result?.data as {
          path?: string;
          persisted?: {
            sha256?: string;
            export?: { path?: string; sha256?: string };
          };
        };
        for (const target of [
          {
            path: native?.path,
            hash: native?.persisted?.sha256,
            mime: "image/vnd.adobe.photoshop",
          },
          {
            path: native?.persisted?.export?.path,
            hash: native?.persisted?.export?.sha256,
            mime: "image/png",
          },
        ]) {
          if (!target.path || !target.hash) throw new Error("Verified local artifact is missing");
          const handle = await fs.open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
          let size: number;
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
              throw new Error("Invalid local artifact");
            const hash = createHash("sha256")
              .update(await handle.readFile())
              .digest("hex");
            if (hash !== target.hash) throw new Error("Local artifact changed after verification");
            size = stat.size;
          } finally {
            await handle.close();
          }
          await daemon.registerArtifact(taskId, target.path, target.mime);
          daemon.logEvent(taskId, "file_created", {
            path: target.path,
            size,
            source: "local-photoshop",
            operationId: finished.id,
          });
        }
      }
      return present(finished);
    }
    case "cancel":
      return present(await service.cancel(operation.id));
    case "review": {
      const prepared = await service.prepare(operation.id);
      if (!prepared.decision || prepared.decision.status !== "pending") return present(prepared);
      await daemon.requestUserInput(taskId, {
        questions: [
          {
            header: "Review",
            id: `${APPLICATION_DECISION_PREFIX}${operation.id}_${prepared.decision.id}_${prepared.decision.binding}`,
            question: `${prepared.decision.question}\n\n${prepared.prepared?.summary ?? prepared.request.objective}${prepared.prepared?.references.length ? `\n\nReferences:\n${prepared.prepared.references.slice(0, 3).join("\n")}` : ""}`,
            options: [
              {
                label: "Continue",
                description: "Continue with this prepared change.",
              },
              {
                label: "Revise",
                description: "Revise the proposal before applying it.",
              },
              { label: "Cancel", description: "Stop this proposed operation." },
            ],
          },
        ],
      });
      return present(await service.get(operation.id));
    }
    default:
      throw new Error("Unknown application operation action");
  }
}
