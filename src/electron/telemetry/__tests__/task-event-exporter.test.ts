import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../admin/policies", () => ({
  loadPolicies: vi.fn(() => ({
    runtime: {
      telemetry: {
        enabled: true,
        otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
      },
    },
  })),
}));

import { enqueueTaskEventTelemetry } from "../task-event-exporter";
import type { TaskEvent } from "../../../shared/types";

describe("enqueueTaskEventTelemetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("exports task event metadata without raw payload values", async () => {
    const event = {
      id: "event-without-hex",
      taskId: "task-without-hex",
      type: "tool_error",
      timestamp: 1_700_000_000_000,
      payload: {
        command: "echo sk-testsecret1234567890",
        authorization: "Bearer secretsecretsecretsecret",
        output: "ghp_secretsecretsecretsecret",
      },
    } as unknown as TaskEvent;

    enqueueTaskEventTelemetry(event);
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(
      span.attributes.map((attr: { key: string; value: { stringValue?: string } }) => [
        attr.key,
        attr.value.stringValue,
      ]),
    );
    const serialized = JSON.stringify(body);

    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(span.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(attrs["cowork.task_id"]).toBeUndefined();
    expect(attrs["cowork.event_id"]).toBeUndefined();
    expect(attrs["cowork.event_kind"]).toBe("tool");
    expect(serialized).not.toContain("sk-testsecret");
    expect(serialized).not.toContain("ghp_secret");
    expect(serialized).not.toContain("secretsecretsecretsecret");
  });
});
