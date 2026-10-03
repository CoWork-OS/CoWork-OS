import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "http";
import { CronWebhookServer } from "../webhook";
let server: CronWebhookServer;
afterEach(async () => {
  await server?.stop();
});
async function setup() {
  server = new CronWebhookServer({ enabled: true, port: 0, secret: "test-secret" });
  const trigger = vi.fn().mockResolvedValue({ ok: true, ran: true, taskId: "test-task" });
  server.setTriggerHandler(trigger);
  await server.start();
  return { trigger, url: `http://127.0.0.1:${server.getAddress()!.port}/trigger` };
}
describe("cron webhook body boundary", () => {
  it("rejects an unauthenticated streaming body before waiting for its end", async () => {
    const { url, trigger } = await setup();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: "POST" }, (res) => {
        res.resume();
        resolve(res.statusCode!);
        req.destroy();
      });
      req.on("error", reject);
      req.write("{");
    });
    expect(status).toBe(401);
    expect(trigger).not.toHaveBeenCalled();
  });
  it("caps authenticated chunked bytes, rejects scalar JSON and preserves a valid trigger", async () => {
    const { url, trigger } = await setup();
    const headers = { "x-webhook-secret": "test-secret" };
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: "POST", headers }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      for (let i = 0; i < 20; i++) req.write("A".repeat(65536));
      req.end();
    });
    expect(status).toBe(413);
    expect((await fetch(url, { method: "POST", headers, body: "null" })).status).toBe(400);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ jobId: "fictional-job" }),
        })
      ).status,
    ).toBe(200);
    expect(trigger).toHaveBeenCalledOnce();
  });
});
