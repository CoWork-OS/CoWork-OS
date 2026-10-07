import { Worker } from "node:worker_threads";

export class RegexDeadlineError extends Error {}

// Keep JavaScript regex compatibility without executing untrusted patterns on
// the application event loop. The parent can terminate even a stuck RegExp.
export class BoundedRegex {
  private worker?: Worker;
  private online?: Promise<void>;
  private termination?: Promise<number>;
  private spentMs = 0;

  // Each call gets its own deadline (worker boot excluded), and all calls share
  // one total budget so a many-file search cannot run unbounded.
  constructor(
    private readonly callDeadlineMs = 500,
    private readonly totalBudgetMs = 30_000,
  ) {}

  async evaluate(
    pattern: string,
    flags: string,
    texts: string[],
    mode: "test" | "count",
    limit = Number.MAX_SAFE_INTEGER,
  ): Promise<number[]> {
    this.worker ||= new Worker(
      `const { parentPort } = require('node:worker_threads');
       parentPort.on('message', ({pattern, flags, texts, mode, limit}) => {
         try {
           const regex = new RegExp(pattern, flags);
           const result = [];
           for (let i = 0; i < texts.length; i++) {
             regex.lastIndex = 0;
             if (mode === 'count') {
               let count = 0, match;
               while ((match = regex.exec(texts[i])) !== null) {
                 count++;
                 if (match[0] === '') regex.lastIndex++;
               }
               result.push(count);
             } else if (regex.test(texts[i])) {
               result.push(i);
               if (result.length >= limit) break;
             }
           }
           parentPort.postMessage({result});
         } catch (error) { parentPort.postMessage({error: error.message}); }
       });`,
      { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32 } },
    );
    const worker = this.worker;
    this.online ||= new Promise((resolve, reject) => {
      worker.once("online", () => resolve());
      worker.once("error", reject);
    });
    try {
      await this.online;
    } catch (error) {
      await this.close();
      throw new RegexDeadlineError((error as Error).message);
    }
    const remainingMs = this.totalBudgetMs - this.spentMs;
    if (remainingMs <= 0) {
      throw new RegexDeadlineError("Regex search exceeded its total execution budget");
    }
    const startedAt = Date.now();
    return new Promise<number[]>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.spentMs += Date.now() - startedAt;
        worker.removeListener("message", onMessage);
        worker.removeListener("error", onError);
        worker.removeListener("exit", onExit);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new RegexDeadlineError(error.message));
      };
      const onExit = () => onError(new RegexDeadlineError("Regex worker exited before completing"));
      const onMessage = (message: { result: number[]; error?: string }) => {
        cleanup();
        if (message.error) reject(new Error(message.error));
        else resolve(message.result);
      };
      const timer = setTimeout(
        () => {
          cleanup();
          void this.close();
          reject(new RegexDeadlineError("Regex search exceeded its execution deadline"));
        },
        Math.min(this.callDeadlineMs, remainingMs),
      );
      worker.once("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      worker.postMessage({ pattern, flags, texts, mode, limit });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    this.online = undefined;
    if (worker) this.termination = worker.terminate();
    await this.termination;
  }
}
