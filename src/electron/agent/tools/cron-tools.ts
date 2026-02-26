/**
 * CronTools - Agent tools for managing scheduled tasks
 * Allows the AI agent to create, manage, and execute scheduled tasks
 * through natural language interaction
 */

import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";
import { getCronService } from "../../cron";
import type {
  CronJob,
  CronJobCreate,
  CronSchedule,
  CronStatusSummary,
  CronRunHistoryResult,
} from "../../cron/types";

/**
 * CronTools provides scheduled task management capabilities
 * Enables agents to schedule reminders, recurring tasks, and one-time events
 */
export class CronTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  /**
   * Update the workspace for this tool
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * Get the status of the cron scheduler
   */
  async getStatus(): Promise<CronStatusSummary | { error: string }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "schedule_status",
    });

    const service = getCronService();
    if (!service) {
      return { error: "Scheduler service is not running" };
    }

    const status = await service.status();

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "schedule_status",
      success: true,
      jobCount: status.jobCount,
    });

    return status;
  }

  /**
   * List all scheduled tasks
   */
  async listJobs(includeDisabled: boolean = false): Promise<CronJob[] | { error: string }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "schedule_list",
      includeDisabled,
    });

    const service = getCronService();
    if (!service) {
      return { error: "Scheduler service is not running" };
    }

    const jobs = await service.list({ includeDisabled });

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "schedule_list",
      success: true,
      count: jobs.length,
    });

    return jobs;
  }

  /**
   * Create a new scheduled task
   */
  async createJob(params: {
    name: string;
    description?: string;
    prompt: string;
    schedule: {
      type: "once" | "interval" | "cron";
      // For 'once': timestamp in ISO format or milliseconds
      at?: string | number;
      // For 'interval': interval string like "5m", "1h", "1d"
      every?: string;
      // For 'cron': cron expression
      cron?: string;
      // Optional timezone for cron
      timezone?: string;
    };
    enabled?: boolean;
    deleteAfterRun?: boolean;
    delivery?: {
      enabled: boolean;
      channelType?: string;
      channelDbId?: string;
      channelId?: string;
      deliverOnSuccess?: boolean;
      deliverOnError?: boolean;
      summaryOnly?: boolean;
      deliverOnlyIfResult?: boolean;
    };
  }): Promise<{ success: boolean; job?: CronJob; error?: string }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "schedule_create",
      name: params.name,
      scheduleType: params.schedule.type,
    });

    const service = getCronService();
    if (!service) {
      return { success: false, error: "Scheduler service is not running" };
    }

    // Parse the schedule into CronSchedule format
    let schedule: CronSchedule;
    try {
      schedule = this.parseSchedule(params.schedule);
    } catch (error: any) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "schedule_create",
        error: error.message,
      });
      return { success: false, error: error.message };
    }

    // Create the job
    const jobCreate: CronJobCreate = {
      name: params.name,
      description: params.description,
      enabled: params.enabled ?? true,
      deleteAfterRun: params.deleteAfterRun ?? params.schedule.type === "once",
      schedule,
      workspaceId: this.workspace.id,
      taskPrompt: params.prompt,
      taskTitle: params.name,
      delivery: params.delivery
        ? {
            enabled: params.delivery.enabled,
            channelType: params.delivery.channelType as any,
            channelDbId: params.delivery.channelDbId,
            channelId: params.delivery.channelId,
            deliverOnSuccess: params.delivery.deliverOnSuccess,
            deliverOnError: params.delivery.deliverOnError,
            summaryOnly: params.delivery.summaryOnly,
            deliverOnlyIfResult: params.delivery.deliverOnlyIfResult,
          }
        : undefined,
    };

    const result = await service.add(jobCreate);

    if (result.ok) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "schedule_create",
        success: true,
        jobId: result.job.id,
        nextRun: result.job.state.nextRunAtMs,
      });
      return { success: true, job: result.job };
    } else {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "schedule_create",
        error: result.error,
      });
      return { success: false, error: result.error };
    }
  }

  /**
   * Update an existing scheduled task
   */
  async updateJob(params: {
    id?: string;
    name?: string; // Can find by name if id not provided
    updates: {
      name?: string;
      description?: string;
      prompt?: string;
      enabled?: boolean;
      schedule?: {
        type: "once" | "interval" | "cron";
        at?: string | number;
        every?: string;
        cron?: string;
        timezone?: string;
      };
      delivery?: {
        enabled: boolean;
        channelType?: string;
        channelId?: string;
        deliverOnSuccess?: boolean;
        deliverOnError?: boolean;
        summaryOnly?: boolean;
        deliverOnlyIfResult?: boolean;
      };
    };
  }): Promise<{ success: boolean; job?: CronJob; error?: string }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "schedule_update",
      id: params.id,
      name: params.name,
    });

    const service = getCronService();
    if (!service) {
      return { success: false, error: "Scheduler service is not running" };
    }

    // Find job by ID or name
    let jobId = params.id;
    if (!jobId && params.name) {
      const jobs = await service.list({ includeDisabled: true });
      const target = params.name.toLowerCase();
      const inWorkspace = jobs.find(
        (j) => j.workspaceId === this.workspace.id && j.name.toLowerCase() === target,
      );
      const global = jobs.find((j) => j.name.toLowerCase() === target);
      const job = inWorkspace ?? global;
      if (job) {
        jobId = job.id;
      }
    }

    if (!jobId) {
      return { success: false, error: "Job not found. Provide a valid job ID or name." };
    }

    // Build patch object
    const patch: any = {};
    if (params.updates.name) patch.name = params.updates.name;
    if (params.updates.description) patch.description = params.updates.description;
    if (params.updates.prompt) patch.taskPrompt = params.updates.prompt;
    if (params.updates.enabled !== undefined) patch.enabled = params.updates.enabled;

    if (params.updates.schedule) {
      try {
        patch.schedule = this.parseSchedule(params.updates.schedule);
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }

    if (params.updates.delivery !== undefined) {
      patch.delivery = params.updates.delivery;
    }

    const result = await service.update(jobId, patch);

    if (result.ok) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "schedule_update",
        success: true,
        jobId: result.job.id,
      });
      return { success: true, job: result.job };
    } else {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "schedule_update",
        error: result.error,
      });
      return { success: false, error: result.error };
    }
  }

  /**
   * Remove a scheduled task
   */
  async removeJob(params: {
    id?: string;
    name?: string;
  }): Promise<{ success: boolean; removed: boolean; error?: string }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "schedule_remove",
      id: params.id,
      name: params.name,
    });

    const service = getCronService();
    if (!service) {
      return { success: false, removed: false, error: "Scheduler service is not running" };
    }

    // Find job by ID or name
    let jobId = params.id;
    if (!jobId && params.name) {
      const jobs = await service.list({ includeDisabled: true });
      const target = params.name.toLowerCase();
      const inWorkspace = jobs.find(
        (j) => j.workspaceId === this.workspace.id && j.name.toLowerCase() === target,
      );
      const global = jobs.find((j) => j.name.toLowerCase() === target);
      const job = inWorkspace ?? global;
      if (job) {
        jobId = job.id;
      }
    }

    if (!jobId) {
      return {
        success: false,
        removed: false,
        error: "Job not found. Provide a valid job ID or name.",
      };
    }

    const result = await service.remove(jobId);

    if (result.ok) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "schedule_remove",
        success: true,
        removed: result.removed,
      });
      return { success: true, removed: result.removed };
    } else {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "schedule_remove",
        error: result.error,
      });
      return { success: false, removed: false, error: result.error };
    }
  }

  /**
   * Run a scheduled task immediately
   */
  async runJob(params: {
    id?: string;
    name?: string;
  }): Promise<{ success: boolean; taskId?: string; error?: string }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "schedule_run",
      id: params.id,
      name: params.name,
    });

    const service = getCronService();
    if (!service) {
      return { success: false, error: "Scheduler service is not running" };
    }

    // Find job by ID or name
    let jobId = params.id;
    if (!jobId && params.name) {
      const jobs = await service.list({ includeDisabled: true });
      const target = params.name.toLowerCase();
      const inWorkspace = jobs.find(
        (j) => j.workspaceId === this.workspace.id && j.name.toLowerCase() === target,
      );
      const global = jobs.find((j) => j.name.toLowerCase() === target);
      const job = inWorkspace ?? global;
      if (job) {
        jobId = job.id;
      }
    }

    if (!jobId) {
      return { success: false, error: "Job not found. Provide a valid job ID or name." };
    }

    const result = await service.run(jobId, "force");

    if (result.ok && result.ran) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "schedule_run",
        success: true,
        taskId: result.taskId,
      });
      return { success: true, taskId: result.taskId };
    } else if (result.ok && !result.ran) {
      return { success: false, error: `Job not run: ${result.reason}` };
    } else {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "schedule_run",
        error: result.error,
      });
      return { success: false, error: result.error };
    }
  }

  /**
   * Get run history for a scheduled task
   */
  async getRunHistory(params: {
    id?: string;
    name?: string;
  }): Promise<CronRunHistoryResult | { error: string }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "schedule_history",
      id: params.id,
      name: params.name,
    });

    const service = getCronService();
    if (!service) {
      return { error: "Scheduler service is not running" };
    }

    // Find job by ID or name
    let jobId = params.id;
    if (!jobId && params.name) {
      const jobs = await service.list({ includeDisabled: true });
      const target = params.name.toLowerCase();
      const inWorkspace = jobs.find(
        (j) => j.workspaceId === this.workspace.id && j.name.toLowerCase() === target,
      );
      const global = jobs.find((j) => j.name.toLowerCase() === target);
      const job = inWorkspace ?? global;
      if (job) {
        jobId = job.id;
      }
    }

    if (!jobId) {
      return { error: "Job not found. Provide a valid job ID or name." };
    }

    const history = await service.getRunHistory(jobId);

    if (history) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "schedule_history",
        success: true,
        totalRuns: history.totalRuns,
      });
      return history;
    } else {
      return { error: "Job not found" };
    }
  }

  /**
   * Parse user-friendly schedule format into CronSchedule
   */
  private parseSchedule(schedule: {
    type: "once" | "interval" | "cron";
    at?: string | number;
    every?: string;
    cron?: string;
    timezone?: string;
  }): CronSchedule {
    switch (schedule.type) {
      case "once": {
        if (!schedule.at) {
          throw new Error('Schedule type "once" requires "at" parameter (timestamp or ISO date)');
        }

        let atMs: number;
        if (typeof schedule.at === "number") {
          atMs = schedule.at;
        } else {
          // Parse ISO date string
          const date = new Date(schedule.at);
          if (isNaN(date.getTime())) {
            throw new Error(`Invalid date format: ${schedule.at}`);
          }
          atMs = date.getTime();
        }

        // Validate it's in the future
        if (atMs <= Date.now()) {
          throw new Error("Scheduled time must be in the future");
        }

        return { kind: "at", atMs };
      }

      case "interval": {
        if (!schedule.every) {
          throw new Error(
            'Schedule type "interval" requires "every" parameter (e.g., "5m", "1h", "1d")',
          );
        }

        const everyMs = this.parseInterval(schedule.every);
        if (!everyMs) {
          throw new Error(
            `Invalid interval format: ${schedule.every}. Use formats like "5m", "1h", "2d"`,
          );
        }

        // Minimum interval is 1 minute
        if (everyMs < 60000) {
          throw new Error("Minimum interval is 1 minute");
        }

        return { kind: "every", everyMs };
      }

      case "cron": {
        if (!schedule.cron) {
          throw new Error('Schedule type "cron" requires "cron" parameter (cron expression)');
        }

        // Basic validation: 5 fields
        const parts = schedule.cron.trim().split(/\s+/);
        if (parts.length !== 5) {
          throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
        }

        return {
          kind: "cron",
          expr: schedule.cron,
          tz: schedule.timezone,
        };
      }

      default:
        throw new Error(`Unknown schedule type: ${schedule.type}`);
    }
  }

  /**
   * Parse interval string to milliseconds
   */
  private parseInterval(interval: string): number | null {
    const match = interval
      .trim()
      .match(
        /^(\d+(?:\.\d+)?)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)$/i,
      );
    if (!match) return null;

    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case "s":
      case "sec":
      case "second":
      case "seconds":
        return value * 1000;
      case "m":
      case "min":
      case "minute":
      case "minutes":
        return value * 60 * 1000;
      case "h":
      case "hr":
      case "hour":
      case "hours":
        return value * 60 * 60 * 1000;
      case "d":
      case "day":
      case "days":
        return value * 24 * 60 * 60 * 1000;
      default:
        return null;
    }
  }

  /**
   * Static method to get tool definitions
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "schedule_task",
        description:
          "Schedule a task to run at a specific time or on a recurring basis. " +
          "Use this for reminders, recurring reports, automated checks, or any task that should run automatically. " +
          "Supports one-time scheduling, intervals (every X minutes/hours/days), and cron expressions. " +
          "Optionally configure delivery to send results to a messaging channel (WhatsApp, Telegram, Slack, Discord, etc.).",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["create", "list", "update", "remove", "run", "history", "status"],
              description:
                "Action to perform: " +
                "create (new scheduled task), " +
                "list (show all tasks), " +
                "update (modify existing task), " +
                "remove (delete task), " +
                "run (execute immediately), " +
                "history (get run history), " +
                "status (get scheduler status)",
            },
            // For create action
            name: {
              type: "string",
              description: "Name/identifier for the scheduled task",
            },
            description: {
              type: "string",
              description: "Optional description of what the task does",
            },
            prompt: {
              type: "string",
              description: "The task prompt that will be executed when the schedule triggers",
            },
            schedule: {
              type: "object",
              description: "Schedule configuration",
              properties: {
                type: {
                  type: "string",
                  enum: ["once", "interval", "cron"],
                  description:
                    "Type of schedule: once (run once at specific time), " +
                    "interval (run every X time), cron (cron expression)",
                },
                at: {
                  type: "string",
                  description:
                    'For "once": ISO date string (e.g., "2025-01-31T09:00:00") or ' +
                    "relative time description for the agent to convert",
                },
                every: {
                  type: "string",
                  description:
                    'For "interval": Duration like "5m" (5 minutes), "1h" (1 hour), "1d" (1 day)',
                },
                cron: {
                  type: "string",
                  description:
                    'For "cron": Standard 5-field cron expression. ' +
                    'Examples: "0 9 * * *" (daily 9am), "0 9 * * 1-5" (weekdays 9am), ' +
                    '"*/15 * * * *" (every 15 min)',
                },
                timezone: {
                  type: "string",
                  description: 'Timezone for cron schedules (e.g., "America/New_York")',
                },
              },
            },
            enabled: {
              type: "boolean",
              description: "Whether the task is enabled (default: true)",
            },
            deleteAfterRun: {
              type: "boolean",
              description: 'Delete the task after it runs once (default: true for "once" type)',
            },
            delivery: {
              type: "object",
              description:
                "Channel delivery configuration — send job results to a messaging channel",
              properties: {
                enabled: {
                  type: "boolean",
                  description: "Whether delivery is enabled",
                },
                channelType: {
                  type: "string",
                  enum: [
                    "telegram",
                    "discord",
                    "slack",
                    "whatsapp",
                    "imessage",
                    "signal",
                    "mattermost",
                    "matrix",
                    "email",
                    "teams",
                    "googlechat",
                  ],
                  description: "Type of messaging channel to deliver to",
                },
                channelDbId: {
                  type: "string",
                  description:
                    "Database ID of the specific channel instance (from channel list). Use this when multiple channels of the same type exist.",
                },
                channelId: {
                  type: "string",
                  description:
                    "Chat ID / conversation ID on the target channel (e.g., WhatsApp JID, Telegram chat ID)",
                },
                deliverOnSuccess: {
                  type: "boolean",
                  description: "Deliver results when the task succeeds (default: true)",
                },
                deliverOnError: {
                  type: "boolean",
                  description: "Deliver notification when the task fails (default: true)",
                },
                summaryOnly: {
                  type: "boolean",
                  description:
                    "Send only a status summary, not the full result text (default: false)",
                },
                deliverOnlyIfResult: {
                  type: "boolean",
                  description:
                    "Only deliver on success when a non-empty result is available (default: false)",
                },
              },
            },
            // For update/remove/run/history actions
            id: {
              type: "string",
              description: "ID of the task to update/remove/run",
            },
            // For list action
            includeDisabled: {
              type: "boolean",
              description: "Include disabled tasks in the list (default: false)",
            },
            // For update action
            updates: {
              type: "object",
              description: "Fields to update",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                prompt: { type: "string" },
                enabled: { type: "boolean" },
                schedule: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["once", "interval", "cron"] },
                    at: { type: "string" },
                    every: { type: "string" },
                    cron: { type: "string" },
                    timezone: { type: "string" },
                  },
                },
                delivery: {
                  type: "object",
                  description: "Channel delivery config update",
                  properties: {
                    enabled: { type: "boolean" },
                    channelType: { type: "string" },
                    channelDbId: { type: "string" },
                    channelId: { type: "string" },
                    deliverOnSuccess: { type: "boolean" },
                    deliverOnError: { type: "boolean" },
                    summaryOnly: { type: "boolean" },
                    deliverOnlyIfResult: { type: "boolean" },
                  },
                },
              },
            },
          },
          required: ["action"],
        },
      },
    ];
  }

  /**
   * Execute a schedule tool action
   */
  async executeAction(input: {
    action: "create" | "list" | "update" | "remove" | "run" | "history" | "status";
    name?: string;
    description?: string;
    prompt?: string;
    schedule?: {
      type: "once" | "interval" | "cron";
      at?: string | number;
      every?: string;
      cron?: string;
      timezone?: string;
    };
    enabled?: boolean;
    deleteAfterRun?: boolean;
    delivery?: {
      enabled: boolean;
      channelType?: string;
      channelDbId?: string;
      channelId?: string;
      deliverOnSuccess?: boolean;
      deliverOnError?: boolean;
      summaryOnly?: boolean;
      deliverOnlyIfResult?: boolean;
    };
    id?: string;
    includeDisabled?: boolean;
    updates?: {
      name?: string;
      description?: string;
      prompt?: string;
      enabled?: boolean;
      schedule?: {
        type: "once" | "interval" | "cron";
        at?: string | number;
        every?: string;
        cron?: string;
        timezone?: string;
      };
      delivery?: {
        enabled: boolean;
        channelType?: string;
        channelDbId?: string;
        channelId?: string;
        deliverOnSuccess?: boolean;
        deliverOnError?: boolean;
        summaryOnly?: boolean;
        deliverOnlyIfResult?: boolean;
      };
    };
  }): Promise<any> {
    switch (input.action) {
      case "status":
        return this.getStatus();

      case "list":
        return this.listJobs(input.includeDisabled);

      case "create":
        if (!input.name || !input.prompt || !input.schedule) {
          throw new Error("Create action requires: name, prompt, and schedule");
        }
        return this.createJob({
          name: input.name,
          description: input.description,
          prompt: input.prompt,
          schedule: input.schedule,
          enabled: input.enabled,
          deleteAfterRun: input.deleteAfterRun,
          delivery: input.delivery,
        });

      case "update":
        if (!input.id && !input.name) {
          throw new Error("Update action requires: id or name");
        }
        if (!input.updates) {
          throw new Error("Update action requires: updates object");
        }
        return this.updateJob({
          id: input.id,
          name: input.name,
          updates: input.updates,
        });

      case "remove":
        if (!input.id && !input.name) {
          throw new Error("Remove action requires: id or name");
        }
        return this.removeJob({ id: input.id, name: input.name });

      case "run":
        if (!input.id && !input.name) {
          throw new Error("Run action requires: id or name");
        }
        return this.runJob({ id: input.id, name: input.name });

      case "history":
        if (!input.id && !input.name) {
          throw new Error("History action requires: id or name");
        }
        return this.getRunHistory({ id: input.id, name: input.name });

      default:
        throw new Error(`Unknown action: ${input.action}`);
    }
  }
}
