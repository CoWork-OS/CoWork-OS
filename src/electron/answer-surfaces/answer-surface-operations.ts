/**
 * Interactive answer surface requests, independent of Electron so the desktop IPC and
 * the browser host share one implementation. Payloads come from a renderer and are
 * validated with zod here; state is only read or written for a task the caller may
 * use, and image lookups run under that task's network policy.
 */
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/types";
import {
  MAX_ANSWER_IMAGE_REQUESTS,
  type AnswerImageRequest,
  type AnswerImageResult,
} from "../../shared/answer-surfaces/images";
import type { AnswerImageNetworkContext } from "./AnswerImageService";
import {
  MAX_ANSWER_SURFACE_STATE_BYTES,
  MAX_ANSWER_SURFACE_SUMMARY_CHARS,
  type AnswerSurfaceStateRow,
} from "./answer-surface-state-sql";
import {
  HtmlSurfaceStateSchema,
  summarizeHtmlSurfaceState,
} from "../../shared/answer-surfaces/html-bridge";
import {
  AnswerSurfaceDataSchema,
  MAX_ANSWER_DATA_CELLS,
  type AnswerDataResult,
  type AnswerDataTable,
} from "../../shared/answer-surfaces/data";
import { rateLimiter } from "../utils/rate-limiter";
import { validateInput } from "../utils/validation";

const TaskIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_:.-]+$/);
const SurfaceKeySchema = z
  .string()
  .min(1)
  .max(80)
  // s1: native component surfaces; h1: inline HTML surfaces (see html-bridge.ts).
  .regex(/^(?:s1|h1)-[a-z0-9]+-\d{1,3}$/);
const StateValueSchema = z.union([
  z.number().finite(),
  z.string().max(200),
  z.boolean(),
  z.array(z.string().max(60)).max(60),
]);

export const AnswerSurfaceGetStateSchema = z
  .object({ taskId: TaskIdSchema, keys: z.array(SurfaceKeySchema).min(1).max(40) })
  .strict();

export const AnswerSurfaceSaveStateSchema = z
  .object({
    taskId: TaskIdSchema,
    key: SurfaceKeySchema,
    state: z.record(z.string().max(40), StateValueSchema),
    summary: z.string().max(MAX_ANSWER_SURFACE_SUMMARY_CHARS),
  })
  .strict()
  .refine((value) => Object.keys(value.state).length <= 60, "Too many state values")
  .refine(
    (value) => JSON.stringify(value.state).length <= MAX_ANSWER_SURFACE_STATE_BYTES,
    "State is too large",
  );

export const AnswerSurfaceResolveImagesSchema = z
  .object({
    taskId: TaskIdSchema.optional(),
    requests: z
      .array(
        z
          .object({
            query: z.string().trim().min(1).max(200).optional(),
            src: z
              .string()
              .trim()
              .max(2048)
              .regex(/^https:\/\//i)
              .optional(),
          })
          .strict()
          .refine((value) => Boolean(value.query) !== Boolean(value.src), "query or src"),
      )
      .min(1)
      .max(MAX_ANSWER_IMAGE_REQUESTS),
  })
  .strict();

export const AnswerSurfaceLoadDataSchema = z
  .object({ taskId: TaskIdSchema, sources: AnswerSurfaceDataSchema })
  .strict();

export interface AnswerSurfaceIpcDeps {
  taskExists: (taskId: string) => Promise<boolean>;
  /** The network policy inputs for lookups made on a task's behalf. */
  resolveNetworkContext: (taskId: string | undefined) => Promise<AnswerImageNetworkContext>;
  images: {
    resolve(
      requests: AnswerImageRequest[],
      context: AnswerImageNetworkContext,
    ): Promise<Array<AnswerImageResult | null>>;
  };
  store: {
    get(taskId: string, keys: string[]): Promise<AnswerSurfaceStateRow[]>;
    save(taskId: string, key: string, state: unknown, summary: string): Promise<void>;
  };
  /**
   * Reads a workspace file of the task as a table. It must resolve the path inside that
   * task's workspace; hosts without workspace file access leave it out.
   */
  loadDataSource?: (
    taskId: string,
    filePath: string,
    options: { maxCells: number },
  ) => Promise<AnswerDataTable>;
  /** Throws when the channel is over its rate limit. */
  checkRateLimit?: (channel: string) => void;
}

type Handler = (raw: unknown) => Promise<unknown>;

function defaultRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    const resetSec = Math.ceil(rateLimiter.getResetTime(channel) / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

/** The operations by IPC channel; tests and the browser host call them directly. */
export function createAnswerSurfaceIpcHandlers(
  deps: AnswerSurfaceIpcDeps,
): Record<string, Handler> {
  const limit = deps.checkRateLimit ?? defaultRateLimit;
  const requireTask = async (taskId: string) => {
    if (!(await deps.taskExists(taskId))) throw new Error("Task not found");
  };
  return {
    [IPC_CHANNELS.ANSWER_SURFACE_GET_STATE]: async (raw) => {
      limit(IPC_CHANNELS.ANSWER_SURFACE_GET_STATE);
      const value = validateInput(AnswerSurfaceGetStateSchema, raw, "answer surface state request");
      await requireTask(value.taskId);
      const rows = await deps.store.get(value.taskId, value.keys);
      return Object.fromEntries(rows.map((row) => [row.key, row.state]));
    },
    [IPC_CHANNELS.ANSWER_SURFACE_SAVE_STATE]: async (raw) => {
      limit(IPC_CHANNELS.ANSWER_SURFACE_SAVE_STATE);
      const value = validateInput(AnswerSurfaceSaveStateSchema, raw, "answer surface state");
      await requireTask(value.taskId);
      if (value.key.startsWith("h1-")) {
        // An HTML surface's state is written by the page, not by our components: hold it
        // to the stricter bridge schema and build its summary here, from the state alone.
        const state = validateInput(HtmlSurfaceStateSchema, value.state, "HTML surface state");
        await deps.store.save(value.taskId, value.key, state, summarizeHtmlSurfaceState(state));
        return { ok: true };
      }
      await deps.store.save(value.taskId, value.key, value.state, value.summary);
      return { ok: true };
    },
    [IPC_CHANNELS.ANSWER_SURFACE_LOAD_DATA]: async (raw) => {
      limit(IPC_CHANNELS.ANSWER_SURFACE_LOAD_DATA);
      const value = validateInput(AnswerSurfaceLoadDataSchema, raw, "answer data request");
      await requireTask(value.taskId);
      const results: Record<string, AnswerDataResult> = {};
      const entries = Object.entries(value.sources);
      // One cell budget shared by the block's files.
      const maxCells = Math.floor(MAX_ANSWER_DATA_CELLS / entries.length);
      for (const [id, filePath] of entries) {
        if (!deps.loadDataSource) {
          results[id] = { file: filePath, error: "Data files are read in the desktop app" };
          continue;
        }
        try {
          results[id] = await deps.loadDataSource(value.taskId, filePath, { maxCells });
        } catch (error) {
          // Only messages written for the user are shown; raw errors can carry absolute
          // paths or file contents (parser messages), so they become a generic message.
          const safe = error instanceof Error && error.name === "AnswerDataError";
          results[id] = {
            file: filePath,
            error: safe ? error.message.slice(0, 200) : "The file could not be read",
          };
        }
      }
      return results;
    },
    [IPC_CHANNELS.ANSWER_SURFACE_RESOLVE_IMAGES]: async (raw) => {
      limit(IPC_CHANNELS.ANSWER_SURFACE_RESOLVE_IMAGES);
      const value = validateInput(AnswerSurfaceResolveImagesSchema, raw, "answer image request");
      if (value.taskId) await requireTask(value.taskId);
      const context = await deps.resolveNetworkContext(value.taskId);
      return deps.images.resolve(value.requests, context);
    },
  };
}
