import { describe, it, expect, afterEach } from "vitest";
import { closeDebugRuntimeSession, openDebugRuntimeSession } from "../DebugRuntimeServer";

describe("DebugRuntimeServer", () => {
  afterEach(() => {
    closeDebugRuntimeSession("task-ingest-test");
  });

  it("accepts POST ingest with valid token and forwards payload", async () => {
    const lines: string[] = [];
    const { ingestUrl } = await openDebugRuntimeSession("task-ingest-test", (entry) => {
      lines.push(entry.line);
    });

    const res = await fetch(ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg: "hello", n: 1 }),
    });

    expect(res.status).toBe(204);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("msg");
  });

  it("rejects ingest with wrong token", async () => {
    const { ingestUrl } = await openDebugRuntimeSession("task-ingest-test", () => {
      /* noop */
    });
    const url = new URL(ingestUrl);
    url.searchParams.set("token", "wrong");
    const res = await fetch(url.toString(), { method: "POST", body: "x" });
    expect(res.status).toBe(401);
  });
});
