import { Worker } from "worker_threads";
import path from "path";
import type { MemorySearchResult } from "./repositories";

export type PromptRecallWorkerResult = MemorySearchResult & {
  source: "db";
  content?: string;
};

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CRASH_RESTARTS = 5;
const BASE_RESTART_DELAY_MS = 1_000;

export class FtsWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private readonly dbPath: string;
  private destroyed = false;
  private crashCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private handlingCrash = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.spawnWorker();
  }

  private spawnWorker(): void {
    if (this.destroyed) return;
    this.handlingCrash = false;
    this.worker = new Worker(path.join(__dirname, "fts-worker.js"), {
      workerData: { dbPath: this.dbPath },
    });
    this.worker.on("message", (msg: { id: string; result?: unknown; error?: string }) => {
      const req = this.pending.get(msg.id);
      if (!req) return;
      this.pending.delete(msg.id);
      clearTimeout(req.timer);
      if (msg.error) {
        req.reject(new Error(msg.error));
      } else {
        this.crashCount = 0;
        req.resolve(msg.result);
      }
    });
    this.worker.on("error", () => this.handleWorkerCrash());
    this.worker.on("exit", (code) => {
      if (code !== 0 && !this.destroyed) this.handleWorkerCrash();
    });
  }

  private handleWorkerCrash(): void {
    if (this.handlingCrash) return;
    this.handlingCrash = true;
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("FTS worker crashed"));
      this.pending.delete(id);
    }
    this.worker = null;
    if (this.destroyed) return;
    this.crashCount++;
    if (this.crashCount > MAX_CRASH_RESTARTS) return;
    if (this.restartTimer) return;
    const delay = Math.min(BASE_RESTART_DELAY_MS * 2 ** (this.crashCount - 1), 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnWorker();
    }, delay);
  }

  private request(method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.worker || this.destroyed) {
        reject(new Error("FTS worker not available"));
        return;
      }
      const id = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("FTS worker request timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, args });
    });
  }

  async search(
    workspaceId: string,
    query: string,
    limit: number,
    includePrivate: boolean,
  ): Promise<MemorySearchResult[]> {
    return (await this.request("search", [
      workspaceId,
      query,
      limit,
      includePrivate,
    ])) as MemorySearchResult[];
  }

  async searchImportedGlobal(
    query: string,
    limit: number,
    includePrivate: boolean,
  ): Promise<MemorySearchResult[]> {
    return (await this.request("searchImportedGlobal", [
      query,
      limit,
      includePrivate,
    ])) as MemorySearchResult[];
  }

  async searchLocalForPromptRecall(
    workspaceId: string,
    query: string,
    limit: number,
  ): Promise<PromptRecallWorkerResult[]> {
    return (await this.request("searchLocalForPromptRecall", [
      workspaceId,
      query,
      limit,
    ])) as PromptRecallWorkerResult[];
  }

  async searchByContentMarker(
    workspaceId: string,
    marker: string,
    limit: number,
  ): Promise<MemorySearchResult[]> {
    return (await this.request("searchByContentMarker", [
      workspaceId,
      marker,
      limit,
    ])) as MemorySearchResult[];
  }

  destroy(): void {
    this.destroyed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("FTS worker destroyed"));
      this.pending.delete(id);
    }
    this.worker?.terminate();
    this.worker = null;
  }
}
