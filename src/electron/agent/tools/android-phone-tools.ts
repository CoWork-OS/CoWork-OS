import { z } from "zod";
import { publishPhoneScreenshot } from "../../phone/phone-screenshot-artifact";
import type { AgentDaemon } from "../daemon";
import type { LLMTool } from "../llm/types";
import { AndroidDeviceIdSchema, AndroidPhoneInputSchema } from "../../../shared/android-phone";
import { AndroidPhoneService } from "../../phone/AndroidPhoneService";
import { ApplicationNotDispatchedError } from "../../applications/ApplicationAdapterCatalog";
import { getDefaultRuntimeToolMetadata } from "./runtime-tool-definition";
import { isThirdPartyGatewayTask } from "../../gateway/gateway-sender-identity";

const definitions: LLMTool[] = [
  {
    name: "android_phone_devices",
    description:
      "List Android devices attached to this CoWork host and the device selected by the user in Settings → Computer use. Does not connect, pair, rent or select devices. Phone control is opt-in.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "android_phone_observe",
    description:
      "Read the explicitly selected Android phone's screenshot, package and visible text, after screen-access approval. Returns captureId for a short-lived task-owned snapshot and path for the saved PNG artifact. Link path directly in the final answer; do not search private profile directories. For input use application_operation capability phone.android.action with input {deviceId,snapshotId: captureId,action:{kind,...},expected:{package?,text?}}; omit resources to derive the device lock. If focusedEditor identifies the intended field, type_text directly without a redundant tap; caret blinking can invalidate coordinate taps. Every action requires approval. Never enter passwords, PINs or 2FA; never recreate an unknown action. Observe again when stale. Phone screenshots are sent to the task's model.",
    input_schema: {
      type: "object",
      properties: { deviceId: { type: "string" } },
      required: ["deviceId"],
    },
  },
  ...["android_phone_authorize", "android_phone_dispatch", "android_phone_readback"].map(
    (name) => ({
      name,
      description: name.endsWith("authorize")
        ? "Internal approval-only phase for the original durable Android operation. Direct calls refuse. Does not dispatch phone input."
        : name.endsWith("dispatch")
          ? "Internal durable Android action. Available only to the original application_operation attempt; direct calls refuse. Use phone.android.action."
          : "Internal read-only receipt and screen reconciliation for the original durable Android operation. Direct calls refuse.",
      input_schema: z.toJSONSchema(AndroidPhoneInputSchema) as LLMTool["input_schema"],
    }),
  ),
];
export const ANDROID_PHONE_TOOLS: LLMTool[] = definitions.map((tool) => ({
  ...tool,
  runtime: {
    ...getDefaultRuntimeToolMetadata(tool.name),
    alwaysExpose: tool.name === "android_phone_devices" || tool.name === "android_phone_observe",
    deferLoad: false,
    exposure: "always",
    concurrencyClass: "serial_only",
    readOnly: !tool.name.endsWith("dispatch"),
    sideEffectLevel: tool.name.endsWith("dispatch") ? "high" : "none",
    approvalKind: "none",
  },
}));

export class AndroidPhoneTools {
  constructor(
    private daemon: AgentDaemon,
    private taskId: string,
    private service = AndroidPhoneService.getInstance(),
  ) {}
  private async approve(deviceId: string, action?: unknown, signal?: AbortSignal): Promise<void> {
    const task = this.daemon.getTask(this.taskId);
    const workspace = task?.workspaceId
      ? this.daemon.getWorkspaceById?.(task.workspaceId)
      : undefined;
    const artifactDirectory = workspace?.permissions.write ? workspace.path : undefined;
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "computer_use",
      (action
        ? `Apply this action on Android ${deviceId}: ${JSON.stringify(action)}`
        : `Read Android ${deviceId}: its screen and text will be shared with this task's model`) +
        (artifactDirectory
          ? ". Approved screenshots will also be saved as PNG artifacts in this task's workspace."
          : ""),
      {
        tool: action ? "android_phone_dispatch" : "android_phone_observe",
        deviceId,
        action,
        scope: "this call only",
        approvalPreview: {
          label: action ? "Android action and readback" : "Android screen access",
          text: JSON.stringify(
            {
              deviceId,
              ...(artifactDirectory ? { screenshotArtifactDirectory: artifactDirectory } : {}),
              ...(action ? { action, readback: true } : { shareScreenWithTaskModel: true }),
            },
            null,
            2,
          ),
        },
      },
      {
        allowAutoApprove: false,
        requireExplicitApproval: true,
        noStandingApproval: true,
        signal,
      },
    );
    if (!approved)
      throw new ApplicationNotDispatchedError(
        "Android phone approval denied; no phone input was dispatched",
      );
  }
  async run(
    name: string,
    raw: Record<string, unknown>,
    runtime?: {
      signal?: unknown;
      applicationAttempt?: { operationId: string; phase: string };
    },
  ): Promise<unknown> {
    if (isThirdPartyGatewayTask(this.daemon.getTask(this.taskId)))
      throw new ApplicationNotDispatchedError(
        "Phone control is unavailable to third-party gateway senders",
      );
    const signal = runtime?.signal instanceof AbortSignal ? runtime.signal : undefined;
    if (name === "android_phone_devices") {
      const { pythonPath: _path, ...status } = await this.service.status();
      return status;
    }
    if (name === "android_phone_observe") {
      const deviceId = AndroidDeviceIdSchema.parse(raw.deviceId);
      const generation = this.service.controlGeneration();
      await this.service.requireSelected(deviceId, generation);
      const scope = this.service.controlScope(generation, signal);
      try {
        await this.approve(deviceId, undefined, scope.signal);
        this.service.assertControl(generation, signal);
        const observation = await this.service.observe(
          this.taskId,
          deviceId,
          scope.signal,
          generation,
        );
        if (typeof this.daemon.registerArtifact === "function") {
          await this.daemon.registerArtifact(
            this.taskId,
            this.service.capturePath(observation.captureId),
            "image/png",
          );
        }
        return publishPhoneScreenshot(this.daemon, this.taskId, this.service, observation);
      } finally {
        scope.dispose();
      }
    }
    const attempt = runtime?.applicationAttempt;
    if (!attempt)
      throw new ApplicationNotDispatchedError(
        "Phone actions require a durable application_operation attempt",
      );
    const service = this.daemon.getApplicationExecutionService();
    const operation = await service.get(attempt.operationId);
    const input = AndroidPhoneInputSchema.parse(raw);
    if (
      operation.request.taskId !== this.taskId ||
      operation.route.id !== "phone.android.v1" ||
      JSON.stringify(AndroidPhoneInputSchema.parse(operation.request.input)) !==
        JSON.stringify(input)
    )
      throw new ApplicationNotDispatchedError(
        "Phone action does not match the original durable operation",
      );
    if (name === "android_phone_authorize") {
      if (attempt.phase !== "execute")
        throw new ApplicationNotDispatchedError(
          "Phone mutations are allowed only in the execute phase",
        );
      const generation = this.service.controlGeneration();
      await this.service.requireSelected(input.deviceId, generation);
      await this.service.snapshot(this.taskId, input);
      const scope = this.service.controlScope(generation, signal);
      try {
        await this.approve(input.deviceId, input.action, scope.signal);
        this.service.assertControl(generation, signal);
        await this.service.recordActionApproval(this.taskId, operation.id, input, generation);
        return { approved: true };
      } finally {
        scope.dispose();
      }
    }
    if (name === "android_phone_dispatch") {
      if (attempt.phase !== "execute")
        throw new ApplicationNotDispatchedError(
          "Phone mutations are allowed only in the execute phase",
        );
      const generation = await this.service.requireActionApproval(
        this.taskId,
        operation.id,
        input,
        true,
      );
      return this.service.action(this.taskId, operation.id, input, signal, generation);
    }
    if (
      name !== "android_phone_readback" ||
      !["execute", "observe", "verify"].includes(attempt.phase)
    )
      throw new ApplicationNotDispatchedError("Invalid phone readback phase");
    // Readback is scoped to the original approved operation and exact device, never another app input.
    await this.service.requireActionApproval(this.taskId, operation.id, input);
    return this.service.reconcile(this.taskId, operation.id, input, signal);
  }
}
