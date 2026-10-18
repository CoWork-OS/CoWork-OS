/// <reference types="vite/client" />

import ElkApi, {
  type ELK,
  type ELKConstructorArguments,
  type ElkLayoutArguments,
  type ElkNode,
} from "elkjs/lib/elk-api.js";
import workerUrl from "elkjs/lib/elk-worker.min.js?url";

const UI_ONLY = Symbol("ELK rendering metadata");

/** Copy transport data without serializing away JSON values or UI identities. */
function workerData(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "function" || typeof value === "symbol") return UI_ONLY;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    // Dates, buffers and other structured-clone data remain supported. DOM
    // handles, selections and other opaque UI objects stay only in the input.
    let copy: unknown;
    try {
      copy = structuredClone(value);
    } catch {
      copy = UI_ONLY;
    }
    seen.set(value, copy);
    return copy;
  }
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  if (Array.isArray(copy)) copy.length = (value as unknown[]).length;
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    const transported = workerData(entry, seen);
    if (transported !== UI_ONLY) {
      Object.defineProperty(copy, key, {
        value: transported,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return copy;
}

function objectId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/** Match layout entities by ID, preserving anonymous labels by their ELK order. */
function restoreLayoutData(
  value: unknown,
  original: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const target: unknown[] = Array.isArray(original) ? original : [];
    const previous = target.slice();
    const byId = new Map<string, unknown>();
    for (const entry of previous) {
      const id = objectId(entry);
      if (id !== undefined) byId.set(id, byId.has(id) ? undefined : entry);
    }
    seen.set(value, target);
    target.length = value.length;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) continue;
      const id = objectId(value[index]);
      const atIndex = previous[index];
      const prior =
        (id !== undefined ? byId.get(id) : undefined) ??
        (objectId(atIndex) === undefined || objectId(atIndex) === id ? atIndex : undefined);
      target[index] = restoreLayoutData(value[index], prior, seen);
    }
    return target;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return original !== null && typeof original === "object" ? original : value;
  }
  const target =
    original !== null && typeof original === "object" && !Array.isArray(original)
      ? (original as Record<string, unknown>)
      : {};
  seen.set(value, target);
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(target, key, {
      value: restoreLayoutData(entry, Object.hasOwn(target, key) ? target[key] : undefined, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return target;
}

/**
 * Mermaid creates an ELK instance for each render without terminating it. Keep
 * the upstream RPC API, but give every request a real, short-lived worker. Vite
 * emits the unchanged ELK worker as an asset instead of evaluating it on the UI
 * thread; its URL follows the renderer's HTTP or packaged file base.
 */
export default class ElkWorkerAdapter implements ELK {
  private readonly pending = new Set<() => void>();

  constructor(private readonly options: ELKConstructorArguments = {}) {}

  layout(graph: ElkNode, args?: ElkLayoutArguments): Promise<ElkNode> {
    return this.run(async (elk, isActive) => {
      const result = await elk.layout(workerData(graph) as ElkNode, args);
      // The RPC client defers replies through setTimeout. Terminating its worker
      // cannot retract an already queued reply, which must not mutate the input.
      if (!isActive()) throw new DOMException("ELK worker terminated.", "AbortError");
      // The former bundled fake worker mutated the graph in place. Restore
      // that behavior, retaining functions/DOM metadata which ELK never uses.
      return restoreLayoutData(result, graph) as ElkNode;
    });
  }

  knownLayoutAlgorithms() {
    return this.run((elk) => elk.knownLayoutAlgorithms());
  }

  knownLayoutOptions() {
    return this.run((elk) => elk.knownLayoutOptions());
  }

  knownLayoutCategories() {
    return this.run((elk) => elk.knownLayoutCategories());
  }

  /** Cancel all requests, including their promises; subsequent requests are fresh. */
  terminateWorker(): void {
    for (const cancel of this.pending) cancel();
  }

  private run<T>(operation: (elk: ELK, isActive: () => boolean) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let worker: Worker | undefined;
      let settled = false;
      const finish = (succeeded: boolean, value: T | unknown) => {
        if (settled) return;
        settled = true;
        this.pending.delete(cancel);
        if (worker) {
          worker.removeEventListener("error", onError);
          worker.removeEventListener("messageerror", onMessageError);
          worker.terminate();
        }
        if (succeeded) resolve(value as T);
        else reject(value);
      };
      const cancel = () => finish(false, new DOMException("ELK worker terminated.", "AbortError"));
      const onError = (event: ErrorEvent) =>
        finish(false, event.error ?? new Error(event.message || "ELK worker failed."));
      const onMessageError = () => finish(false, new Error("Cannot decode ELK worker response."));

      this.pending.add(cancel);
      try {
        const elk = new ElkApi({
          ...this.options,
          workerUrl: this.options.workerUrl ?? workerUrl,
          workerFactory: (url) => {
            worker = this.options.workerFactory
              ? this.options.workerFactory(url)
              : new Worker(url ?? workerUrl);
            worker.addEventListener("error", onError);
            worker.addEventListener("messageerror", onMessageError);
            return worker;
          },
        });
        operation(elk, () => !settled).then(
          (value) => finish(true, value),
          (error: unknown) => finish(false, error),
        );
      } catch (error) {
        finish(false, error);
      }
    });
  }
}
