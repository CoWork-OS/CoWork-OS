import type Database from "better-sqlite3";
import { z } from "zod";
import {
  botResponsibilityScopeSchema,
  botResponsibilitySaveSchema,
  botResponsibilityReviseSchema,
  botResponsibilityControlSchema,
  botResponsibilityRunRequestSchema,
  botResponsibilityFutureControlSchema,
  type BotResponsibilityPreview,
} from "../../shared/bot-responsibility";
import type { CronSchedule } from "../cron/types";
import { BotResponsibilityRepository } from "./BotResponsibilityRepository";
import { getAutomationRuntime } from "./AutomationRuntime";
import { previewSchedule } from "./schedule-preview";
const transitions = new WeakMap<Database.Database, Map<string, Promise<unknown>>>();
const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), atMs: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal("every"),
    everyMs: z.number().int().positive(),
    anchorMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("cron"),
    expr: z.string().min(1).max(200),
    tz: z.string().max(100).optional(),
  }),
]);
const triggerSchema = z.object({
  type: z.string().max(100),
  enabled: z.boolean().optional(),
  schedule: scheduleSchema.optional(),
});
/** Shared read/write service. Preview reads persisted configuration only; saving
 * records a paused revision and never invokes a scheduler or model. */
export class BotResponsibilityService {
  private repository: BotResponsibilityRepository;
  private db: Database.Database;
  constructor(
    db: Database.Database,
    private options: {
      now?: () => number;
      runtime?: () => "desktop" | "electron_headless" | "node" | undefined;
      getRoutineService?: () => import("../routines/service").RoutineService | null;
      assertOwnership?: () => Promise<void>;
      getSchedulerFence?: () => import("./scheduler-lease-store").SchedulerFence;
      nextSchedule?: (schedule: CronSchedule, now: number) => Promise<number | undefined>;
    } = {},
  ) {
    this.db = db;
    this.repository = new BotResponsibilityRepository(db);
  }
  list(raw: unknown) {
    return this.repository.list(botResponsibilityScopeSchema.parse(raw));
  }
  engines(raw: unknown) {
    return this.repository.engines(botResponsibilityScopeSchema.parse(raw));
  }
  async preview(raw: unknown): Promise<BotResponsibilityPreview> {
    const input = botResponsibilitySaveSchema.parse(raw);
    const saved = await this.repository.preview(input.scope, input.definition);
    const triggers =
      "triggers" in saved ? z.array(triggerSchema).max(100).parse(saved.triggers) : [];
    const schedules = triggers
      .filter((item) => item.enabled !== false && item.type === "schedule" && item.schedule)
      .map((item) => item.schedule!) as CronSchedule[];
    const triggerSummary =
      "source" in saved
        ? [`Matching ${saved.source.replaceAll("_", " ")} event`]
        : triggers
            .filter((item) => item.enabled !== false)
            .map((item) =>
              item.type === "schedule"
                ? `Schedule: ${item.schedule?.kind ?? "unavailable"}`
                : item.type === "manual"
                  ? "On demand"
                  : `Matching ${item.type.replaceAll("_", " ")}`,
            );
    const runtime = this.options.runtime?.() ?? getAutomationRuntime()?.snapshot().runtime;
    let nextRunIfEnabledAt: number | undefined;
    let schedulePreviewState: BotResponsibilityPreview["schedulePreviewState"] = schedules.length
      ? "unavailable"
      : "event_or_manual";
    if (schedules.length && schedules.length <= 5) {
      try {
        const times = await Promise.all(
          schedules.map((schedule) =>
            (this.options.nextSchedule ?? previewSchedule)(
              schedule,
              (this.options.now ?? Date.now)(),
            ),
          ),
        );
        const finite = times.filter(
          (time): time is number => typeof time === "number" && Number.isFinite(time),
        );
        if (finite.length) nextRunIfEnabledAt = Math.min(...finite);
        schedulePreviewState = "calculated";
      } catch {
        /* A bounded unavailable preview never invents an execution time. */
      }
    }
    const activationIssues = await this.repository.activationIssues(input.scope, input.definition);
    if (!this.options.getRoutineService?.())
      activationIssues.push("Routine execution is unavailable in this runtime.");
    if (!this.options.assertOwnership && getAutomationRuntime()?.snapshot().scheduler !== "owned")
      activationIssues.push("This runtime does not own the automation scheduler.");
    if (!runtime || (input.definition.backend === "desktop" && runtime !== "desktop"))
      activationIssues.push("The selected execution backend is unavailable.");
    return {
      definition: saved.definition,
      engine: saved.engine,
      triggerSummary,
      schedules,
      ...(nextRunIfEnabledAt === undefined ? {} : { nextRunIfEnabledAt }),
      schedulePreviewState,
      backendPresence: !runtime
        ? "unavailable"
        : saved.definition.backend === "desktop" && runtime !== "desktop"
          ? "requires_desktop"
          : "present",
      executionState: "paused",
      activationAvailable: activationIssues.length === 0,
      activationIssues,
    };
  }
  private serialize<T>(id: string, run: () => Promise<T>): Promise<T> {
    let queue = transitions.get(this.db);
    if (!queue) {
      queue = new Map();
      transitions.set(this.db, queue);
    }
    const previous = queue.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    queue.set(id, next);
    void next
      .finally(() => {
        if (queue!.get(id) === next) queue!.delete(id);
      })
      .catch(() => {});
    return next;
  }
  private async owner() {
    const runtime = getAutomationRuntime();
    if (this.options.assertOwnership) await this.options.assertOwnership();
    else {
      if (!runtime) throw new Error("Automation runtime is unavailable");
      await runtime.assertOwnership();
    }
    return this.options.getSchedulerFence?.() ?? runtime?.captureFence();
  }
  private executor() {
    const service = this.options.getRoutineService?.();
    if (!service) throw new Error("Routine execution is unavailable");
    return service;
  }
  activate(raw: unknown) {
    const request = botResponsibilityControlSchema.parse(raw);
    return this.serialize(request.id, async () => {
      const fence = await this.owner();
      const routines = this.executor();
      const current = await this.repository.get(request.scope, request.id);
      if (!current) throw new Error("Responsibility is unavailable");
      const preview = await this.preview({ scope: request.scope, definition: current.definition });
      if (!preview.activationAvailable) throw new Error(preview.activationIssues.join(" "));
      const activated = await this.repository.setState(
        request.scope,
        request.id,
        request.expectedRevision,
        request.expectedControlVersion,
        "active",
        fence,
      );
      try {
        if (!(await routines.update(activated.definition.engine.id, { enabled: true })))
          throw new Error("Routine is unavailable");
        await this.owner();
        const latest = await this.repository.get(request.scope, request.id);
        if (latest?.controlVersion !== activated.controlVersion || latest.state !== "active")
          throw new Error("Activation was superseded");
        return latest;
      } catch (error) {
        const latest = await this.repository.get(request.scope, request.id);
        if (latest?.controlVersion === activated.controlVersion) {
          await this.repository.setState(
            request.scope,
            request.id,
            activated.revision,
            activated.controlVersion,
            "paused",
          );
          await routines.update(activated.definition.engine.id, { enabled: false }).catch(() => {});
        }
        throw error;
      }
    });
  }
  pause(raw: unknown) {
    const request = botResponsibilityControlSchema.parse(raw);
    return this.serialize(request.id, async () => {
      const fence = await this.owner();
      const routines = this.executor();
      const paused = await this.repository.setState(
        request.scope,
        request.id,
        request.expectedRevision,
        request.expectedControlVersion,
        "paused",
        fence,
      );
      if (paused.definition.engine.kind === "routine")
        await routines.update(paused.definition.engine.id, { enabled: false });
      return paused;
    });
  }
  setFutureRuns(raw: unknown) {
    const request = botResponsibilityFutureControlSchema.parse(raw);
    return this.serialize(request.id, async () =>
      this.repository.setFutureControl(
        request,
        (this.options.now ?? Date.now)(),
        await this.owner(),
      ),
    );
  }
  run(raw: unknown) {
    const request = botResponsibilityRunRequestSchema.parse(raw);
    return this.serialize(request.id, async () => {
      await this.owner();
      const routines = this.executor();
      const current = await this.repository.get(request.scope, request.id);
      if (
        !current ||
        current.state !== "active" ||
        current.revision !== request.expectedRevision ||
        current.controlVersion !== request.expectedControlVersion
      )
        throw new Error("Responsibility revision or control changed");
      const runtime = this.options.runtime?.() ?? getAutomationRuntime()?.snapshot().runtime;
      if (current.definition.backend === "desktop" && runtime !== "desktop")
        throw new Error("Responsibility is waiting for a desktop runtime");
      await this.repository.assertEngineMayExecute(
        current.definition.engine.kind,
        current.definition.engine.id,
      );
      return routines.runNow(current.definition.engine.id, {
        operationKey: `responsibility:${current.id}:${current.revision}:${current.controlVersion}:${request.requestId}`,
        requestIdentity: request,
      });
    });
  }
  create(raw: unknown) {
    const input = botResponsibilitySaveSchema.parse(raw);
    return this.repository.create(input.scope, input.definition);
  }
  revise(raw: unknown) {
    const input = botResponsibilityReviseSchema.parse(raw);
    return this.repository.revise(input.scope, input.id, input.expectedRevision, input.definition);
  }
}
