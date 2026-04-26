import * as path from "path";
import type { Task } from "../../shared/types";
import { isAutomatedTaskLike } from "../../shared/automated-task-detection";
import { COWORK_AUTOMATED_OUTPUT_ROOT } from "./workspace-private-paths";

export const MANAGED_AUTOMATED_OUTPUT_ROOT = COWORK_AUTOMATED_OUTPUT_ROOT;

export function shouldUseManagedAutomatedOutput(task: Task | null | undefined): boolean {
  return isAutomatedTaskLike(task);
}

export function isAlreadyInManagedOutputZone(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    normalized === ".cowork" ||
    normalized.startsWith(".cowork/") ||
    normalized.startsWith(`${MANAGED_AUTOMATED_OUTPUT_ROOT}/`)
  );
}

export function buildManagedAutomatedOutputPath(taskId: string, requestedPath: string): string {
  const normalized = requestedPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const safeRelative = normalized.length > 0 ? normalized : "output.txt";
  return path.posix.join(MANAGED_AUTOMATED_OUTPUT_ROOT, taskId, safeRelative);
}
