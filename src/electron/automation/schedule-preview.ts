import { Worker } from "node:worker_threads";
import path from "node:path";
import type { CronSchedule } from "../cron/types";
let active = 0;
/** Cron searches can be expensive for sparse schedules. Keep a read-only preview
 * off the app event loop, with bounded concurrency and a deadline. */
export async function previewSchedule(
  schedule: CronSchedule,
  now: number,
): Promise<number | undefined> {
  if (active >= 5) throw new Error("Schedule preview is busy");
  active += 1;
  try {
    return await new Promise<number | undefined>((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "schedule-preview-worker.js"), {
        workerData: { schedule, now },
      });
      let settled = false;
      const finish = (error?: Error, value?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error("Schedule preview timed out")), 2000);
      worker.once("message", (value: unknown) => {
        if (value === null || (typeof value === "number" && Number.isFinite(value)))
          finish(undefined, value === null ? undefined : value);
        else finish(new Error("Invalid schedule preview"));
      });
      worker.once("error", (error) =>
        finish(error instanceof Error ? error : new Error("Schedule preview failed")),
      );
      worker.once("exit", () => {
        if (!settled) finish(new Error("Schedule preview exited without a result"));
      });
    });
  } finally {
    active -= 1;
  }
}
