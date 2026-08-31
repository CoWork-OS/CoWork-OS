import type { CronService } from "../cron";
import type { CronJobCreate, CronJobPatch } from "../cron/types";
import type { BriefingConfig } from "./types";
import { BUILTIN_ACCESS_PROFILE_IDS } from "../../shared/access-profiles";

export const DAILY_BRIEFING_MARKER = "cowork:briefing:v1";

function normalizeScheduleTime(scheduleTime?: string): string {
  const raw = typeof scheduleTime === "string" ? scheduleTime.trim() : "";
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "08:00";
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function toDailyCronExpr(scheduleTime?: string): string {
  const normalized = normalizeScheduleTime(scheduleTime);
  const [hours, minutes] = normalized.split(":");
  return `${Number(minutes)} ${Number(hours)} * * *`;
}

export async function syncDailyBriefingCronJob(
  cronService: CronService | null,
  workspaceId: string,
  config: BriefingConfig,
): Promise<void> {
  if (!cronService || !workspaceId) return;

  const title = `Daily Briefing: ${workspaceId}`;
  const desiredJob: CronJobCreate = {
    name: title,
    description: `Managed daily briefing trigger. [${DAILY_BRIEFING_MARKER}]`,
    enabled: !!config.enabled,
    schedule: { kind: "cron", expr: toDailyCronExpr(config.scheduleTime) },
    workspaceId,
    taskPrompt: `Managed daily briefing trigger. [${DAILY_BRIEFING_MARKER}]`,
    taskTitle: title,
    maxHistoryEntries: 25,
    accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    allowUserInput: false,
  };

  const existing = (await cronService.list({ includeDisabled: true })).filter(
    (job) =>
      job.workspaceId === workspaceId &&
      (job.name === title || (job.description || "").includes(DAILY_BRIEFING_MARKER)),
  );

  if (!config.enabled) {
    await Promise.all(existing.map((job) => cronService.remove(job.id)));
    return;
  }

  const [primary, ...duplicates] = existing;

  if (!primary) {
    await cronService.add(desiredJob);
    return;
  }

  const patch: CronJobPatch = {
    name: desiredJob.name,
    description: desiredJob.description,
    enabled: desiredJob.enabled,
    schedule: desiredJob.schedule,
    taskPrompt: desiredJob.taskPrompt,
    taskTitle: desiredJob.taskTitle,
    maxHistoryEntries: desiredJob.maxHistoryEntries,
    accessProfileId: desiredJob.accessProfileId,
    allowUserInput: desiredJob.allowUserInput,
  };

  await cronService.update(primary.id, patch);
  await Promise.all(duplicates.map((job) => cronService.remove(job.id)));
}
