import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getHostComputerStatusLabel, isHostComputerReady } from "../BotDetailsRail";

const railSource = readFileSync(
  fileURLToPath(new URL("../BotDetailsRail.tsx", import.meta.url)),
  "utf8",
);

const appSource = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");

describe("bot host computer status", () => {
  it("labels the selected conversation when it owns the host computer", () => {
    expect(getHostComputerStatusLabel("task-1", "task-1")).toBe("In use by this conversation");
  });

  it("distinguishes another task from an available host computer", () => {
    expect(getHostComputerStatusLabel("task-2", "task-1")).toBe("In use by another task");
    expect(getHostComputerStatusLabel(null, "task-1")).toBe("Available when this bot needs it");
    expect(getHostComputerStatusLabel(null, "task-1", false)).toBe("Needs setup on this computer");
  });

  it("only reports the host as ready after local computer-use permissions are available", () => {
    expect(
      isHostComputerReady({
        platform: "darwin",
        installed: true,
        accessibilityTrusted: true,
        screenCaptureStatus: "granted",
      }),
    ).toBe(true);
    expect(
      isHostComputerReady({
        platform: "darwin",
        installed: true,
        accessibilityTrusted: true,
        screenCaptureStatus: "denied",
      }),
    ).toBe(false);
    expect(
      isHostComputerReady({
        platform: "linux",
        installed: true,
        accessibilityTrusted: true,
        screenCaptureStatus: "granted",
      }),
    ).toBe(false);
  });

  it("describes the local CoWork host instead of a separate computer surface", () => {
    expect(railSource).toContain("This computer");
    expect(railSource).toContain("Uses the computer running CoWork OS");
    expect(railSource).toContain("Computer use settings");
    expect(railSource).not.toContain("Open computer");
    expect(railSource).not.toContain("VM");
  });
});

describe("bot details rail dismissal", () => {
  it("offers a close control in the rail header", () => {
    expect(railSource).toContain("onClose?: () => void;");
    expect(railSource).toContain('aria-label="Hide bot details"');
  });

  it("hides the rail when the shared right panel is collapsed", () => {
    // Bot conversations used to force the rail open, which left no way to
    // dismiss it; they now share the right panel collapse state.
    expect(appSource).toContain("onCloseRightPanel={handleRightSidebarToggle}");
    expect(appSource).toContain("onClose={onCloseRightPanel}");
    expect(appSource).toMatch(/botConversation &&\s*!remoteTaskView &&\s*!effectiveRightCollapsed/);
    // The title bar toggle is the only way back, so it must not be hidden here.
    expect(appSource).not.toContain("isSelectedBotConversation");
  });
});
