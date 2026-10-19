/**
 * The executor opens the skill-pack read scope around each tool call from the task's applied
 * skills: an applied directory-backed pack skill grants its pack root, nothing else does, and
 * the grant never leaks past the call or into another task.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomSkill, SkillApplication } from "../../../shared/types";
import { TaskExecutor } from "../executor";
import { getCustomSkillLoader } from "../custom-skill-loader";
import {
  getSkillPackReadRoots,
  registerSkillPackRoot,
  unregisterSkillPackRoot,
} from "../../security/skill-pack-read-access";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp") },
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getPersonalityPrompt: vi.fn().mockReturnValue(""),
    getIdentityPrompt: vi.fn().mockReturnValue(""),
  },
}));

vi.mock("../../memory/MemoryService", () => ({
  MemoryService: {},
}));

const SKILL_ID = "unity-scope-test:implement-in-app-purchases";

function application(skillId: string): SkillApplication {
  return {
    skillId,
    skillName: "Implement In-App Purchases",
    trigger: "slash",
    content: "Read references/pre-check.md",
    reason: `Applied via /${skillId}`,
    appliedAt: Date.now(),
  };
}

function createExecutor(appliedSkills?: SkillApplication[]) {
  const seenRoots: string[][] = [];
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-1", agentConfig: { deepWorkMode: false } };
  executor.abortController = new AbortController();
  executor.streamingToolExecutor = null;
  executor.currentStepId = null;
  executor.getSchedulerSpecForTool = vi.fn(() => ({
    concurrencyClass: "read_parallel",
    idempotent: true,
  }));
  executor.getToolPolicyContext = vi.fn(() => ({}));
  executor.toolExecutionCoordinator = {
    executeTool: vi.fn(async () => {
      seenRoots.push(getSkillPackReadRoots());
      return { result: { success: true }, durationMs: 1, resultJson: "{}" };
    }),
  };
  if (appliedSkills) executor.appliedSkills = appliedSkills;
  return { executor, seenRoots };
}

describe("TaskExecutor skill pack read scope", () => {
  let packRoot: string;
  let skillFile: string;
  let skill: CustomSkill;

  beforeEach(() => {
    packRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-exec-pack-")), "unity");
    skillFile = path.join(packRoot, "skills", "iap", "SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, "Read references/pre-check.md\n");
    expect(registerSkillPackRoot("unity-scope-test", packRoot, [skillFile])).toBe(true);
    skill = {
      id: SKILL_ID,
      name: "Implement In-App Purchases",
      description: "IAP",
      icon: "🧩",
      prompt: "Read references/pre-check.md",
      enabled: true,
      source: "managed",
      filePath: skillFile,
      metadata: { version: "1.0.0", pluginSource: "unity-scope-test" },
    } as CustomSkill;
    getCustomSkillLoader().registerPluginSkill(skill);
  });

  afterEach(() => {
    getCustomSkillLoader().unregisterPluginSkills("unity-scope-test");
    unregisterSkillPackRoot("unity-scope-test");
    fs.rmSync(path.dirname(packRoot), { recursive: true, force: true });
  });

  it("grants nothing when the task applied no skill", async () => {
    const { executor, seenRoots } = createExecutor();
    await executor.executeToolWithHeartbeat("read_file", { path: "x" }, 30_000);
    expect(seenRoots).toEqual([[]]);
  });

  it("grants the applied pack skill's root for the duration of the tool call only", async () => {
    const { executor, seenRoots } = createExecutor([application(SKILL_ID)]);
    await executor.executeToolWithHeartbeat("read_file", { path: "x" }, 30_000);
    expect(seenRoots).toEqual([[fs.realpathSync.native(packRoot)]]);
    expect(getSkillPackReadRoots()).toEqual([]);

    // Another task's executor has not applied the skill.
    const other = createExecutor();
    await other.executor.executeToolWithHeartbeat("read_file", { path: "x" }, 30_000);
    expect(other.seenRoots).toEqual([[]]);
  });

  it("grants nothing for a non-pack skill or a pack disabled since it was applied", async () => {
    const { executor, seenRoots } = createExecutor([application("not-a-pack-skill")]);
    await executor.executeToolWithHeartbeat("read_file", { path: "x" }, 30_000);

    const applied = createExecutor([application(SKILL_ID)]);
    unregisterSkillPackRoot("unity-scope-test");
    await applied.executor.executeToolWithHeartbeat("read_file", { path: "x" }, 30_000);

    expect(seenRoots).toEqual([[]]);
    expect(applied.seenRoots).toEqual([[]]);
  });
});
