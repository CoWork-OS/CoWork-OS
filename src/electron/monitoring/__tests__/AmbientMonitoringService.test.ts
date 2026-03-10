import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const watchMock = vi.fn();
const execFileMock = vi.fn();
const googleCalendarRequestMock = vi.fn();
const loadGoogleSettingsMock = vi.fn(() => ({ enabled: false }));

vi.mock("chokidar", () => ({
  default: {
    watch: (...args: unknown[]) => watchMock(...args),
  },
}));

vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock("../../settings/google-workspace-manager", () => ({
  GoogleWorkspaceSettingsManager: {
    loadSettings: () => loadGoogleSettingsMock(),
  },
}));

vi.mock("../../utils/google-calendar-api", () => ({
  googleCalendarRequest: (...args: unknown[]) => googleCalendarRequestMock(...args),
}));

describe("AmbientMonitoringService", () => {
  function createWorkspaceDir(name: string, entries: string[] = ["src"]): string {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `cowork-ambient-${name}-`));
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry);
      if (path.extname(entry)) {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, "test", "utf8");
      } else {
        fs.mkdirSync(fullPath, { recursive: true });
      }
    }
    return baseDir;
  }

  beforeEach(() => {
    vi.resetModules();
    watchMock.mockReset();
    execFileMock.mockReset();
    googleCalendarRequestMock.mockReset();
    loadGoogleSettingsMock.mockReset();
    loadGoogleSettingsMock.mockReturnValue({ enabled: false });
  });

  it("emits file change signals into activities, triggers, and wakes", async () => {
    const handlers = new Map<string, (filePath: string) => void>();
    watchMock.mockReturnValue({
      on: vi.fn((event: string, handler: (filePath: string) => void) => {
        handlers.set(event, handler);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: (err: null, result: { stdout: string }) => void) =>
      cb(null, { stdout: "" }),
    );

    const recordActivity = vi.fn();
    const emitTrigger = vi.fn();
    const wakeHeartbeats = vi.fn();
    const { AmbientMonitoringService } = await import("../AmbientMonitoringService");
    const workspacePath = createWorkspaceDir("file-change");

    const service = new AmbientMonitoringService({
      listWorkspaces: () => [{ workspaceId: "ws-1", workspacePath, name: "Workspace" }],
      getDefaultWorkspaceId: () => "ws-1",
      recordActivity,
      emitTrigger,
      wakeHeartbeats,
    });

    await service.start();
    handlers.get("change")?.(path.join(workspacePath, "src", "app.ts"));

    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        activityType: "file_modified",
      }),
    );
    expect(emitTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "file_change",
      }),
    );
    expect(wakeHeartbeats).toHaveBeenCalled();
    await service.stop();
  });

  it("emits git drift signals when the repository snapshot changes", async () => {
    watchMock.mockReturnValue({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: (err: null, result: { stdout: string }) => void) =>
      cb(null, { stdout: "" }),
    );
    execFileMock
      .mockImplementationOnce(
        (_cmd, _args, _opts, cb: (err: null, result: { stdout: string }) => void) =>
          cb(null, { stdout: "## main\n" }),
      )
      .mockImplementationOnce(
        (_cmd, _args, _opts, cb: (err: null, result: { stdout: string }) => void) =>
          cb(null, { stdout: "## main\n M src/app.ts\n" }),
      );

    const recordActivity = vi.fn();
    const emitTrigger = vi.fn();
    const wakeHeartbeats = vi.fn();
    const { AmbientMonitoringService } = await import("../AmbientMonitoringService");
    const workspacePath = createWorkspaceDir("git-poll");
    const service = new AmbientMonitoringService({
      listWorkspaces: () => [{ workspaceId: "ws-1", workspacePath, name: "Workspace" }],
      getDefaultWorkspaceId: () => "ws-1",
      recordActivity,
      emitTrigger,
      wakeHeartbeats,
    });

    await (service as unknown as { pollGit: () => Promise<void> }).pollGit();
    await (service as unknown as { pollGit: () => Promise<void> }).pollGit();

    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        activityType: "info",
        title: "Git workspace state changed",
      }),
    );
    expect(emitTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "connector_event",
      }),
    );
    expect(wakeHeartbeats).toHaveBeenCalled();
  });

  it("emits calendar signals when connected calendars change", async () => {
    watchMock.mockReturnValue({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: (err: null, result: { stdout: string }) => void) =>
      cb(null, { stdout: "" }),
    );
    loadGoogleSettingsMock.mockReturnValue({ enabled: true });
    googleCalendarRequestMock
      .mockResolvedValueOnce({ data: { items: [{ id: "1", summary: "Standup" }] } })
      .mockResolvedValueOnce({ data: { items: [{ id: "2", summary: "Retro" }] } });

    const recordActivity = vi.fn();
    const emitTrigger = vi.fn();
    const wakeHeartbeats = vi.fn();
    const { AmbientMonitoringService } = await import("../AmbientMonitoringService");
    const workspacePath = createWorkspaceDir("calendar");
    const service = new AmbientMonitoringService({
      listWorkspaces: () => [{ workspaceId: "ws-1", workspacePath, name: "Workspace" }],
      getDefaultWorkspaceId: () => "ws-1",
      recordActivity,
      emitTrigger,
      wakeHeartbeats,
    });

    await service.start();
    await (service as unknown as { pollCalendars: () => Promise<void> }).pollCalendars();

    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Calendar events changed",
      }),
    );
    expect(emitTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "connector_event",
      }),
    );
    expect(wakeHeartbeats).toHaveBeenCalled();
    await service.stop();
  });

  it("skips broad remembered roots and only watches eligible workspaces", async () => {
    watchMock.mockReturnValue({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: (err: null, result: { stdout: string }) => void) =>
      cb(null, { stdout: "" }),
    );

    const { AmbientMonitoringService } = await import("../AmbientMonitoringService");
    const projectPath = createWorkspaceDir("eligible-project");
    const service = new AmbientMonitoringService({
      listWorkspaces: () => [
        { workspaceId: "downloads", workspacePath: path.join(os.homedir(), "Downloads"), name: "Downloads" },
        { workspaceId: "desktop", workspacePath: path.join(os.homedir(), "Desktop"), name: "Desktop" },
        { workspaceId: "project", workspacePath: projectPath, name: "Project" },
      ],
      getDefaultWorkspaceId: () => "project",
      recordActivity: vi.fn(),
      emitTrigger: vi.fn(),
      wakeHeartbeats: vi.fn(),
      log: vi.fn(),
    });

    await service.start();

    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(watchMock).toHaveBeenCalledWith(
      [path.join(projectPath, "src")],
      expect.objectContaining({ ignoreInitial: true }),
    );

    await service.stop();
  });
});
