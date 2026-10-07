import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnswerImageService } from "../AnswerImageService";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "answer-images-"));
});

afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function openverseResults(thumbnail: string) {
  return {
    results: [
      {
        thumbnail,
        width: 1200,
        height: 800,
        title: "Roast lamb",
        creator: "Jane <b>Doe</b>",
        license: "by",
        license_version: "2.0",
        foreign_landing_url: "https://www.flickr.com/photos/x/1",
        category: "photograph",
      },
    ],
  };
}

function service(fetchImpl: (url: string) => Promise<Response>) {
  return new AnswerImageService({
    cacheDir,
    fetchImpl: (url) => fetchImpl(url),
    skipDestinationCheck: true,
  });
}

describe("AnswerImageService", () => {
  it("finds a photo by description and returns a verified data URL with credit", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.openverse.org/v1/images/?q=roast%20lamb")) {
        return jsonResponse(openverseResults("https://api.openverse.org/v1/images/1/thumb/"));
      }
      if (url === "https://api.openverse.org/v1/images/1/thumb/") return new Response(JPEG);
      throw new Error(`unexpected ${url}`);
    });
    const [image] = await service(fetchImpl).resolve([{ query: "Roast  Lamb" }], {});
    expect(image).toMatchObject({
      dataUrl: `data:image/jpeg;base64,${Buffer.from(JPEG).toString("base64")}`,
      creator: "Jane Doe",
      license: "CC BY 2.0",
      provider: "openverse",
    });
  });

  it("caches results on disk and in memory", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/thumb/")
        ? new Response(JPEG)
        : jsonResponse(openverseResults("https://api.openverse.org/v1/images/1/thumb/")),
    );
    await service(fetchImpl).resolve([{ query: "roast lamb" }], {});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const fresh = service(fetchImpl);
    const [cached] = await fresh.resolve([{ query: "roast lamb" }], {});
    expect(cached?.provider).toBe("openverse");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to Wikimedia Commons when Openverse fails", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.openverse.org")) return new Response("", { status: 429 });
      if (url.startsWith("https://commons.wikimedia.org/w/api.php")) {
        return jsonResponse({
          query: {
            pages: {
              "5": {
                index: 1,
                title: "File:Lamb.jpg",
                imageinfo: [
                  {
                    thumburl: "https://upload.wikimedia.org/thumb/lamb.jpg",
                    width: 1600,
                    height: 1000,
                    mime: "image/jpeg",
                    descriptionurl: "https://commons.wikimedia.org/wiki/File:Lamb.jpg",
                    extmetadata: {
                      Artist: { value: '<a href="x">Sam</a>' },
                      LicenseShortName: { value: "CC BY-SA 4.0" },
                    },
                  },
                ],
              },
            },
          },
        });
      }
      if (url === "https://upload.wikimedia.org/thumb/lamb.jpg") return new Response(JPEG);
      throw new Error(`unexpected ${url}`);
    });
    const [image] = await service(fetchImpl).resolve([{ query: "lamb" }], {});
    expect(image).toMatchObject({ provider: "wikimedia", creator: "Sam", license: "CC BY-SA 4.0" });
  });

  it("follows redirects and rejects content that is not an image", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://example.com/a.jpg") {
        return new Response(null, { status: 302, headers: { location: "/b.jpg" } });
      }
      if (url === "https://example.com/b.jpg") return new Response(JPEG);
      if (url === "https://example.com/page.jpg") return new Response(HTML);
      throw new Error(`unexpected ${url}`);
    });
    const [redirected, html] = await service(fetchImpl).resolve(
      [{ src: "https://example.com/a.jpg" }, { src: "https://example.com/page.jpg" }],
      {},
    );
    expect(redirected?.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(html).toBeNull();
  });

  it("refuses non-https redirects", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://example.com/x.jpg" } }),
    );
    const [image] = await service(fetchImpl).resolve([{ src: "https://example.com/a.jpg" }], {});
    expect(image).toBeNull();
  });

  it("reaches only the curated photo libraries when the profile asks before network use", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.openverse.org/v1/images/?q=")) {
        return jsonResponse(openverseResults("https://api.openverse.org/v1/images/1/thumb/"));
      }
      if (url === "https://api.openverse.org/v1/images/1/thumb/") return new Response(JPEG);
      throw new Error(`unexpected ${url}`);
    });
    const web = { provider: "brave" as const, free: false, search: vi.fn(async () => []) };
    const service = new AnswerImageService({
      cacheDir,
      fetchImpl,
      skipDestinationCheck: true,
      imageSearch: () => web,
    });
    const [library, direct] = await service.resolve(
      [{ query: "roast lamb" }, { src: "https://example.com/a.jpg" }],
      { accessNetworkMode: "on-request" },
    );
    expect(library?.provider).toBe("openverse");
    expect(direct).toBeNull();
    expect(web.search).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalledWith("https://example.com/a.jpg", expect.anything());
  });

  it("refuses redirects away from the curated hosts when the profile asks first", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.openverse.org/v1/images/?q=")) {
        return jsonResponse(openverseResults("https://api.openverse.org/v1/images/1/thumb/"));
      }
      if (url === "https://api.openverse.org/v1/images/1/thumb/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://tracker.example/x.jpg" },
        });
      }
      if (url.startsWith("https://commons.wikimedia.org"))
        return jsonResponse({ query: { pages: {} } });
      throw new Error(`unexpected ${url}`);
    });
    const [image] = await new AnswerImageService({
      cacheDir,
      fetchImpl,
      skipDestinationCheck: true,
    }).resolve([{ query: "roast lamb" }], { accessNetworkMode: "on-request" });
    expect(image).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalledWith("https://tracker.example/x.jpg", expect.anything());
  });

  it("asks a free configured search engine first and a paid one only as a last resort", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://images.example/free.jpg" || url === "https://images.example/paid.jpg") {
        return new Response(JPEG);
      }
      if (
        url.startsWith("https://api.openverse.org") ||
        url.startsWith("https://commons.wikimedia.org")
      ) {
        return jsonResponse({ results: [], query: { pages: {} } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const hit = (name: string) => [
      {
        url: `https://images.example/${name}.jpg`,
        title: "Linen dress",
        sourceUrl: "https://www.shop.example/dress",
      },
    ];
    const free = {
      provider: "searxng" as const,
      free: true,
      search: vi.fn(async () => hit("free")),
    };
    const [fromFree] = await new AnswerImageService({
      cacheDir,
      fetchImpl,
      skipDestinationCheck: true,
      imageSearch: () => free,
    }).resolve([{ query: "linen dress" }], {});
    expect(fromFree).toMatchObject({
      provider: "web",
      sourceUrl: "https://www.shop.example/dress",
    });
    expect(fetchImpl).not.toHaveBeenCalledWith(
      expect.stringContaining("openverse"),
      expect.anything(),
    );

    const paid = {
      provider: "brave" as const,
      free: false,
      search: vi.fn(async () => hit("paid")),
    };
    const [fromPaid] = await new AnswerImageService({
      cacheDir: `${cacheDir}/paid`,
      fetchImpl,
      skipDestinationCheck: true,
      imageSearch: () => paid,
    }).resolve([{ query: "silk scarf" }], {});
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("openverse"), expect.anything());
    expect(paid.search).toHaveBeenCalledWith("silk scarf", {});
    expect(fromPaid?.dataUrl.startsWith("data:image/jpeg")).toBe(true);
  });

  it("applies the network policy to every request", async () => {
    const fetchImpl = vi.fn();
    const strict = new AnswerImageService({ cacheDir, fetchImpl });
    const [image] = await strict.resolve([{ query: "lamb" }], { networkEnabled: false });
    expect(image).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
