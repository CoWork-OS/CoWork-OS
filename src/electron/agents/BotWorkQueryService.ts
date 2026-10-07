import type Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { BotWorkItem, BotWorkPage, BotWorkQuery } from "../../shared/types";
import type { CronJob } from "../cron/types";
import { getCronService } from "../cron/service";
import { BotWorkRepository } from "../database/repository-facades";

const id = z.string().trim().min(1).max(128);
const querySchema = z
  .object({
    workspaceId: id,
    agentRoleId: id,
    view: z.enum(["needs_you", "working", "scheduled", "results"]),
    limit: z.number().finite().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
const cursorSchema = z
  .object({
    workspaceId: id,
    agentRoleId: id,
    view: querySchema.shape.view,
    updatedAt: z.number().finite().nonnegative(),
    id: z.string().min(1).max(256),
  })
  .strict();

export function parseBotWorkQuery(raw: unknown): BotWorkQuery {
  return querySchema.parse(raw);
}

export interface BotScheduleSnapshot {
  jobs: CronJob[];
  state: "running" | "disabled" | "not_started" | "unavailable";
}

/** Recent work-view query durations in this process, for the outcome baseline. */
const workViewSamples: number[] = [];
export function botWorkViewLatency(): {
  samples: number;
  medianMs: number | null;
  p95Ms: number | null;
} {
  if (!workViewSamples.length) return { samples: 0, medianMs: null, p95Ms: null };
  const sorted = [...workViewSamples].sort((a, b) => a - b);
  const at = (quantile: number) =>
    Number(sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))].toFixed(2));
  return { samples: sorted.length, medianMs: at(0.5), p95Ms: at(0.95) };
}

function follows(item: BotWorkItem, cursor?: { updatedAt: number; id: string }): boolean {
  return (
    !cursor ||
    item.updatedAt < cursor.updatedAt ||
    (item.updatedAt === cursor.updatedAt && item.id < cursor.id)
  );
}

/** Shared by IPC, Electron Control Plane, and the Node daemon. */
export class BotWorkQueryService {
  private repository: BotWorkRepository;
  constructor(
    db: Database.Database,
    private schedules: () => Promise<BotScheduleSnapshot | null> = async () => {
      const service = getCronService();
      if (!service) return null;
      return { jobs: await service.list(), state: (await service.status()).scheduler.state };
    },
  ) {
    this.repository = new BotWorkRepository(db);
  }

  async list(rawQuery: unknown): Promise<BotWorkPage> {
    const started = performance.now();
    const page = await this.listPage(rawQuery);
    workViewSamples.push(performance.now() - started);
    if (workViewSamples.length > 200) workViewSamples.shift();
    return page;
  }

  private async listPage(rawQuery: unknown): Promise<BotWorkPage> {
    const query = querySchema.parse(rawQuery);
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor) {
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
        );
      } catch {
        throw new Error("Invalid bot work cursor");
      }
      if (
        cursor.workspaceId !== query.workspaceId ||
        cursor.agentRoleId !== query.agentRoleId ||
        cursor.view !== query.view
      ) {
        throw new Error("Bot work cursor belongs to another query");
      }
    }
    // Validate workspace/bot through the storage read before accessing saved schedules.
    const { responsibilitySchedules, botFuturePaused, ...page } = await this.repository.list(
      query,
      cursor,
    );
    const responsibilityJobs = new Map(
      responsibilitySchedules.map((schedule) => [schedule.jobId, schedule.paused]),
    );
    // An unavailable scheduler must not hide assigned tasks or human decisions.
    const snapshot = await this.schedules().catch(() => null);
    const jobs = snapshot?.jobs ?? [];
    const scheduled: BotWorkItem[] = jobs
      .filter(
        (job) =>
          job.enabled &&
          job.workspaceId === query.workspaceId &&
          (job.assignedAgentRoleId === query.agentRoleId || responsibilityJobs.has(job.id)),
      )
      .map((job) => ({
        id: `schedule:${job.id}`,
        scheduleId: job.id,
        title: (job.taskTitle || job.name).slice(0, 240),
        view: "scheduled",
        status: "scheduled",
        ownership: "assigned",
        assignedAgentRoleId: query.agentRoleId,
        conversation: false,
        updatedAt: job.updatedAtMs,
        nextWakeAt: job.state.nextRunAtMs,
        verification: "unverified",
        delivery: "unknown",
        // A paused bot (which also blocks new assigned work) or responsibility skips the
        // run, so the saved time is not a promise.
        ...(botFuturePaused
          ? { schedulePaused: "bot" as const }
          : responsibilityJobs.get(job.id)
            ? { schedulePaused: "responsibility" as const }
            : {}),
      }));
    page.counts.scheduled += scheduled.length;
    const items = [
      ...page.items,
      ...(query.view === "scheduled" ? scheduled.filter((item) => follows(item, cursor)) : []),
    ].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const hasMore = items.length > query.limit;
    const visible = items.slice(0, query.limit);
    const last = visible.at(-1);
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              workspaceId: query.workspaceId,
              agentRoleId: query.agentRoleId,
              view: query.view,
              updatedAt: last.updatedAt,
              id: last.id,
            }),
          ).toString("base64url")
        : undefined;
    return {
      workspaceId: query.workspaceId,
      agentRoleId: query.agentRoleId,
      view: query.view,
      items: visible,
      counts: page.counts,
      nextCursor,
      scheduleAvailability: snapshot === null ? "unavailable" : "available",
      scheduleRuntime: snapshot?.state ?? "unavailable",
    };
  }
}
