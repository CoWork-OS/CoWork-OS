import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.5.51",
    isPackaged: true,
    getAppPath: () => "/Applications/CoWork OS.app",
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  net: { fetch: mocks.fetch },
  BrowserWindow: class {},
}));

import { UpdateManager } from "../update-manager";

const GITHUB_RELEASES_URL = "https://api.github.com/repos/CoWork-OS/CoWork-OS/releases/latest";

function githubResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: "v0.5.52",
      name: "0.5.52",
      body: "Release notes",
      html_url: "https://example.com/release",
      published_at: "2026-08-27T00:00:00Z",
      assets: [],
      ...overrides,
    }),
  };
}

function newManager() {
  const manager = new UpdateManager("linux", () => "6.8.0");
  vi.spyOn(manager, "getVersionInfo").mockResolvedValue({
    version: "0.5.51",
    isDev: false,
    isGitRepo: false,
    isNpmGlobal: false,
  });
  return manager;
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

describe("update check release resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue(githubResponse());
  });

  it("a background check asks CoWork's identifier-free endpoint first (mocked)", async () => {
    const env = { NODE_ENV: process.env.NODE_ENV, CI: process.env.CI };
    process.env.NODE_ENV = "production";
    delete process.env.CI;
    try {
      await newManager().checkForUpdates("background");
    } finally {
      process.env.NODE_ENV = env.NODE_ENV;
      if (env.CI !== undefined) process.env.CI = env.CI;
    }

    const urls = mocks.fetch.mock.calls.map((call) => String(call[0]));
    const pulse = urls.find((url) => url.includes("pulse.coworkosapp.com/v1/latest-version"));
    expect(pulse).toBeDefined();
    // Only version, platform, arch and surface: nothing that identifies the install.
    expect([...new URL(pulse as string).searchParams.keys()].sort()).toEqual([
      "arch",
      "platform",
      "surface",
      "version",
    ]);
  });

  it("a manual check goes directly to GitHub", async () => {
    await asProduction(() => newManager().checkForUpdates("manual"));
    const urls = mocks.fetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([GITHUB_RELEASES_URL]);
  });

  it("skips the version endpoint in tests and CI and uses GitHub directly", async () => {
    await newManager().checkForUpdates("background");

    const urls = mocks.fetch.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("pulse.coworkosapp.com"))).toBe(false);
    expect(urls).toContain(GITHUB_RELEASES_URL);
  });

  it("treats a 404 from the releases endpoint as 'no published release', not an error", async () => {
    // A repository with no published release (or one renamed/made private) is
    // a valid answer, but it is neutral: it does not assert currentness.
    mocks.fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });

    await expect(newManager().checkForUpdates()).resolves.toMatchObject({
      available: false,
      currentVersion: "0.5.51",
      latestVersion: "0.5.51",
      supported: true,
      provenance: { source: "no_release" },
    });
  });

  it("returns live provenance with check and retrieval times", async () => {
    const info = await newManager().checkForUpdates();
    expect(info.provenance).toMatchObject({ source: "live", origin: "github" });
    expect(info.provenance?.lastSuccessfulRetrievalAt).toBe(info.provenance?.checkedAt);
  });

  it("still surfaces a genuine API failure", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(newManager().checkForUpdates()).rejects.toThrow("GitHub API error: 500");
  });

  it("accepts a release whose body is null", async () => {
    // GitHub returns body: null for a release published without notes.
    mocks.fetch.mockResolvedValue(githubResponse({ body: null }));

    await expect(newManager().checkForUpdates()).resolves.toMatchObject({
      available: true,
      latestVersion: "0.5.52",
      releaseNotes: undefined,
    });
  });
});

describe("downloaded artifact signature lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives the .sig asset from the file that was actually downloaded", async () => {
    // A release can carry several artifacts for one platform; `files[0]` is not
    // necessarily the one electron-updater chose, and verifying one asset's
    // signature against another's bytes always fails.
    const manager = newManager() as never as {
      pendingUpdateInfo: { latestVersion: string } | null;
      verifyDownloadedArtifact: (event: unknown) => Promise<{ verified: boolean }>;
    };
    manager.pendingUpdateInfo = { latestVersion: "0.5.52" };

    const signature = await import("../release-signature");
    const fetchSignature = vi
      .spyOn(signature, "fetchArtifactSignature")
      .mockResolvedValue(undefined);
    vi.spyOn(signature, "isReleaseSignatureEnforced").mockReturnValue(true);
    vi.spyOn(signature, "verifyReleaseArtifact").mockResolvedValue({ status: "verified" });

    await manager.verifyDownloadedArtifact({
      downloadedFile: "/tmp/updates/CoWork-OS-0.5.52-arm64.zip",
      version: "0.5.52",
      files: [{ url: "CoWork-OS-0.5.52-arm64.dmg" }, { url: "CoWork-OS-0.5.52-arm64.zip" }],
    });

    expect(fetchSignature).toHaveBeenCalledWith(
      "https://github.com/CoWork-OS/CoWork-OS/releases/download/v0.5.52/CoWork-OS-0.5.52-arm64.zip",
    );
  });
});
