import { z } from "zod";
import type { AgentDaemon } from "../../electron/agent/daemon";
import {
  MAX_QUEUE_TASK_TIMEOUT_MINUTES,
  MIN_QUEUE_TASK_TIMEOUT_MINUTES,
  type QueueSettings,
} from "../../shared/types";
import { WebApplicationError } from "../web/WebApplication";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";

const QueueSettingsSchema = z
  .object({
    maxConcurrentTasks: z.number().int().min(1).max(20),
    taskTimeoutMinutes: z
      .number()
      .int()
      .min(MIN_QUEUE_TASK_TIMEOUT_MINUTES)
      .max(MAX_QUEUE_TASK_TIMEOUT_MINUTES),
  })
  .strict();

function invalidQueueSettings(): never {
  throw new WebApplicationError("INVALID_REQUEST", "Invalid queue settings.", 400);
}

function readQueueSettings(agentDaemon: Pick<AgentDaemon, "getQueueSettings">): QueueSettings {
  let current: unknown;
  try {
    current = agentDaemon.getQueueSettings();
  } catch {
    throw new WebApplicationError("INTERNAL_ERROR", "Queue settings could not be read.", 500);
  }

  const parsed = QueueSettingsSchema.safeParse(current);
  if (!parsed.success) {
    throw new WebApplicationError("INTERNAL_ERROR", "Queue settings are unavailable.", 500);
  }
  return parsed.data;
}

/** Browser access to the host's authoritative persisted and live queue settings. */
export function createBrowserQueueDefinitions(
  agentDaemon?: Pick<AgentDaemon, "getQueueSettings" | "saveQueueSettings">,
): BrowserDesktopDefinitions {
  if (!agentDaemon) return {};

  return {
    getQueueSettings: {
      capability: "agents.manage",
      minArgs: 0,
      maxArgs: 0,
      handler: () => readQueueSettings(agentDaemon),
    },
    saveQueueSettings: {
      capability: "agents.manage",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        if (args.length !== 1) return invalidQueueSettings();
        const parsed = QueueSettingsSchema.safeParse(args[0]);
        if (!parsed.success) return invalidQueueSettings();
        return [parsed.data];
      },
      handler: ([settings]) => {
        const parsed = QueueSettingsSchema.safeParse(settings);
        if (!parsed.success) return invalidQueueSettings();

        try {
          agentDaemon.saveQueueSettings(parsed.data);
        } catch {
          throw new WebApplicationError(
            "INTERNAL_ERROR",
            "Queue settings could not be saved.",
            500,
          );
        }

        const readBack = readQueueSettings(agentDaemon);
        if (
          readBack.maxConcurrentTasks !== parsed.data.maxConcurrentTasks ||
          readBack.taskTimeoutMinutes !== parsed.data.taskTimeoutMinutes
        ) {
          throw new WebApplicationError(
            "INTERNAL_ERROR",
            "Queue settings could not be confirmed. Reload the settings before trying again.",
            500,
          );
        }
        return { success: true };
      },
    },
  };
}
