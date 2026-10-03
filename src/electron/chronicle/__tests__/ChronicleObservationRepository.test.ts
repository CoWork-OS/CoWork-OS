import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const memorySettingsState = vi.hoisted(() => ({ fail: false, enabled: true }));

vi.mock("../../database/schema", () => ({
  DatabaseManager: { getInstance: () => ({ getDatabase: () => ({}) }) },
}));
vi.mock("../../database/repository-facades", () => ({
  MemorySettingsRepository: class {
    async getOrCreate() {
      if (memorySettingsState.fail) throw new Error("settings unavailable");
      return {
        enabled: memorySettingsState.enabled,
        autoCapture: true,
        privacyMode: "normal",
      };
    }
  },
}));

import {
  ChronicleObservationRepository,
  isConfinedChronicleAssetPath,
} from "../ChronicleObservationRepository";
import type { ChronicleResolvedContext } from "../types";

function makeObservation(
  imagePath: string,
  overrides: Partial<ChronicleResolvedContext> = {},
): ChronicleResolvedContext {
  return {
    observationId: "obs-x",
    capturedAt: Date.now(),
    displayId: "1",
    appName: "Editor",
    windowTitle: "Draft",
    imagePath,
    localTextSnippet: "draft text",
    confidence: 0.8,
    usedFallback: false,
    provenance: "untrusted_screen_text",
    sourceRef: null,
    width: 10,
    height: 10,
    ...overrides,
  };
}

describe("ChronicleObservationRepository", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    memorySettingsState.fail = false;
    memorySettingsState.enabled = true;
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

    const deleted = await ChronicleObservationRepository.deleteObservation(
      workspacePath,
      record.id,
    );
    expect(deleted).toBe(true);
    expect(ChronicleObservationRepository.listSync(workspacePath, 10)).toHaveLength(0);
  });

  function makeWorkspace(): { workspacePath: string; sourceImage: string } {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-workspace-"));
    tempDirs.push(workspacePath);
    const sourceImage = path.join(workspacePath, "source.png");
    fs.writeFileSync(sourceImage, Buffer.from("fake-image"));
    return { workspacePath, sourceImage };
  }

  it("rejects traversal observation ids on delete and memory link", async () => {
    const { workspacePath } = makeWorkspace();
    const victim = path.join(workspacePath, "victim.json");
    fs.writeFileSync(victim, JSON.stringify({ id: "x", capturedAt: 1, imagePath: "" }));

    for (const badId of ["../../victim", "../victim", "chronicle-../../victim", "a/b", ""]) {
      expect(ChronicleObservationRepository.isValidObservationId(badId)).toBe(false);
      expect(await ChronicleObservationRepository.deleteObservation(workspacePath, badId)).toBe(
        false,
      );
      expect(await ChronicleObservationRepository.attachMemoryLink(workspacePath, badId, "m")).toBe(
        false,
      );
    }
    expect(fs.existsSync(victim)).toBe(true);
  });

  it("does not delete a planted imagePath outside the assets directory", async () => {
    const { workspacePath, sourceImage } = makeWorkspace();
    const record = await ChronicleObservationRepository.promote(workspacePath, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      query: "draft",
      observation: makeObservation(sourceImage),
    });
    expect(record).not.toBeNull();

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-outside-"));
    tempDirs.push(outsideDir);
    const precious = path.join(outsideDir, "precious.txt");
    fs.writeFileSync(precious, "keep me");
    const inWorkspace = path.join(workspacePath, "README.md");
    fs.writeFileSync(inWorkspace, "keep me too");

    const observationsDir = path.join(workspacePath, ".cowork", "chronicle", "observations");
    const recordPath = path.join(observationsDir, `${record!.id}.json`);
    fs.writeFileSync(recordPath, JSON.stringify({ ...record, imagePath: precious }));
    const plantedId = "chronicle-planted-1";
    fs.writeFileSync(
      path.join(observationsDir, `${plantedId}.json`),
      JSON.stringify({ ...record, id: plantedId, imagePath: inWorkspace }),
    );

    expect(isConfinedChronicleAssetPath(workspacePath, precious, record!.id)).toBe(false);
    expect(await ChronicleObservationRepository.deleteObservation(workspacePath, record!.id)).toBe(
      true,
    );
    expect(fs.existsSync(precious)).toBe(true);
    expect(fs.existsSync(recordPath)).toBe(false);

    await ChronicleObservationRepository.clearWorkspace(workspacePath);
    expect(fs.existsSync(inWorkspace)).toBe(true);
    expect(fs.existsSync(path.join(observationsDir, `${plantedId}.json`))).toBe(false);
    expect(ChronicleObservationRepository.listSync(workspacePath, 10)).toHaveLength(0);
  });

  it("deletes the record's own asset and clears assets on clearWorkspace", async () => {
    const { workspacePath, sourceImage } = makeWorkspace();
    const a = await ChronicleObservationRepository.promote(workspacePath, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      query: "draft",
      observation: makeObservation(sourceImage, { observationId: "obs-a" }),
    });
    const b = await ChronicleObservationRepository.promote(workspacePath, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      query: "draft",
      observation: makeObservation(sourceImage, { observationId: "obs-b" }),
    });
    expect(isConfinedChronicleAssetPath(workspacePath, a!.imagePath, a!.id)).toBe(true);
    await ChronicleObservationRepository.deleteObservation(workspacePath, a!.id);
    expect(fs.existsSync(a!.imagePath)).toBe(false);
    await ChronicleObservationRepository.clearWorkspace(workspacePath);
    expect(fs.existsSync(b!.imagePath)).toBe(false);
    expect(fs.existsSync(sourceImage)).toBe(true);
  });

  it("drops records whose id does not match the file name or pattern when listing", () => {
    const { workspacePath } = makeWorkspace();
    const observationsDir = path.join(workspacePath, ".cowork", "chronicle", "observations");
    fs.mkdirSync(observationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(observationsDir, "chronicle-a-1.json"),
      JSON.stringify({ id: "chronicle-other-2", capturedAt: 1, imagePath: "/etc/hosts" }),
    );
    fs.writeFileSync(
      path.join(observationsDir, "evil.json"),
      JSON.stringify({ id: "../evil", capturedAt: 1, imagePath: "/etc/hosts" }),
    );
    expect(ChronicleObservationRepository.listSync(workspacePath, 10)).toHaveLength(0);
  });

  it("skips promotion when the access-profile write guard denies", async () => {
    const { workspacePath, sourceImage } = makeWorkspace();
    const record = await ChronicleObservationRepository.promote(workspacePath, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      query: "draft",
      observation: makeObservation(sourceImage),
      canWrite: () => false,
    });
    expect(record).toBeNull();
    expect(fs.existsSync(path.join(workspacePath, ".cowork"))).toBe(false);
  });

  it("fails closed when workspace memory settings cannot be read", async () => {
    const { workspacePath, sourceImage } = makeWorkspace();
    memorySettingsState.fail = true;
    const record = await ChronicleObservationRepository.promote(workspacePath, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      query: "draft",
      observation: makeObservation(sourceImage),
    });
    expect(record).toBeNull();
  });

  it("rejects ids with path separators at promotion time", async () => {
    const { workspacePath, sourceImage } = makeWorkspace();
    const record = await ChronicleObservationRepository.promote(workspacePath, {
      workspaceId: "workspace-1",
      taskId: "../../escape",
      query: "draft",
      observation: makeObservation(sourceImage),
    });
    expect(record).toBeNull();
  });
});
