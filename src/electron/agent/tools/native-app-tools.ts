import { z } from "zod";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { LLMTool } from "../llm/types";
import type { AgentDaemon } from "../daemon";
import type { FileTools } from "./file-tools";
import {
  ComputerUseHelperRuntime,
  HelperCommandError,
  HelperTransportError,
} from "../../computer-use/helper-runtime";
import { ComputerUseSessionManager } from "../../computer-use/session-manager";
import { getDefaultRuntimeToolMetadata } from "./runtime-tool-definition";
import { requireNativeDesktopSession } from "../../applications/native-desktop-session";

const positive = z.number().int().positive();
const target = { pid: positive, windowId: positive };
// Readback is mandatory after a mutation. Accept this observation hint from
// providers, but never let it disable the post-action verification snapshot.
const snapshot = { ...target, snapshotId: z.string().uuid(), screenshot: z.boolean().optional() };
const bundleIdSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(/^[A-Za-z0-9.-]+$/);
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const NativeAppInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("launch"),
      bundleId: bundleIdSchema,
      documentPath: z
        .string()
        .max(1024)
        .refine((p) => path.isAbsolute(p) && path.resolve(p) === p && !/[\x00-\x1f]/.test(p))
        .optional(),
    })
    .strict(),
  // Read-only discovery by exact pid, or by bundleId across its running processes
  // (never launches), so a model that lost the pid can rediscover it.
  z
    .object({
      action: z.literal("windows"),
      pid: positive.optional(),
      bundleId: bundleIdSchema.optional(),
    })
    .strict()
    .refine((input) => (input.pid === undefined) !== (input.bundleId === undefined), {
      message: "windows requires exactly one of pid or bundleId",
    }),
  z
    .object({ action: z.literal("observe"), ...target, screenshot: z.boolean().optional() })
    .strict(),
  z
    .object({
      action: z.literal("set_value"),
      ...snapshot,
      token: z.string().uuid(),
      expectedValue: z.string().max(10000),
      value: z.string().max(10000),
    })
    .strict(),
  z
    .object({
      action: z.enum(["press", "increment", "decrement", "confirm"]),
      ...snapshot,
      token: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("keypress"),
      ...snapshot,
      keyCode: z.number().int().min(0).max(127),
      modifiers: z
        .array(z.enum(["command", "shift", "control", "option"]))
        .max(4)
        .optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("type_text"), ...snapshot, text: z.string().min(1).max(2000) })
    .strict(),
  z
    .object({
      action: z.enum(["click", "double_click"]),
      ...snapshot,
      x: z.number().finite(),
      y: z.number().finite(),
      button: z.enum(["left", "right"]).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      ...snapshot,
      x: z.number().finite(),
      y: z.number().finite(),
      scrollX: z.number().int().min(-1000).max(1000),
      scrollY: z.number().int().min(-1000).max(1000),
    })
    .strict(),
  z
    .object({ action: z.literal("drag"), ...snapshot, path: z.array(point).min(2).max(100) })
    .strict(),
]);
// Provider tool schemas require an object at the root. Per-action strictness is
// enforced by NativeAppInputSchema; the union remains an internal validator.
const unionSchema = z.toJSONSchema(NativeAppInputSchema) as {
  oneOf?: Array<{ properties: Record<string, unknown> }>;
  anyOf?: Array<{ properties: Record<string, unknown> }>;
};
const toolProperties = Object.assign(
  {},
  ...(unionSchema.oneOf || unionSchema.anyOf || []).map((branch) => branch.properties),
  {
    action: {
      type: "string",
      enum: [
        "launch",
        "windows",
        "observe",
        "set_value",
        "press",
        "increment",
        "decrement",
        "confirm",
        "keypress",
        "type_text",
        "click",
        "double_click",
        "scroll",
        "drag",
      ],
    },
  },
);
export const NATIVE_APP_TOOL: LLMTool = {
  name: "native_app",
  description:
    "Generic local macOS BACKGROUND-ONLY app control. No shell. Launch by installed bundleId (optional authorized documentPath), windows(pid or running bundleId; never launches), observe(pid,windowId) returns exact AX element tokens plus screenshot. For one action use that fresh snapshotId and exact pid/windowId: press/increment/decrement token; confirm token commits an edited field (AXConfirm, e.g. after set_value); set_value token expectedValue/value (explicit replacement); keypress macOS virtual keyCode/modifiers; type_text into the target's existing focused window; click/double_click/scroll/drag with WINDOW-RELATIVE POINTS (not retina pixels). Prefer AX tokens. Each action consumes its snapshot; observe again afterward. Never activates, raises, unminimizes, moves the real pointer, uses clipboard or falls back to foreground. Pauses when the user is using the target app. Dispatch acknowledgement is UNVERIFIED: inspect fresh state/screenshot and prove the actual outcome. Unsupported/secure/stale targets refuse. On outcome_unknown stop; do not replay or route around it. User Stop cancels; their Escape remains available. Background compatibility varies by app/control.",
  input_schema: {
    type: "object",
    properties: toolProperties,
    required: ["action"],
    additionalProperties: false,
  } as LLMTool["input_schema"],
  runtime: {
    ...getDefaultRuntimeToolMetadata("native_app"),
    concurrencyClass: "exclusive",
    readOnly: false,
    sideEffectLevel: "high",
    alwaysExpose: true,
    deferLoad: false,
    exposure: "always",
  },
};

/** Host-owned target snapshots and persisted attempt records, behind normal tool authority. */
export class NativeAppTools {
  private readonly session = randomUUID();
  private readonly appConsents = new Map<string, string>();
  private uncertain = false;
  constructor(
    private files: FileTools,
    private daemon: AgentDaemon,
    private taskId: string,
    private runtime = ComputerUseHelperRuntime.getInstance(),
  ) {}

  private hasUnknownAttempt(): boolean {
    if (this.uncertain) return true;
    // Survives executor/helper restart. Never silently convert a lost reply into a retry.
    const events = this.daemon.getTaskEvents(this.taskId, { types: ["log"] }) as Array<{
      type: string;
      payload?: Record<string, unknown>;
    }>;
    const attempts = new Map<string, string>();
    for (const event of events)
      if (event.payload?.kind === "native_app_attempt" && event.payload?.attemptId)
        attempts.set(String(event.payload.attemptId), String(event.payload.status));
    return [...attempts.values()].some(
      (status) => status === "dispatching" || status === "outcome_unknown",
    );
  }
  async run(raw: unknown): Promise<Record<string, unknown>> {
    if (process.platform !== "darwin")
      throw new Error("Local background native app control requires macOS");
    const input = NativeAppInputSchema.parse(raw);
    await requireNativeDesktopSession();
    const readOnly = input.action === "observe" || input.action === "windows";
    if (!readOnly && this.hasUnknownAttempt())
      throw new Error(
        "outcome_unknown: a previous native action is unresolved. Read-only observation remains available; no mutation or replay is allowed.",
      );
    ComputerUseSessionManager.getInstance().acquire(this.taskId, this.daemon, { background: true });
    ComputerUseSessionManager.getInstance().checkNotAborted();
    await this.runtime.ensureReadyWithInteractivePermissions();
    if (input.action === "launch" && input.documentPath)
      await this.files.authorizeApplicationPath(input.documentPath, "read");
    const pid = "pid" in input && input.pid ? input.pid : 0;
    const apps = input.action === "launch" ? [] : await this.runtime.listApps();
    const bundleId =
      input.action === "launch" || (input.action === "windows" && !pid)
        ? input.bundleId
        : apps.find((app) => app.pid === pid)?.bundleId;
    if (!bundleId) throw new Error("Selected app exited or has no stable bundle identity");
    const details = {
      tool: "native_app",
      kind: "native_background_app",
      bundleId,
      backgroundOnly: true,
      taskConsentScope: `background observation, clicking and typing in ${bundleId}; no foreground or clipboard access`,
      taskConsentLabel: "Allow for this task",
    };
    const authority =
      typeof this.daemon.getTaskConsentAuthority === "function"
        ? await this.daemon.getTaskConsentAuthority(this.taskId, details, "computer_use")
        : null;
    if (!authority || this.appConsents.get(bundleId) !== authority) {
      this.appConsents.delete(bundleId);
      const approved = await this.daemon.requestApproval(
        this.taskId,
        "computer_use",
        `Control ${bundleId} in the background for this task`,
        details,
      );
      if (!approved) throw new Error("Local background app control was denied");
      const current =
        typeof this.daemon.getTaskConsentAuthority === "function"
          ? await this.daemon.getTaskConsentAuthority(this.taskId, details, "computer_use")
          : null;
      if (authority && current !== authority)
        throw new Error("App control authority changed during consent");
      if (current) this.appConsents.set(bundleId, current);
    }
    ComputerUseSessionManager.getInstance().checkNotAborted();
    if (input.action === "windows") {
      if (pid) return { pid, windows: await this.runtime.listWindows(pid), background: true };
      const pids = apps.filter((app) => app.bundleId === bundleId).map((app) => app.pid);
      if (!pids.length)
        return {
          bundleId,
          running: false,
          processes: [],
          background: true,
          note: "Not running; launch it first.",
        };
      const processes = [];
      for (const each of pids)
        processes.push({ pid: each, windows: await this.runtime.listWindows(each) });
      return { bundleId, running: true, processes, background: true };
    }
    const attemptId = randomUUID();
    const record = (status: string, extra: Record<string, unknown> = {}) =>
      this.daemon.logEvent(this.taskId, "log", {
        kind: "native_app_attempt",
        attemptId,
        status,
        action: input.action,
        pid: pid || undefined,
        windowId: "windowId" in input ? input.windowId : undefined,
        ...extra,
      });
    if (!readOnly) {
      record("dispatching");
      await this.daemon.timelineRowsCommitted(this.taskId);
    }
    try {
      let result = await this.runtime.background({ ...input, session: this.session, attemptId });
      if (!readOnly && input.action !== "launch") {
        try {
          const fresh = await this.runtime.background({
            action: "observe",
            pid: input.pid,
            windowId: input.windowId,
            session: this.session,
            screenshot: true,
          });
          result = {
            ...fresh,
            action: input.action,
            dispatch: result.dispatch,
            effect: "unverified",
            preservation: result.preservation,
          };
        } catch {
          throw new HelperCommandError(
            "Action dispatched, but fresh readback failed; inspect without replay",
            "outcome_unknown",
          );
        }
      }
      if (!readOnly) {
        record("acknowledged", { effect: "unverified", preservation: result.preservation });
        await this.daemon.timelineRowsCommitted(this.taskId);
      }
      const capture = result.capture as
        | { pngBase64?: string; width?: number; height?: number; scaleFactor?: number }
        | undefined;
      if (capture?.pngBase64) {
        delete result.capture;
        return {
          ...result,
          captureId: result.snapshotId,
          imageBase64: capture.pngBase64,
          mediaType: "image/png",
          width: capture.width,
          height: capture.height,
          scaleFactor: capture.scaleFactor,
          target: {
            pid: result.pid,
            bundleId: result.bundleId,
            windowId: result.windowId,
            windowTitle: result.windowTitle,
            appName: result.bundleId,
          },
          note: "Background-only AX snapshot. Tokens are scoped to this exact window; one action per snapshot. Dispatch is not semantic verification.",
        };
      }
      return result;
    } catch (error) {
      if (!readOnly) {
        const unknown =
          error instanceof HelperTransportError ||
          !(error instanceof HelperCommandError) ||
          error.code === "outcome_unknown";
        this.uncertain = unknown;
        record(unknown ? "outcome_unknown" : "not_dispatched", {
          code: error instanceof HelperCommandError ? error.code : "transport_or_host_failure",
        });
        await this.daemon.timelineRowsCommitted(this.taskId);
      }
      throw error;
    }
  }
}
