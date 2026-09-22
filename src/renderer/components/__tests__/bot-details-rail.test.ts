import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getBotConversationStatusLabel,
  getBotStatusLabel,
  getBotStatusTone,
} from "../BotDetailsRail";

const railSource = readFileSync(
  fileURLToPath(new URL("../BotDetailsRail.tsx", import.meta.url)),
  "utf8",
);

const appSource = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");

describe("bot details rail", () => {
  it("uses human-facing lifecycle labels in the details rail", () => {
    expect(getBotStatusLabel("executing")).toBe("Working");
    expect(getBotStatusLabel("blocked")).toBe("Needs input");
    expect(getBotStatusLabel("completed")).toBe("Finished");
    expect(getBotStatusLabel("failed")).toBe("Failed");
    expect(getBotStatusLabel("waiting")).toBe("Waiting on a teammate");
    expect(getBotStatusTone("interrupted")).toBe("bad");
  });

  it("shows specific durable teammate activity for active conversations", () => {
    expect(
      getBotConversationStatusLabel("blocked", {
        state: "waiting",
        stateLabel: "Waiting on a teammate",
        activityLabel: "Waiting for Forge to reply",
      }),
    ).toBe("Waiting for Forge to reply");
    expect(
      getBotConversationStatusLabel("completed", {
        state: "completed",
        stateLabel: "Finished",
        activityLabel: "Reply received from Forge",
      }),
    ).toBe("Finished");
  });

  it("lets the durable bot conversation projection override a stale task row", () => {
    expect(railSource).toContain("conversationProjection?: Pick<");
    expect(railSource).toContain("projection?.stateLabel");
    expect(railSource).toContain("conversationProjection?.stateDetail");
    expect(railSource).toContain("projection?.activityLabel");
    expect(appSource).toContain("conversationProjection={botConversationProjection}");
  });

  it("keeps computer controls out of the bot details rail", () => {
    expect(railSource).not.toContain("This computer");
    expect(railSource).not.toContain("getComputerUseStatus");
    expect(railSource).not.toContain("Computer use settings");
    expect(railSource).not.toContain("Refresh computer status");
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
    // Bot conversations start transcript-first and keep the inspector available
    // through the title-bar toggle. Leaving the conversation restores the
    // panel preference that was active before the bot surface opened.
    expect(appSource).toContain("onCloseRightPanel={handleRightSidebarToggle}");
    expect(appSource).toContain("onClose={onCloseRightPanel}");
    expect(appSource).toMatch(/botConversation &&\s*!remoteTaskView &&\s*!effectiveRightCollapsed/);
    expect(appSource).toContain("isBotConversationSurface");
    expect(appSource).toContain("botConversationPanelMemoryRef");
    expect(appSource).toContain("previousCollapsed");
    // The title bar toggle remains the way back to the optional inspector.
    expect(appSource).not.toContain("isSelectedBotConversation");
  });
});
