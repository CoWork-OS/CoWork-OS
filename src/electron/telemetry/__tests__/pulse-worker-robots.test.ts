import { describe, expect, it } from "vitest";
import worker from "../../../../services/pulse-worker/src/index";

// pulse.coworkosapp.com is covered by the coworkosapp.com Search Console property, and API URLs
// appear in public source, so crawlers reach the collector. It must refuse to be crawled or
// indexed. No database access is involved in these routes.

const env = {} as Parameters<typeof worker.fetch>[1];

describe("Pulse Worker crawler controls", () => {
  it("serves a disallow-all robots.txt", async () => {
    const response = await worker.fetch(new Request("https://pulse.coworkosapp.com/robots.txt"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("answers HEAD /robots.txt without a body", async () => {
    const response = await worker.fetch(
      new Request("https://pulse.coworkosapp.com/robots.txt", { method: "HEAD" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("marks every JSON response noindex", async () => {
    for (const path of ["/v1/status", "/v1/schema", "/", "/v1/installations"]) {
      const response = await worker.fetch(new Request(`https://pulse.coworkosapp.com${path}`), env);
      expect(response.headers.get("x-robots-tag"), path).toBe("noindex");
      expect(response.headers.get("content-type"), path).toContain("application/json");
    }
  });

  it("does not expose robots.txt to other methods", async () => {
    const response = await worker.fetch(
      new Request("https://pulse.coworkosapp.com/robots.txt", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(404);
  });
});
