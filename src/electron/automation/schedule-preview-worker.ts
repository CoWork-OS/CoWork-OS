import { parentPort, workerData } from "node:worker_threads";
import { computeNextRunAtMs } from "../cron/schedule";
parentPort!.postMessage(computeNextRunAtMs(workerData.schedule, workerData.now) ?? null);
