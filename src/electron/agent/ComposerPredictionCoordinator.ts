import type { ComposerPrediction } from "../../shared/composer-predictions";

type Subscriber = { resolve: (value: ComposerPrediction | null) => void; job: Job };
type Job = {
  key: string;
  run: (signal: AbortSignal) => Promise<ComposerPrediction | null>;
  controller: AbortController;
  subscribers: Set<string>;
};

/** One provider call at a time. Cancellation keeps the slot until the provider settles. */
export class ComposerPredictionCoordinator {
  private cache = new Map<string, { value: ComposerPrediction; expires: number }>();
  private jobs = new Map<string, Job>();
  private subscribers = new Map<string, Subscriber>();
  private cancelled = new Map<string, number>();
  private destroyedOwners = new Set<number>();
  private queue: Job[] = [];
  private running = false;

  constructor(private readonly options = { maxQueued: 8, maxCache: 100, cacheTtlMs: 300_000 }) {}

  request(
    owner: number,
    requestId: string,
    key: string,
    run: Job["run"],
  ): Promise<ComposerPrediction | null> {
    if (this.destroyedOwners.has(owner)) return Promise.resolve(null);
    const token = `${owner}:${requestId}`;
    // Cancel IPC may arrive while the request is still reading its context.
    for (const [id, expiry] of this.cancelled) if (expiry <= Date.now()) this.cancelled.delete(id);
    if (this.cancelled.delete(token)) return Promise.resolve(null);
    if (this.subscribers.has(token)) return Promise.resolve(null);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
    this.cache.delete(key);
    let job = this.jobs.get(key);
    if (!job) {
      if (this.running && this.queue.length >= this.options.maxQueued) return Promise.resolve(null);
      job = { key, run, controller: new AbortController(), subscribers: new Set() };
      this.jobs.set(key, job);
      this.queue.push(job);
    }
    const selectedJob = job;
    const pending = new Promise<ComposerPrediction | null>((resolve) => {
      selectedJob.subscribers.add(token);
      this.subscribers.set(token, { resolve, job: selectedJob });
    });
    this.drain();
    return pending;
  }

  cancel(owner: number, requestId: string): void {
    const token = `${owner}:${requestId}`;
    const subscriber = this.subscribers.get(token);
    if (!subscriber) {
      if (this.cancelled.size >= 100) this.cancelled.delete(this.cancelled.keys().next().value!);
      this.cancelled.set(token, Date.now() + 30_000);
      return;
    }
    this.subscribers.delete(token);
    subscriber.resolve(null);
    const job = subscriber.job;
    job.subscribers.delete(token);
    if (job.subscribers.size === 0) {
      job.controller.abort();
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      this.queue = this.queue.filter((queued) => queued !== job);
    }
  }

  cancelOwner(owner: number): void {
    // Context reads may still be pending when the owning window is destroyed.
    this.destroyedOwners.add(owner);
    for (const token of this.subscribers.keys()) {
      if (token.startsWith(`${owner}:`)) this.cancel(owner, token.slice(String(owner).length + 1));
    }
  }

  private drain(): void {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = true;
    void this.execute(job);
  }

  private async execute(job: Job): Promise<void> {
    let result: ComposerPrediction | null = null;
    try {
      if (!job.controller.signal.aborted) result = await job.run(job.controller.signal);
    } catch {
      /* Failures remain retryable; never cache them. */
    }
    if (job.controller.signal.aborted) result = null;
    if (result && job.subscribers.size > 0) {
      if (this.cache.size >= this.options.maxCache)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(job.key, { value: result, expires: Date.now() + this.options.cacheTtlMs });
    }
    for (const token of job.subscribers) {
      this.subscribers.get(token)?.resolve(result);
      this.subscribers.delete(token);
    }
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    this.running = false;
    this.drain();
  }
}
