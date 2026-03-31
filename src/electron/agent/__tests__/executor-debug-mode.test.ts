import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { closeDebugRuntimeSession } from "../debug/DebugRuntimeServer";

const DEBUG_TASK_ID = "exec-debug-mode-task";

describe("TaskExecutor debug mode", () => {
  afterEach(() => {
    closeDebugRuntimeSession(DEBUG_TASK_ID);
  });

  it("bootstrapDebugRuntimeIfNeeded opens ingest, emits timeline markers, and forwards POSTed logs", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: DEBUG_TASK_ID,
      agentConfig: { executionMode: "debug" },
    };
    executor.debugRuntimeSessionStarted = false;
    const emitted: { type: string; payload: unknown }[] = [];
    executor.emitEvent = vi.fn((type: string, payload: unknown) => {
      emitted.push({ type, payload });
    });

    await (executor as Any).bootstrapDebugRuntimeIfNeeded();

    expect(executor.debugRuntimeSessionStarted).toBe(true);

    const stepPayload = emitted.find((e) => e.type === "timeline_step_started")?.payload as Record<
      string,
      unknown
    >;
    expect(stepPayload?.debugPhase).toBe("instrument");
    expect(stepPayload?.ingestUrl).toMatch(
      new RegExp(`http://127\\.0\\.0\\.1:\\d+/cowork-debug/${encodeURIComponent(DEBUG_TASK_ID)}/ingest\\?token=`),
    );

    const ingestUrl = String(stepPayload?.ingestUrl);
    const beforeIngest = emitted.length;
    const res = await fetch(ingestUrl, { method: "POST", body: "repro: clicked submit" });
    expect(res.status).toBe(204);
    expect(emitted.length).toBeGreaterThan(beforeIngest);
    const lastEvidence = [...emitted].reverse().find((e) => e.type === "timeline_evidence_attached")?.payload as {
      message?: string;
      evidenceRefs?: { snippet?: string }[];
    };
    expect(lastEvidence?.message).toContain("Runtime debug");
    expect(lastEvidence?.evidenceRefs?.[0]?.snippet).toContain("repro:");
  });

  it("endDebugRuntimeSessionIfNeeded tears down the ingest session", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: DEBUG_TASK_ID,
      agentConfig: { executionMode: "debug" },
    };
    executor.debugRuntimeSessionStarted = false;
    executor.emitEvent = vi.fn();

    await (executor as Any).bootstrapDebugRuntimeIfNeeded();

    const calls = (executor.emitEvent as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, unknown>][];
    const stepPayload = calls.find((c) => c[0] === "timeline_step_started")?.[1];
    const ingestUrl = String(stepPayload?.ingestUrl);
    expect(ingestUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);

    let res = await fetch(ingestUrl, { method: "POST", body: "before close" });
    expect(res.status).toBe(204);

    (executor as Any).endDebugRuntimeSessionIfNeeded();
    // Allow microtask from dynamic import to finish
    await new Promise((r) => setImmediate(r));

    res = await fetch(ingestUrl, { method: "POST", body: "after close" });
    expect(res.status).toBe(401);
  });
});
