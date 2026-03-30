import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relaunchMock = vi.fn();
const exitMock = vi.fn();

vi.mock("electron", () => ({
  app: {
    relaunch: relaunchMock,
    exit: exitMock,
  },
}));

describe("ProfileManager", () => {
  let originalArgv: string[];
  let envSnapshot: Record<string, string | undefined>;
  let userDataRoot: string;

  beforeEach(() => {
    originalArgv = [...process.argv];
    envSnapshot = { ...process.env };
    userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-profile-manager-"));
    relaunchMock.mockReset();
    exitMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
    fs.rmSync(userDataRoot, { recursive: true, force: true });
  });

  it("creates named profiles under the profiles root and lists them with default", async () => {
    process.env.COWORK_USER_DATA_DIR = userDataRoot;
    process.argv = ["electron", "app"];

    const { ProfileManager } = await import("../ProfileManager");
    const created = await ProfileManager.ensureProfile("Work Alpha");
    const profiles = await ProfileManager.listProfiles();

    expect(created.id).toBe("work-alpha");
    expect(created.userDataDir).toBe(path.join(userDataRoot, "profiles", "work-alpha"));
    expect(fs.existsSync(path.join(created.userDataDir, ".cowork-profile.json"))).toBe(true);
    expect(profiles.some((profile) => profile.id === "default")).toBe(true);
    expect(profiles.some((profile) => profile.id === "work-alpha")).toBe(true);
  });

  it("relaunches with a single normalized profile argument when switching", async () => {
    process.env.COWORK_USER_DATA_DIR = userDataRoot;
    process.argv = ["electron", "app", "--inspect", "--profile", "old-profile"];

    const { ProfileManager } = await import("../ProfileManager");
    await ProfileManager.switchProfile("Ops Team");

    expect(relaunchMock).toHaveBeenCalledWith({
      args: ["app", "--inspect", "--profile", "ops-team"],
    });
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("exports and imports a profile bundle", async () => {
    process.env.COWORK_USER_DATA_DIR = userDataRoot;
    process.argv = ["electron", "app"];

    const { ProfileManager } = await import("../ProfileManager");
    const created = await ProfileManager.ensureProfile("Research");
    fs.writeFileSync(path.join(created.userDataDir, "notes.txt"), "hello profile");

    const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-profile-export-"));
    const exported = await ProfileManager.exportProfile(created.id, exportRoot);
    expect(fs.existsSync(path.join(exported.bundlePath, "notes.txt"))).toBe(true);
    expect(fs.existsSync(path.join(exported.bundlePath, "cowork-profile-export.json"))).toBe(true);

    const imported = await ProfileManager.importProfile(exported.bundlePath, "Imported Research");
    expect(imported.id).toBe("imported-research");
    expect(fs.readFileSync(path.join(imported.userDataDir, "notes.txt"), "utf8")).toBe("hello profile");

    fs.rmSync(exportRoot, { recursive: true, force: true });
  });
});
