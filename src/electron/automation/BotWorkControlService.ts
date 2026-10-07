import type { SchedulerFence } from "./scheduler-lease-store";
import type Database from "better-sqlite3";
import {
  botWorkControlRequestSchema,
  botWorkControlReadSchema,
  botWorkControlScopeSchema,
} from "../../shared/bot-work-control";
import { serviceStatements } from "../database/service-statements";
const drains = new WeakMap<Database.Database, Map<string, Promise<void>>>();
export class BotWorkControlService {
  private sql;
  constructor(
    private db: Database.Database,
    private runtime: {
      cancel: (
        taskId: string,
        workspaceId: string,
        authority?: BotWorkCancellationAuthority,
      ) => Promise<void>;
      captureFence?: () => SchedulerFence;
      isStopped: (taskId: string) => boolean | Promise<boolean>;
      isLocallyStopped?: (taskId: string) => boolean | Promise<boolean>;
      assertOwnership?: () => Promise<void>;
      activeTaskIds?: () => string[] | Promise<string[]>;
    },
    private replyDeadlineMs = 2000,
  ) {
    this.sql = serviceStatements(db);
  }
  async read(raw: unknown) {
    return this.sql.unit("botWorkControl_read", [botWorkControlReadSchema.parse(raw)]);
  }
  async futureState(raw: unknown) {
    return this.sql.unit("botWorkControl_futureState", [botWorkControlScopeSchema.parse(raw)]);
  }
  async stop(raw: unknown) {
    const input = botWorkControlRequestSchema.parse(raw);
    await this.runtime.assertOwnership?.();
    const fence = this.runtime.captureFence?.();
    if (
      input.action === "resume_turn" &&
      (await this.read({ scope: input.scope, requestId: input.requestId }))
    )
      return this.sql.unit("botWorkControl_begin", [input, Date.now(), [], fence]);
    if (input.action === "resume_turn" && !(await this.runtime.isStopped(input.taskId!)))
      throw new Error("Runtime cleanup is not confirmed");
    const receipt = await this.sql.unit("botWorkControl_begin", [
      input,
      Date.now(),
      (await this.runtime.activeTaskIds?.()) ?? [],
      fence,
    ]);
    if (receipt.tasks.every((item) => item.status === "stopped" || item.status === "released"))
      return receipt;
    let map = drains.get(this.db);
    if (!map) {
      map = new Map();
      drains.set(this.db, map);
    }
    const key = JSON.stringify([input.scope, input.requestId]);
    let drain = map.get(key);
    if (!drain) {
      drain = this.drain(
        input,
        receipt.tasks.filter((item) => item.status !== "stopped").map((item) => item.taskId),
        fence,
      );
      map.set(key, drain);
      void drain
        .finally(() => {
          if (map!.get(key) === drain) map!.delete(key);
        })
        .catch(() => {});
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      drain,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.replyDeadlineMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    return this.read({ scope: input.scope, requestId: input.requestId });
  }
  /** Retry only persisted, still-current stop intents; never select new work. */
  async recover(): Promise<void> {
    await this.runtime.assertOwnership?.();
    const fence = this.runtime.captureFence?.();
    const pending = await this.sql.unit("botWorkControl_recoverable", [32]);
    for (const { request, receipt } of pending) {
      await this.runtime.assertOwnership?.();
      let map = drains.get(this.db);
      if (!map) {
        map = new Map();
        drains.set(this.db, map);
      }
      const key = JSON.stringify([request.scope, request.requestId]);
      let drain = map.get(key);
      if (!drain) {
        drain = this.drain(
          request,
          receipt.tasks
            .filter((item) => item.status === "requested" || item.status === "failed")
            .map((item) => item.taskId),
          fence,
        );
        map.set(key, drain);
      }
      try {
        await drain;
      } finally {
        if (map.get(key) === drain) map.delete(key);
      }
    }
  }
  async waitForIdle(): Promise<void> {
    while (drains.get(this.db)?.size) await Promise.allSettled(drains.get(this.db)!.values());
  }
  private async drain(
    input: import("../../shared/bot-work-control").BotWorkControlRequest,
    ids: string[],
    fence?: SchedulerFence,
  ) {
    let index = 0;
    const outcomes = new Map<string, string | null>();
    const locallyStopped: string[] = [];
    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (index < ids.length) {
          const taskId = ids[index++];
          try {
            await this.runtime.assertOwnership?.();
            await this.sql.unit("botWorkControl_assertTarget", [
              { scope: input.scope, requestId: input.requestId },
              taskId,
              fence,
            ]);
            await this.runtime.cancel(taskId, input.scope.workspaceId, {
              control: { scope: input.scope, requestId: input.requestId },
              fence,
            });
            const local = await (this.runtime.isLocallyStopped?.(taskId) ??
              this.runtime.isStopped(taskId));
            if (local) locallyStopped.push(taskId);
            outcomes.set(taskId, null);
          } catch (cause) {
            outcomes.set(taskId, cause instanceof Error ? cause.message : "Cancellation failed");
          }
        }
      }),
    );
    await this.sql.unit("botWorkControl_syncGraphs", [
      { scope: input.scope, requestId: input.requestId },
      locallyStopped,
      fence,
    ]);
    for (const taskId of ids) {
      let error = outcomes.get(taskId) ?? null;
      let stopped = false;
      try {
        stopped = !error && (await this.runtime.isStopped(taskId));
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "Cleanup confirmation failed";
      }
      if (!stopped && !error) error = "Runtime cleanup is not confirmed";
      await this.sql.unit("botWorkControl_record", [
        { scope: input.scope, requestId: input.requestId },
        taskId,
        stopped ? "stopped" : "failed",
        error,
        Date.now(),
        fence,
      ]);
    }
  }
}

export interface BotWorkCancellationAuthority {
  control: import("../../shared/bot-work-control").BotWorkControlRead;
  fence?: SchedulerFence;
}
