import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ChronicleObservationRepository } from "../ChronicleObservationRepository";

describe("ChronicleObservationRepository", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("promotes used observations into workspace recall storage", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-workspace-"));
    tempDirs.push(workspacePath);
    const sourceImage = path.join(workspacePath, "source.png");
    fs.writeFileSync(sourceImage, Buffer.from("fake-image"));

    const record = await ChronicleObservationRepository.promote(workspacePath, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      query: "latest draft",
      observation: {
        observationId: "obs-1",
        capturedAt: Date.now(),
        displayId: "1",
        appName: "Google Docs",
        windowTitle: "Q2 Draft",
        imagePath: sourceImage,
        localTextSnippet: "Quarterly draft",
        confidence: 0.81,
        usedFallback: false,
        provenance: "untrusted_screen_text",
        sourceRef: { kind: "app", value: "Google Docs", label: "Google Docs" },
        width: 100,
        height: 100,
      },
      destinationHints: ["google_doc"],
    });

    expect(record).not.toBeNull();
    if (!record) {
      throw new Error("Expected Chronicle observation to persist");
    }
    expect(record.imagePath).toContain(path.join(".cowork", "chronicle", "assets"));
    expect(fs.existsSync(record.imagePath)).toBe(true);

    const results = ChronicleObservationRepository.searchSync(workspacePath, "draft", 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.destinationHints).toContain("google_doc");
    expect(results[0]?.taskId).toBe("task-1");
  });

  it("can attach memory links and delete persisted observations", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-workspace-"));
    tempDirs.push(workspacePath);
    const sourceImage = path.join(workspacePath, "source.png");
    fs.writeFileSync(sourceImage, Buffer.from("fake-image"));

    const record = await ChronicleObservationRepository.promote(workspacePath, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      query: "latest draft",
      observation: {
        observationId: "obs-2",
        capturedAt: Date.now(),
        displayId: "1",
        appName: "Slack",
        windowTitle: "Draft review",
        imagePath: sourceImage,
        localTextSnippet: "Please sync the latest draft",
        confidence: 0.72,
        usedFallback: false,
        provenance: "untrusted_screen_text",
        sourceRef: { kind: "url", value: "https://app.slack.com", label: "Slack" },
        width: 100,
        height: 100,
      },
      destinationHints: ["slack_dm"],
    });

    expect(record).not.toBeNull();
    if (!record) {
      throw new Error("Expected Chronicle observation to persist");
    }

    await ChronicleObservationRepository.attachMemoryLink(workspacePath, record.id, "memory-1");
    const updated = ChronicleObservationRepository.listSync(workspacePath, 10)[0];
    expect(updated?.memoryId).toBe("memory-1");

    const deleted = await ChronicleObservationRepository.deleteObservation(workspacePath, record.id);
    expect(deleted).toBe(true);
    expect(ChronicleObservationRepository.listSync(workspacePath, 10)).toHaveLength(0);
  });
});
