import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All network access is mocked; no test contacts GitHub or the CoWork collector.
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  userData: "" as string,
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userData,
    getVersion: () => "0.5.51",
    isPackaged: true,
    getAppPath: () => "/Applications/CoWork OS.app",
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  net: { fetch: mocks.fetch },
  BrowserWindow: class {},
}));

import {
  BACKGROUND_ENDPOINT_DEADLINE_MS,
  MANUAL_CHECK_DEADLINE_MS,
  UpdateManager,
} from "../update-manager";

function release(version: string) {
  return {
    tag_name: `v${version}`,
    name: version,
    body: "notes",
    html_url: `https://example.com/${version}`,
    published_at: "2026-09-01T00:00:00Z",
    assets: [],
  };
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function manager() {
  const instance = new UpdateManager("linux", () => "6.8.0");
  vi.spyOn(instance, "getVersionInfo").mockResolvedValue({
    version: "0.5.51",
    isDev: false,
    isGitRepo: false,
    isNpmGlobal: false,
  });
  return instance;
}

function cacheFile() {
  return path.join(mocks.userData, "update-check-cache.json");
}

async function asProduction<T>(fn: () => Promise<T>): Promise<T> {
  const env = { NODE_ENV: process.env.NODE_ENV, CI: process.env.CI };
  process.env.NODE_ENV = "production";
  delete process.env.CI;
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = env.NODE_ENV;
    if (env.CI !== undefined) process.env.CI = env.CI;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userData = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-updates-"));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(mocks.userData, { recursive: true, force: true });
});

describe("bounded update discovery", () => {
  it("falls back to GitHub when the optional collector stalls past its deadline", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation((url: string) =>
      url.startsWith("https://pulse.")
        ? new Promise(() => undefined)
        : Promise.resolve(ok(release("0.5.60"))),
    );
    const pending = asProduction(() => manager().checkForUpdates("background"));
    await vi.advanceTimersByTimeAsync(BACKGROUND_ENDPOINT_DEADLINE_MS + 1);
    await expect(pending).resolves.toMatchObject({
      latestVersion: "0.5.60",
      provenance: { source: "live", origin: "github" },
    });
  });

  it("an invalid collector response shape falls back to GitHub", async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.startsWith("https://pulse.") ? ok({ nope: true }) : ok(release("0.5.60")),
    );
    await expect(
      asProduction(() => manager().checkForUpdates("background")),
    ).resolves.toMatchObject({ provenance: { origin: "github" } });
  });

  it("a stalled GitHub body settles at the deadline and uses the cache when present", async () => {
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({
        version: 2,
        retrievedAt: 1_000,
        origin: "github",
        release: release("0.5.55"),
      }),
    );
    vi.useFakeTimers();
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(() => undefined),
    });
    const pending = manager().checkForUpdates("manual");
    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_DEADLINE_MS + 1);
    const info = await pending;
    expect(info).toMatchObject({
      available: true,
      latestVersion: "0.5.55",
      provenance: { source: "cached", lastSuccessfulRetrievalAt: 1_000 },
    });
    expect(info.provenance?.networkError).toMatch(/did not respond/);
  });

  it("with no cache a failed network keeps the retryable error", async () => {
    mocks.fetch.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    await expect(manager().checkForUpdates()).rejects.toThrow("ENOTFOUND");
  });

  it("invalid GitHub JSON uses the cache rather than asserting anything", async () => {
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({ version: 2, retrievedAt: 5, release: release("0.5.51") }),
    );
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    const info = await manager().checkForUpdates();
    // A cached version equal to the installed one is not "up to date".
    expect(info).toMatchObject({ available: false, provenance: { source: "cached" } });
  });

  it("a manual check sees a newly published release despite the cache", async () => {
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({ version: 2, retrievedAt: 5, release: release("0.5.51") }),
    );
    mocks.fetch.mockResolvedValue(ok(release("0.5.70")));
    await expect(manager().checkForUpdates("manual")).resolves.toMatchObject({
      available: true,
      latestVersion: "0.5.70",
      provenance: { source: "live" },
    });
    const written = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    expect(written).toMatchObject({
      version: 2,
      origin: "github",
      release: { tag_name: "v0.5.70" },
    });
    expect(typeof written.retrievedAt).toBe("number");
  });

  it("reads the old cache shape but never labels it fresh", async () => {
    fs.writeFileSync(cacheFile(), JSON.stringify({ checkedAt: 42, release: release("0.5.52") }));
    mocks.fetch.mockRejectedValue(new Error("offline"));
    await expect(manager().checkForUpdates()).resolves.toMatchObject({
      latestVersion: "0.5.52",
      provenance: { source: "cached", lastSuccessfulRetrievalAt: 42 },
    });
  });

  it("refuses to install from cached metadata", async () => {
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({ version: 2, retrievedAt: 5, release: release("0.5.60") }),
    );
    mocks.fetch.mockRejectedValue(new Error("offline"));
    const instance = manager();
    const info = await instance.checkForUpdates();
    await expect(instance.downloadAndInstallUpdate(info)).rejects.toThrow(
      /cached release information/,
    );
  });

  it("coalesces duplicate checks of the same intent", async () => {
    mocks.fetch.mockResolvedValue(ok(release("0.5.60")));
    const instance = manager();
    const [a, b] = await Promise.all([instance.checkForUpdates(), instance.checkForUpdates()]);
    expect(a).toBe(b);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("a late background result cannot replace a newer manual check's install target", async () => {
    let releaseBackground!: () => void;
    mocks.fetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseBackground = () => resolve(ok(release("0.5.60")));
          }),
      )
      .mockImplementationOnce(async () => ok(release("0.5.61")));
    const instance = manager();
    const background = instance.checkForUpdates("background");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const manual = await instance.checkForUpdates("manual");
    releaseBackground();
    const late = await background;
    expect(manual.latestVersion).toBe("0.5.61");
    expect(late.latestVersion).toBe("0.5.60");
    // Installing the stale background answer is refused; the manual answer is authoritative.
    await expect(instance.downloadAndInstallUpdate(late)).rejects.toThrow(
      /Check for updates again/,
    );
  });
});
