import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { Workspace } from "../../../shared/types";
import { captureDiscoveryContext, type DiscoveryContext } from "./file-discovery-context";
import type { GlobDiscoveryInput, GlobResult } from "./glob-discovery";

export interface GrepDiscoveryInput {
  basePath: string;
  globPattern?: string;
  agentRoleId: string | null;
}
export type DiscoveryRequest = {
  workspace: Workspace;
  context: DiscoveryContext;
} & ({ kind: "glob"; input: GlobDiscoveryInput } | { kind: "grep"; input: GrepDiscoveryInput });
type GrepResult = { files: string[]; gitIgnoredSkipped: number };
export interface DiscoveryResponse {
  result?: GlobResult[] | GrepResult;
  error?: string;
}

/** A small shared queue keeps concurrent sessions from starting unbounded scans/workers.
 * Identical in-flight requests share their result; completed results are never cached because
 * files, profile rules and task-local grants can change between tool calls. */
export class FileDiscoveryService {
  private active = 0;
  private waiting: Array<() => void> = [];
  private inFlight = new Map<string, Promise<GlobResult[] | GrepResult>>();
  constructor(
    private options: {
      workerPath?: string;
      concurrency?: number;
      maxQueue?: number;
      timeoutMs?: number;
      createWorker?: (request: DiscoveryRequest) => Worker;
    } = {},
  ) {}

  async discoverGlob(workspace: Workspace, input: GlobDiscoveryInput): Promise<GlobResult[]> {
    return this.discover(workspace, { kind: "glob", input }) as Promise<GlobResult[]>;
  }
  async discoverGrep(workspace: Workspace, input: GrepDiscoveryInput): Promise<GrepResult> {
    return this.discover(workspace, { kind: "grep", input }) as Promise<GrepResult>;
  }
  private async discover(workspace: Workspace, query: Pick<DiscoveryRequest, "kind" | "input">) {
    const context = captureDiscoveryContext();
    // Copy only filesystem policy, rather than any credentials/metadata on a workspace.
    const snapshot = JSON.parse(
      JSON.stringify({
        path: workspace.path,
        permissions: workspace.permissions,
        isTemp: workspace.isTemp,
      }),
    ) as Workspace;
    const request = { ...query, workspace: snapshot, context } as DiscoveryRequest;
    const key = JSON.stringify(request);
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.enqueue(request);
      this.inFlight.set(key, pending);
      void pending.finally(() => this.inFlight.delete(key)).catch(() => {});
    }
    const result = await pending;
    if (
      JSON.stringify(captureDiscoveryContext()) !== JSON.stringify(context) ||
      JSON.stringify({
        path: workspace.path,
        permissions: workspace.permissions,
        isTemp: workspace.isTemp,
      }) !==
        JSON.stringify({
          path: snapshot.path,
          permissions: snapshot.permissions,
          isTemp: snapshot.isTemp,
        })
    ) {
      throw new Error("Filesystem policy changed during discovery; retry the search");
    }
    return result;
  }
  private enqueue(request: DiscoveryRequest): Promise<GlobResult[] | GrepResult> {
    const concurrency = this.options.concurrency ?? 2;
    if (this.active >= concurrency && this.waiting.length >= (this.options.maxQueue ?? 16)) {
      return Promise.reject(new Error("File discovery is busy; retry with a narrower path"));
    }
    return new Promise((resolve, reject) => {
      let started = false;
      const queueTimer = setTimeout(() => {
        const index = this.waiting.indexOf(start);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error("File discovery queue timed out"));
      }, this.options.timeoutMs ?? 30_000);
      const start = () => {
        if (started) return;
        started = true;
        clearTimeout(queueTimer);
        this.active++;
        void this.runWorker(request)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.waiting.shift()?.();
          });
      };
      if (this.active < concurrency) start();
      else this.waiting.push(start);
    });
  }
  private async runWorker(request: DiscoveryRequest): Promise<GlobResult[] | GrepResult> {
    const worker =
      this.options.createWorker?.(request) ??
      new Worker(this.options.workerPath ?? path.join(__dirname, "file-discovery-worker.js"), {
        workerData: request,
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: GlobResult[] | GrepResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          worker.removeListener("message", onMessage);
          worker.removeListener("exit", onExit);
          // Keep the error handler until termination, including startup failures.
          if (error) reject(error);
          else resolve(value!);
        };
        const timer = setTimeout(
          () =>
            finish(
              new Error("File discovery exceeded its execution deadline; narrow path or glob"),
            ),
          this.options.timeoutMs ?? 30_000,
        );
        const onMessage = (response: DiscoveryResponse) => {
          if (response?.error) finish(new Error(response.error));
          else if (
            response?.result &&
            typeof response.result === "object" &&
            (request.kind === "glob"
              ? Array.isArray(response.result)
              : "files" in response.result && Array.isArray(response.result.files))
          )
            finish(undefined, response.result);
          else finish(new Error("Invalid file discovery response"));
        };
        worker.once("error", (error) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
        const onExit = () => finish(new Error("File discovery worker exited without a result"));
        worker.once("message", onMessage);
        worker.once("exit", onExit);
      });
    } finally {
      await worker.terminate();
    }
  }
}
export const fileDiscoveryService = new FileDiscoveryService();
