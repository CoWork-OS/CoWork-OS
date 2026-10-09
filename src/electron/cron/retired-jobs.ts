import { CHANNEL_TYPES } from "../../shared/gateway-channel-types";
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

/** Display names for discontinued channels that scheduled tasks could deliver to. */
const RETIRED_DELIVERY_CHANNEL_LABELS: Record<string, string> = {
  twitch: "Twitch",
  x: "X",
};

/**
 * True for a delivery channel type that the gateway no longer supports, such as
 * the discontinued Twitch and X channels. Missing types are not retired.
 */
export function isRetiredDeliveryChannelType(channelType: unknown): boolean {
  return (
    typeof channelType === "string" &&
    channelType.length > 0 &&
    !(CHANNEL_TYPES as readonly string[]).includes(channelType)
  );
}

export function getRetiredDeliveryReason(channelType: string): string {
  const label = RETIRED_DELIVERY_CHANNEL_LABELS[channelType] ?? channelType;
  return (
    `Results are no longer sent to ${label} because that channel has been discontinued. ` +
    "The scheduled task still runs; choose another delivery channel to receive its results."
  );
}
