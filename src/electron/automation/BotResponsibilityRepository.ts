import { getAutomationRuntime } from "./AutomationRuntime";
import type Database from "better-sqlite3";
import type {
  BotResponsibilityDefinition,
  BotResponsibility,
  BotResponsibilityScope,
} from "../../shared/bot-responsibility";
import { serviceStatements } from "../database/service-statements";
import type { EventTrigger, TriggerEvent } from "../triggers/types";
import type { ResponsibilityAdmissionSnapshot } from "./responsibility-event-admission";
/** Storage only. Saving or previewing a definition cannot enable or launch its engine. */
export class BotResponsibilityRepository {
  private sql;
  constructor(db: Database.Database) {
    this.sql = serviceStatements(db);
  }
  signalContext(
    jobId: string,
    loadHistory = false,
    expectedRun?: import("../../shared/bot-responsibility").BotResponsibilityRun,
    kind: "cron" | "event" = "cron",
  ) {
    return this.sql.unit("botResponsibility_signalContext", [
      jobId,
      loadHistory,
      expectedRun ?? null,
      kind,
    ]);
  }
  setFutureControl(
    request: import("../../shared/bot-responsibility").BotResponsibilityFutureControl,
    now: number,
    fence?: import("./scheduler-lease-store").SchedulerFence,
  ) {
    return this.sql.unit("botResponsibility_setFutureControl", [request, now, fence ?? null]);
  }
  getForEventTrigger(id: string) {
    return this.sql.unit("botResponsibility_getForEventTrigger", [id]);
  }
  eventAdmissionSnapshot(binding: BotResponsibility, trigger: EventTrigger) {
    return this.sql.unit("botResponsibility_eventAdmissionSnapshot", [binding, trigger]);
  }
  eventSourceMatches(
    trigger: EventTrigger,
    event: TriggerEvent,
    snapshot: ResponsibilityAdmissionSnapshot,
  ) {
    return this.sql.unit("botResponsibility_eventSourceMatches", [trigger, event, snapshot]);
  }
  getForEngine(kind: "routine" | "trigger", id: string) {
    return this.sql.unit("botResponsibility_getForEngine", [kind, id]);
  }
  /** Bindings are saved paused until execution policy and activation are connected.
   * Enabling their legacy engine cannot bypass that persisted pause boundary. */
  async assertEngineMayExecute(kind: "routine" | "trigger", id: string): Promise<void> {
    const binding = await this.sql.unit("botResponsibility_assertRunnable", [kind, id]);
    if (
      binding?.definition.backend === "desktop" &&
      getAutomationRuntime()?.snapshot().runtime !== "desktop"
    )
      throw new Error("Responsibility is waiting for a desktop runtime");
  }
  async assertCronJobMayExecute(jobId: string): Promise<void> {
    const binding = await this.sql.unit("botResponsibility_getForCronJob", [jobId]);
    if (binding)
      await this.assertEngineMayExecute(
        binding.definition.engine.kind,
        binding.definition.engine.id,
      );
  }
  async assertCronJobMayDeliver(jobId: string): Promise<void> {
    await this.assertCronJobMayExecute(jobId);
    if (await this.sql.unit("botResponsibility_getForCronJob", [jobId]))
      throw new Error("Responsibility scheduled output needs a delivery approval binding");
  }
  activationIssues(scope: BotResponsibilityScope, definition: BotResponsibilityDefinition) {
    return this.sql.unit("botResponsibility_activationIssues", [scope, definition]);
  }
  setState(
    scope: BotResponsibilityScope,
    id: string,
    revision: number,
    controlVersion: number,
    state: "active" | "paused",
    fence?: import("./scheduler-lease-store").SchedulerFence,
  ) {
    return this.sql.unit("botResponsibility_setState", [
      scope,
      id,
      revision,
      controlVersion,
      state,
      Date.now(),
      fence ?? null,
    ]);
  }
  engines(scope: BotResponsibilityScope) {
    return this.sql.unit("botResponsibility_engines", [scope]);
  }
  preview(scope: BotResponsibilityScope, definition: BotResponsibilityDefinition) {
    return this.sql.unit("botResponsibility_preview", [scope, definition]);
  }
  list(scope: BotResponsibilityScope) {
    return this.sql.unit("botResponsibility_list", [scope]);
  }
  get(scope: BotResponsibilityScope, id: string, revision?: number) {
    return this.sql.unit("botResponsibility_get", [scope, id, revision ?? null]);
  }
  create(scope: BotResponsibilityScope, definition: BotResponsibilityDefinition) {
    return this.sql.unit("botResponsibility_create", [scope, definition, Date.now()]);
  }
  revise(
    scope: BotResponsibilityScope,
    id: string,
    expectedRevision: number,
    definition: BotResponsibilityDefinition,
  ) {
    return this.sql.unit("botResponsibility_revise", [
      scope,
      id,
      expectedRevision,
      definition,
      Date.now(),
    ]);
  }
}
