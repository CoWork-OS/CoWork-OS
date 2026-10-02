import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFromUrl } from "../pack-installer";

const mocks = vi.hoisted(() => ({
  userData: "",
  scan: vi.fn(),
  activate: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => mocks.userData } }));
vi.mock("../../security/network-policy", () => ({ assertNetworkPolicyAllowed: vi.fn() }));
vi.mock("../../security/capability-bundle-security", () => ({
  getCapabilityBundleSecurityService: () => ({
    scanPluginPack: mocks.scan,
    activatePluginPack: mocks.activate,
  }),
}));

describe("plugin manifest download bounds", () => {
  beforeEach(() => {
    mocks.userData = fs.mkdtempSync(path.join(os.tmpdir(), "pack-download-test-"));
    mocks.scan.mockResolvedValue({ verdict: "clean", summary: "Test manifest" });
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    fs.rmSync(mocks.userData, { recursive: true, force: true });
  });

  it.each([undefined, "1"])(
    "rejects an oversized stream with content-length %s",
    async (contentLength) => {
      const cancel = vi.fn();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(700_000));
          controller.enqueue(new Uint8Array(700_000));
        },
        cancel,
      });
      vi.mocked(fetch).mockResolvedValue(
        new Response(body, { headers: contentLength ? { "content-length": contentLength } : {} }),
      );
      expect(await installFromUrl("https://packs.example/manifest.json")).toMatchObject({
        success: false,
        error: expect.stringContaining("1048576-byte limit"),
      });
      expect(cancel).toHaveBeenCalled();
      expect(mocks.scan).not.toHaveBeenCalled();
      expect(mocks.activate).not.toHaveBeenCalled();
    },
  );

  it("aborts a stalled body after response headers arrive", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const pending = installFromUrl("https://packs.example/manifest.json");
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toMatchObject({ success: false, error: expect.stringMatching(/abort/i) });
    expect(cancel).toHaveBeenCalled();
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still validates and installs a normal manifest", async () => {
    const manifest = {
      name: "test-pack",
      displayName: "Test pack",
      version: "1.0.0",
      description: "Test",
      type: "pack",
      skills: [],
    };
    vi.mocked(fetch).mockResolvedValue(Response.json(manifest));
    expect(await installFromUrl("https://packs.example/manifest.json")).toMatchObject({
      success: true,
      packName: "test-pack",
    });
    expect(mocks.scan).toHaveBeenCalledWith(expect.objectContaining({ manifest }));
    expect(mocks.activate).toHaveBeenCalled();
  });

  it.each(["http-error", "invalid-json", "fetch-error"])(
    "cleans the deadline on %s",
    async (failure) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      if (failure === "http-error") {
        vi.mocked(fetch).mockResolvedValue(
          new Response(new ReadableStream({ cancel }), { status: 503 }),
        );
      } else if (failure === "invalid-json") {
        vi.mocked(fetch).mockResolvedValue(new Response("{broken"));
      } else {
        vi.mocked(fetch).mockRejectedValue(new Error("fetch failed"));
      }
      expect(await installFromUrl("https://packs.example/manifest.json")).toMatchObject({
        success: false,
      });
      expect(vi.getTimerCount()).toBe(0);
      if (failure === "http-error") expect(cancel).toHaveBeenCalled();
      expect(mocks.activate).not.toHaveBeenCalled();
    },
  );
});
