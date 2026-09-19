import type { LLMProvider, LLMRequest, LLMResponse } from "./types";

export const DEFAULT_LOCAL_INFERENCE_CAPACITY = 1;

type Release = () => void;
type QueuedWaiter = {
  signal?: AbortSignal;
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
};

function cancellationError(): Error {
  const error = new Error("Request cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Shared admission for one local serving resource. The permit only covers
 * inference; it is released before the caller's tool scheduler runs.
 */
export class LocalInferenceAdmission {
  private active = 0;
  private readonly queue: QueuedWaiter[] = [];
  readonly capacity: number;

  constructor(
    readonly resourceKey: string,
    capacity = DEFAULT_LOCAL_INFERENCE_CAPACITY,
  ) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) throw cancellationError();
    if (this.active < this.capacity) {
      this.active += 1;
      return this.createRelease();
    }

    return new Promise<Release>((resolve, reject) => {
      const waiter: QueuedWaiter = { signal, resolve, reject };
      const remove = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const onAbort = () => {
        remove();
        reject(cancellationError());
      };
      waiter.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private createRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.capacity && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      if (waiter.signal?.aborted) {
        waiter.reject(cancellationError());
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}

const admissions = new Map<string, LocalInferenceAdmission>();

export function getLocalInferenceAdmission(resourceKey: string): LocalInferenceAdmission {
  const existing = admissions.get(resourceKey);
  if (existing) return existing;
  const created = new LocalInferenceAdmission(resourceKey);
  admissions.set(resourceKey, created);
  return created;
}

export function clearLocalInferenceAdmissionsForTests(): void {
  admissions.clear();
}

export function wrapProviderWithLocalInferenceAdmission(
  provider: LLMProvider,
  resourceKey?: string,
): LLMProvider {
  if (!resourceKey) return provider;
  const admission = getLocalInferenceAdmission(resourceKey);
  const wrapped: LLMProvider = {
    type: provider.type,
    createMessage(request: LLMRequest): Promise<LLMResponse> {
      return admission.run(request.signal, () => provider.createMessage(request));
    },
    testConnection: () => provider.testConnection(),
  };
  (wrapped as Any).__localInferenceAdmissionWrapped = true;
  return wrapped;
}
