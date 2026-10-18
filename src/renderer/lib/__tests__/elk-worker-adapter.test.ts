import { createRequire } from "node:module";
import { Worker as NodeWorker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import BundledElk from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import ElkWorkerAdapter from "../elk-worker-adapter";

type Request = {
  id: number;
  cmd: string;
  graph?: ElkNode;
  algorithms?: string[];
  layoutOptions?: Record<string, string>;
  options?: { logging: boolean; measureExecutionTime: boolean };
};

class ControlledWorker extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  requests: Request[] = [];
  terminate = vi.fn();
  postMessage = vi.fn((request: Request) => {
    this.requests.push(request);
    if (request.cmd === "register") queueMicrotask(() => this.reply(request.id));
  });

  reply(id: number, data?: unknown, error?: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: { id, data, error } }));
  }
}

function controlledElk(options: ConstructorParameters<typeof ElkWorkerAdapter>[0] = {}) {
  const workers: ControlledWorker[] = [];
  const workerFactory = vi.fn(() => {
    const worker = new ControlledWorker();
    workers.push(worker);
    // Only the browser Worker transport is controlled; the ELK RPC client is real.
    return worker as unknown as Worker;
  });
  return { elk: new ElkWorkerAdapter({ ...options, workerFactory }), workers, workerFactory };
}

afterEach(() => vi.unstubAllGlobals());

describe("ELK worker adapter lifecycle", () => {
  it("uses the emitted worker asset by default, without constructing an idle worker", async () => {
    const workers: ControlledWorker[] = [];
    const constructor = vi.fn(function (_url: string | URL) {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    });
    vi.stubGlobal("Worker", constructor);
    const elk = new ElkWorkerAdapter();
    expect(constructor).not.toHaveBeenCalled();
    const graph = { id: "root" };
    const pending = elk.layout(graph);
    expect(constructor).toHaveBeenCalledOnce();
    expect(constructor.mock.calls[0][0]).toMatch(/elk-worker\.min\.js(?:\?|$)/);
    workers[0].reply(1, graph);
    await expect(pending).resolves.toEqual(graph);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("forwards constructor algorithms/defaults, custom worker URL and layout arguments", async () => {
    const defaults = { "elk.algorithm": "mrtree", "elk.direction": "RIGHT" };
    const { elk, workers, workerFactory } = controlledElk({
      algorithms: ["layered", "mrtree"],
      defaultLayoutOptions: defaults,
      workerUrl: "/explicit-worker.js",
    });
    const graph = { id: "root" };
    const first = elk.layout(graph);
    expect(workerFactory).toHaveBeenCalledWith("/explicit-worker.js");
    expect(workers[0].requests[0]).toMatchObject({
      cmd: "register",
      algorithms: ["layered", "mrtree"],
    });
    expect(workers[0].requests[1]).toMatchObject({
      cmd: "layout",
      graph,
      layoutOptions: defaults,
      options: { logging: false, measureExecutionTime: false },
    });
    workers[0].reply(1, graph);
    await first;
    const second = elk.layout(graph, {
      layoutOptions: { "elk.algorithm": "layered" },
      logging: true,
      measureExecutionTime: true,
    });
    expect(workers[1].requests[1]).toMatchObject({
      layoutOptions: { "elk.algorithm": "layered" },
      options: { logging: true, measureExecutionTime: true },
    });
    workers[1].reply(1, graph);
    await second;
    expect(defaults).toEqual({ "elk.algorithm": "mrtree", "elk.direction": "RIGHT" });
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
  });

  it.each([
    ["knownLayoutAlgorithms", "algorithms"],
    ["knownLayoutOptions", "options"],
    ["knownLayoutCategories", "categories"],
  ] as const)("retains %s and releases its worker", async (method, command) => {
    const { elk, workers } = controlledElk();
    const pending = elk[method]();
    expect(workers[0].requests[1].cmd).toBe(command);
    workers[0].reply(1, [{ id: "retained-description" }]);
    await expect(pending).resolves.toEqual([{ id: "retained-description" }]);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("does not terminate another concurrent layout when one request completes", async () => {
    const { elk, workers } = controlledElk();
    const a = elk.layout({ id: "a" });
    const b = elk.layout({ id: "b" });
    workers[1].reply(1, { id: "b", width: 20 });
    await expect(b).resolves.toMatchObject({ id: "b", width: 20 });
    expect(workers[1].terminate).toHaveBeenCalledOnce();
    expect(workers[0].terminate).not.toHaveBeenCalled();
    workers[0].reply(1, { id: "a", width: 10 });
    await expect(a).resolves.toMatchObject({ id: "a", width: 10 });
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("preserves ELK layout errors and releases the worker before another request", async () => {
    const { elk, workers } = controlledElk();
    const failure = { message: "Unsupported graph", name: "IllegalArgumentException" };
    const pending = elk.layout({ id: "broken" });
    workers[0].reply(1, undefined, failure);
    await expect(pending).rejects.toBe(failure);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const retry = elk.layout({ id: "valid" });
    workers[1].reply(1, { id: "valid" });
    await expect(retry).resolves.toEqual({ id: "valid" });
    expect(workers[1].terminate).toHaveBeenCalledOnce();
  });

  it.each(["error", "messageerror"])(
    "rejects worker %s instead of leaving the promise/worker alive",
    async (type) => {
      const { elk, workers } = controlledElk();
      const pending = elk.layout({ id: "root" });
      const rejection = expect(pending).rejects.toThrow(
        type === "error" ? "ELK worker failed" : "Cannot decode",
      );
      workers[0].dispatchEvent(new Event(type));
      await rejection;
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      elk.terminateWorker();
      expect(workers[0].terminate).toHaveBeenCalledOnce();
    },
  );

  it("cancels all concurrent requests, ignores late replies, and permits fresh requests", async () => {
    const { elk, workers } = controlledElk();
    const a = elk.layout({ id: "a" });
    const b = elk.knownLayoutOptions();
    const rejected = Promise.all([
      expect(a).rejects.toMatchObject({ name: "AbortError" }),
      expect(b).rejects.toMatchObject({ name: "AbortError" }),
    ]);
    elk.terminateWorker();
    await rejected;
    workers[0].reply(1, { id: "stale" });
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
    const c = elk.layout({ id: "c" });
    workers[2].reply(1, { id: "c" });
    await expect(c).resolves.toEqual({ id: "c" });
    expect(workers[2].terminate).toHaveBeenCalledOnce();
  });

  it("rejects worker construction failures without a main-thread fallback", async () => {
    const failure = new DOMException("Worker blocked by CSP", "SecurityError");
    const constructor = vi.fn(function () {
      throw failure;
    });
    vi.stubGlobal("Worker", constructor);
    await expect(new ElkWorkerAdapter().layout({ id: "root" })).rejects.toBe(failure);
    expect(constructor).toHaveBeenCalledOnce();
  });

  it("does not restore an already queued RPC reply into a graph after cancellation", async () => {
    const callback = () => "render";
    const metadata = { callback, owner: "original" };
    const node = { id: "child", width: 40, height: 30, metadata };
    const graph = { id: "root", width: 100, children: [node], metadata };
    const { elk, workers } = controlledElk();
    const pending = elk.layout(graph);
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // This reaches the real ELK RPC client's onmessage handler, which queues
    // delivery through setTimeout. Cancel after delivery but before it resolves.
    workers[0].reply(1, {
      id: "root",
      width: 999,
      children: [{ id: "child", width: 888, metadata: { owner: "stale" } }],
      metadata: { owner: "stale" },
    });
    elk.terminateWorker();
    await rejection;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(graph.width).toBe(100);
    expect(graph.children[0]).toBe(node);
    expect(node.width).toBe(40);
    expect(graph.metadata).toBe(metadata);
    expect(node.metadata).toBe(metadata);
    expect(metadata).toEqual({ callback, owner: "original" });
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("preserves synchronous transport errors and releases the created worker", async () => {
    const worker = new ControlledWorker();
    const failure = new DOMException("Graph is not cloneable", "DataCloneError");
    worker.postMessage.mockImplementation((request) => {
      if (request.cmd === "layout") throw failure;
      queueMicrotask(() => worker.reply(request.id));
    });
    const elk = new ElkWorkerAdapter({ workerFactory: () => worker as unknown as Worker });
    await expect(elk.layout({ id: "root" })).rejects.toBe(failure);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("restores rendering identities by ID when nested layout arrays return in a different order", async () => {
    const callback = () => "render";
    const node = (id: string) => ({
      id,
      width: 40,
      height: 30,
      intersect: callback,
      metadata: { callback },
      ports: [
        { id: `${id}.p1`, callback },
        { id: `${id}.p2`, callback },
      ],
      labels: [
        { id: `${id}.l1`, text: "one", callback },
        { id: `${id}.l2`, text: "two", callback },
      ],
    });
    const a = node("a");
    const b = node("b");
    const originalPorts = a.ports.slice();
    const originalLabels = a.labels.slice();
    const graph = { id: "root", children: [a, b] };
    const { elk, workers } = controlledElk();
    const pending = elk.layout(graph);
    const transported = structuredClone(workers[0].requests[1].graph!) as typeof graph;
    expect(transported.children[0]).not.toHaveProperty("intersect");
    expect(transported.children[0].metadata).not.toHaveProperty("callback");
    expect(a.intersect).toBe(callback);
    expect(a).not.toHaveProperty("x");
    transported.children[0].width = 111;
    transported.children[0].ports.reverse();
    transported.children[0].labels.reverse();
    transported.children.reverse();
    workers[0].reply(1, transported);
    const actual = await pending;
    expect(actual).toBe(graph);
    expect(actual.children?.[0]).toBe(b);
    expect(actual.children?.[1]).toBe(a);
    expect(a.width).toBe(111);
    expect(a.ports[0]).toBe(originalPorts[1]);
    expect(a.ports[1]).toBe(originalPorts[0]);
    expect(a.labels[0]).toBe(originalLabels[1]);
    expect(a.labels[1]).toBe(originalLabels[0]);
    expect(a.intersect).toBe(callback);
    expect(a.metadata.callback).toBe(callback);
    expect(a.ports[0].callback).toBe(callback);
    expect(a.labels[0].callback).toBe(callback);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("restores own metadata fields without merging into inherited objects or prototypes", async () => {
    const inherited = { privateOwner: { untouched: true } };
    const metadata = Object.create(inherited) as Record<string, unknown>;
    metadata.callback = () => "render";
    const graph = { id: "root", metadata };
    const { elk, workers } = controlledElk();
    const pending = elk.layout(graph);
    workers[0].reply(
      1,
      JSON.parse(
        '{"id":"root","metadata":{"__proto__":{"polluted":true},"privateOwner":{"updated":true}}}',
      ),
    );
    await pending;
    expect(Object.getPrototypeOf(metadata)).toBe(inherited);
    expect(inherited).not.toHaveProperty("polluted");
    expect(inherited.privateOwner).toEqual({ untouched: true });
    expect(metadata.privateOwner).toEqual({ updated: true });
    expect(metadata.privateOwner).not.toBe(inherited.privateOwner);
    expect(Object.hasOwn(metadata, "__proto__")).toBe(true);
    expect(metadata["__proto__"]).toEqual({ polluted: true });
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });
});

/** Browser worker transport backed by a real Node thread running the same emitted script. */
class ThreadWorker extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly thread: NodeWorker;
  termination?: Promise<number>;

  constructor() {
    super();
    this.thread = new NodeWorker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      globalThis.self = { postMessage: (data) => parentPort.postMessage(data) };
      parentPort.on('message', (data) => self.onmessage({ data }));
      require(workerData.path);
    `,
      {
        eval: true,
        workerData: { path: createRequire(import.meta.url).resolve("elkjs/lib/elk-worker.min.js") },
      },
    );
    this.thread.on("message", (data: unknown) =>
      this.onmessage?.(new MessageEvent("message", { data })),
    );
    this.thread.on("error", (error) =>
      this.dispatchEvent(Object.assign(new Event("error"), { error })),
    );
  }

  postMessage(data: unknown) {
    this.thread.postMessage(data);
  }
  terminate() {
    this.termination = this.thread.terminate();
  }
}

describe("real ELK worker compatibility", () => {
  it("retains nested Mermaid rendering metadata and original identities across actual worker layouts", async () => {
    class DomHandle {
      nodeType = 1;
      measure = () => ({ width: 40, height: 30 });
    }
    const handle = new DomHandle();
    const intersect = (node: unknown, point: unknown) => ({ node, point });
    const rendererData = {
      handle,
      intersect,
      nested: { value: 42, callback: intersect },
      unset: undefined,
      notANumber: NaN,
      count: 2n,
      token: Symbol("renderer"),
      created: new Date("2026-10-18T00:00:00Z"),
      self: undefined as unknown,
    };
    rendererData.self = rendererData;
    const created = rendererData.created;
    const token = rendererData.token;
    const label = { id: "label-a", text: "Alpha", width: 30, height: 10, rendererData };
    const port = { id: "a.out", width: 4, height: 4, rendererData };
    const a = {
      id: "a",
      width: 40,
      height: 30,
      intersect,
      rendererData,
      labels: [label],
      ports: [port],
    };
    const b = { id: "b", width: 60, height: 20, ports: [{ id: "b.in", width: 4, height: 4 }] };
    const edge = {
      id: "ab",
      sources: ["a.out"],
      targets: ["b.in"],
      rendererData,
      labels: [{ text: "link", width: 20, height: 10, rendererData }],
    };
    const group = {
      id: "group",
      isGroup: true,
      children: [a, b],
      edges: [edge],
      rendererData,
      labelData: { width: 80, height: 16, element: handle },
      labels: [{ text: "Group", width: 80, height: 16, rendererData }],
    };
    const graph = {
      id: "root",
      children: [group],
      rendererData,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      },
    };
    const workers: ThreadWorker[] = [];
    const elk = new ElkWorkerAdapter({
      workerFactory: () => {
        const worker = new ThreadWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const actual = await elk.layout(graph);
        expect(actual).toBe(graph);
        expect(actual.children?.[0]).toBe(group);
        expect(actual.children?.[0].children?.[0]).toBe(a);
        expect(actual.children?.[0].children?.[0].ports?.[0]).toBe(port);
        expect(actual.children?.[0].children?.[0].labels?.[0]).toBe(label);
        expect(actual.children?.[0].edges?.[0]).toBe(edge);
        expect(a.intersect).toBe(intersect);
        expect(a.rendererData).toBe(rendererData);
        expect(group.labelData.element).toBe(handle);
        expect(edge.labels[0].rendererData).toBe(rendererData);
        expect(rendererData.nested.callback).toBe(intersect);
        expect(rendererData.count).toBe(2n);
        expect(rendererData.notANumber).toBeNaN();
        expect(rendererData).toHaveProperty("unset", undefined);
        expect(rendererData.created).toBe(created);
        expect(rendererData.token).toBe(token);
        expect(rendererData.self).toBe(rendererData);
        expect(actual.children?.[0].children?.[1].x).toBeGreaterThan(
          actual.children?.[0].children?.[0].x ?? Infinity,
        );
        expect(actual.children?.[0].edges?.[0].sections?.length).toBeGreaterThan(0);
      }
      expect(workers.every((worker) => worker.termination !== undefined)).toBe(true);
    } finally {
      elk.terminateWorker();
      await Promise.all(workers.map((worker) => worker.termination ?? worker.thread.terminate()));
    }
  });

  it("retains the bundled algorithm catalogue and exact layered/tree layout results off the main thread", async () => {
    const workers: ThreadWorker[] = [];
    const elk = new ElkWorkerAdapter({
      workerFactory: () => {
        const worker = new ThreadWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const bundled = new BundledElk();
    try {
      expect(await elk.knownLayoutAlgorithms()).toEqual(await bundled.knownLayoutAlgorithms());
      expect(await elk.knownLayoutOptions()).toEqual(await bundled.knownLayoutOptions());
      expect(await elk.knownLayoutCategories()).toEqual(await bundled.knownLayoutCategories());
      for (const algorithm of ["layered", "mrtree"]) {
        const graph: ElkNode = {
          id: "root",
          layoutOptions: {
            "elk.algorithm": algorithm,
            "elk.direction": "RIGHT",
            "elk.randomSeed": "42",
          },
          children: [
            { id: "a", width: 40, height: 30 },
            { id: "b", width: 60, height: 20 },
          ],
          edges: [{ id: "ab", sources: ["a"], targets: ["b"] }],
        };
        const expected = await bundled.layout(structuredClone(graph));
        const actual = await elk.layout(structuredClone(graph));
        // GWT's $H is an object identity counter, not layout data. A fresh
        // worker has its own counter; compare every other result field.
        const layoutData = (value: ElkNode) =>
          JSON.parse(
            JSON.stringify(value, (key, item: unknown) => (key === "$H" ? undefined : item)),
          );
        expect(layoutData(actual)).toEqual(layoutData(expected));
        expect(actual.children?.[1].x).toBeGreaterThan(actual.children?.[0].x ?? Infinity);
      }
      expect(workers).toHaveLength(5);
      expect(workers.every((worker) => worker.termination !== undefined)).toBe(true);
    } finally {
      elk.terminateWorker();
      // The bundled implementation uses only in-process callbacks, with no
      // real worker or terminate method; only our actual threads need closing.
      await Promise.all(workers.map((worker) => worker.termination ?? worker.thread.terminate()));
    }
  });
});
