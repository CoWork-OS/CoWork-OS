import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { policies, warn } = vi.hoisted(() => ({
  policies: {
    runtime: {
      telemetry: { enabled: true, otlpEndpoint: "" as string | undefined },
      network: {
        defaultAction: "allow" as "allow" | "deny",
        allowedDomains: [] as string[],
        blockedDomains: [] as string[],
        allowedInternalHosts: [] as string[],
      },
    },
  },
  warn: vi.fn(),
}));

vi.mock("../../admin/policies", () => ({
  loadPolicies: vi.fn(() => policies),
}));

vi.mock("../../utils/logger", () => ({
  createLogger: () => ({ warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../security/pinned-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../security/pinned-fetch")>();
  return { ...actual, pinnedFetch: vi.fn(actual.pinnedFetch) };
});

import { GuardrailManager } from "../../guardrails/guardrail-manager";
import { pinnedFetch } from "../../security/pinned-fetch";
import { enqueueTaskEventTelemetry } from "../task-event-exporter";
import type { TaskEvent } from "../../../shared/types";

const received: string[] = [];
let server: Server;
let collector: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push(body);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  collector = `http://127.0.0.1:${address.port}/v1/traces`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received.length = 0;
  warn.mockClear();
  vi.mocked(pinnedFetch).mockClear();
  vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValue(true);
  policies.runtime.telemetry.otlpEndpoint = collector;
  policies.runtime.network.blockedDomains = [];
  policies.runtime.network.allowedInternalHosts = [];
});

function toolErrorEvent(id: string, payload: Record<string, unknown> = {}): TaskEvent {
  return {
    id,
    taskId: "task-without-hex",
    type: "tool_error",
    timestamp: 1_700_000_000_000,
    payload,
  } as unknown as TaskEvent;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("enqueueTaskEventTelemetry", () => {
  it("exports task event metadata without raw payload values", async () => {
    enqueueTaskEventTelemetry(
      toolErrorEvent("event-without-hex", {
        command: "echo sk-testsecret1234567890",
        authorization: "Bearer secretsecretsecretsecret",
        output: "ghp_secretsecretsecretsecret",
      }),
    );

    await vi.waitFor(() => expect(received).toHaveLength(1));
    const body = JSON.parse(received[0]);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(
      span.attributes.map((attr: { key: string; value: { stringValue?: string } }) => [
        attr.key,
        attr.value.stringValue,
      ]),
    );

    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(span.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(attrs["cowork.task_id"]).toBeUndefined();
    expect(attrs["cowork.event_id"]).toBeUndefined();
    expect(attrs["cowork.event_kind"]).toBe("tool");
    expect(received[0]).not.toContain("sk-testsecret");
    expect(received[0]).not.toContain("ghp_secret");
    expect(received[0]).not.toContain("secretsecretsecretsecret");
  });

  it("sends to an allowed endpoint through the pinned, policy-checked client", async () => {
    enqueueTaskEventTelemetry(toolErrorEvent("allowed-1"));
    enqueueTaskEventTelemetry(toolErrorEvent("allowed-2"));

    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(pinnedFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pinnedFetch).mock.calls[0][0]).toBe(collector);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not contact an endpoint on an admin blocked domain and logs the denial once", async () => {
    policies.runtime.network.blockedDomains = ["127.0.0.1"];

    for (const id of ["blocked-1", "blocked-2", "blocked-3"]) {
      enqueueTaskEventTelemetry(toolErrorEvent(id));
    }
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    await settle();

    expect(pinnedFetch).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("blocked_domain");
  });

  it("refuses an internal-address endpoint before connecting", async () => {
    policies.runtime.telemetry.otlpEndpoint = "http://169.254.169.254/v1/traces?token=secret";

    enqueueTaskEventTelemetry(toolErrorEvent("internal-1"));
    enqueueTaskEventTelemetry(toolErrorEvent("internal-2"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    await settle();

    expect(pinnedFetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("internal_address_blocked");
    expect(message).not.toContain("token=secret");
  });

  it("logs a denial again after the endpoint was reachable in between", async () => {
    policies.runtime.network.blockedDomains = ["127.0.0.1"];
    enqueueTaskEventTelemetry(toolErrorEvent("episode-1"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    policies.runtime.network.blockedDomains = [];
    enqueueTaskEventTelemetry(toolErrorEvent("episode-2"));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await settle();

    policies.runtime.network.blockedDomains = ["127.0.0.1"];
    enqueueTaskEventTelemetry(toolErrorEvent("episode-3"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
  });
});
