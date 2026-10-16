import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceClient, spaceBaseUrl } from "../space-client";

describe("SPACE protocol boundaries", () => {
  let server: http.Server;
  let origin: string;
  let payload: string;
  let redirect: boolean;
  let holdOpen: boolean;
  let invalidHttpStatus: boolean;
  let requests: number;
  const processId = `proc_${randomUUID()}`;
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const exit = (status = "exited", exit_code = 0) =>
    frame({ type: "process_exited", process_id: processId, status, exit_code });
  const output = (text: string, seq = 1) =>
    frame({ type: "stdout", seq, data_base64: Buffer.from(text).toString("base64") });
  beforeEach(async () => {
    requests = 0;
    redirect = false;
    holdOpen = false;
    invalidHttpStatus = false;
    payload = exit();
    server = http.createServer((request, response) => {
      requests++;
      expect(request.headers.authorization).toBe("Bearer scoped-token");
      if (redirect) {
        response.writeHead(302, { location: `${origin}/redirected` });
        response.end();
        return;
      }
      response.writeHead(invalidHttpStatus ? 700 : 200, { "content-type": "text/event-stream" });
      // Deliberately split transport chunks inside JSON and UTF-8 data.
      const bytes = Buffer.from(payload);
      response.write(bytes.subarray(0, 7));
      response.write(bytes.subarray(7));
      if (!holdOpen) response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    vi.stubEnv("COWORK_SPACE_API_URL", origin);
    vi.stubEnv("COWORK_SPACE_DATA_PLANE_URL", origin);
    vi.stubEnv("COWORK_SPACE_API_TOKEN", "management-token");
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const command = () => ({
    session_id: processId,
    process_id: processId,
    attach: { token: "scoped-token", events_url: `/v1/sessions/${processId}/events` },
  });
  const stream = (cap = 1024) =>
    new SpaceClient().stream(command(), 1000, cap, new AbortController().signal, () => {});

  it.each([
    "http://remote.example",
    "https://user:pass@host.example",
    "https://host.example?token=x",
    "https://host.example/other",
  ])("rejects unsafe connection URL %s", (value) => expect(() => spaceBaseUrl(value)).toThrow());
  it("allows HTTPS and shared-host /api bases", () => {
    expect(spaceBaseUrl("https://space.example/api/")).toBe("https://space.example/api");
  });
  it("finishes on a validated terminal event even if SSE remains open", async () => {
    holdOpen = true;
    payload = output("complete") + exit();
    expect(await stream()).toMatchObject({ stdout: "complete", exitCode: 0 });
  }, 2000);
  it("turns an invalid HTTP status into a bounded failure instead of an uncaught callback error", async () => {
    invalidHttpStatus = true;
    await expect(stream()).rejects.toThrow("Invalid SPACE HTTP response");
  });
  it("retains TimeoutError when a deadline interrupts an attached response body", async () => {
    holdOpen = true;
    payload = output("partial");
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const checkpoint = vi.fn(() => deadline.abort(new DOMException("deadline", "TimeoutError")));
    await expect(
      new SpaceClient().stream(command(), 1000, 1024, new AbortController().signal, checkpoint),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(checkpoint).toHaveBeenCalledWith("partial", "");
  });
  it("requires matching exit identity and a known completion status", async () => {
    payload = frame({
      type: "process_exited",
      process_id: "other",
      exit_code: 0,
      status: "exited",
    });
    await expect(stream()).rejects.toThrow("exit status");
    payload = exit("future-status");
    await expect(stream()).rejects.toThrow("exit status");
  });
  it.each(["error", "resync_required"])("fails closed on %s", async (type) => {
    payload = output("partial") + frame({ type }) + exit();
    await expect(stream()).rejects.toThrow("outcome unknown");
  });
  it("rejects missing exit, incomplete frames, invalid base64, and sequence gaps", async () => {
    for (const text of [
      output("partial"),
      'data: {"type":"stdout"}',
      frame({ type: "stdout", seq: 1, data_base64: "not base64" }) + exit(),
      output("gap", 2) + exit(),
    ]) {
      payload = text;
      await expect(stream()).rejects.toThrow();
    }
  });
  it("retains UTF-8 characters split across output events", async () => {
    const data = Buffer.from("é");
    payload =
      [0, 1]
        .map((index) =>
          frame({
            type: "stdout",
            seq: index + 1,
            data_base64: data.subarray(index, index + 1).toString("base64"),
          }),
        )
        .join("") + exit();
    expect((await stream()).stdout).toBe("é");
  });
  it("keeps head and tail of capped output and preserves nonzero exit status", async () => {
    payload = output("start-" + "x".repeat(200) + "-end") + exit("exited", 7);
    expect(await stream(30)).toMatchObject({
      exitCode: 7,
      truncated: true,
      stdout: expect.stringContaining("[Output truncated]"),
    });
  });
  it("reports server-confirmed timeouts distinctly", async () => {
    payload = exit("timed_out", 124);
    expect(await stream()).toMatchObject({ exitCode: 124, timedOut: true, killed: true });
  });
  it("does not follow credential-bearing redirects", async () => {
    redirect = true;
    await expect(stream()).rejects.toThrow("HTTP 302");
    expect(requests).toBe(1);
  });
  it("ignores inherited proxy configuration", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    expect((await stream()).exitCode).toBe(0);
  });
  it("never attaches with an unexpected session path or management token", async () => {
    const invalid = command();
    invalid.attach.events_url = `${origin}/v1/sessions/other/events`;
    await expect(
      new SpaceClient().stream(invalid, 1000, 1000, new AbortController().signal, () => {}),
    ).rejects.toThrow("destination");
    expect(requests).toBe(0);
  });
});
