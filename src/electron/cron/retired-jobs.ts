import type { CronJob } from "./types";

/**
 * R&D Council scheduled its runs through cron with a bare trigger prompt such as
 * `<cowork_council:ID>`. The Council service that expanded the trigger was
 * removed, so running such a job would hand the model a meaningless prompt.
 */
const RETIRED_COUNCIL_TRIGGER = /^<cowork_council:[^<>]*>$/;

export const RETIRED_COUNCIL_JOB_REASON =
  "This scheduled task was created by R&D Council, which has been discontinued. " +
  "Edit its prompt to describe the work to run, or remove it.";

/**
 * Returns why a job can no longer run as stored, or null when it can run.
 */
export function getRetiredCronJobReason(job: Pick<CronJob, "taskPrompt">): string | null {
  const prompt = typeof job.taskPrompt === "string" ? job.taskPrompt.trim() : "";
  if (RETIRED_COUNCIL_TRIGGER.test(prompt)) return RETIRED_COUNCIL_JOB_REASON;
  return null;
}
