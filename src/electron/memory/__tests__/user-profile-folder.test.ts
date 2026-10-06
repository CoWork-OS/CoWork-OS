/**
 * The user profile over the memory folder (docs/memory-repo-phase3-design.md §5): facts are
 * `me.md` and `MEMORY.md` entries plus PersonalityManager's name, refreshed on every folder
 * change; facts are written there (onboarding tagged and replaceable) and deleted by ref.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personality = vi.hoisted(() => ({ name: undefined as string | undefined }));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getUserName: vi.fn(() => personality.name),
    setUserName: vi.fn((name: string) => {
      personality.name = name || undefined;
    }),
  },
}));

import { MemoryRepoService } from "../repo/MemoryRepoService";
import { parseMemoryRepoEntries } from "../repo/memory-repo-format";
import { UserProfileService } from "../UserProfileService";
import {
  UserProfileFolderModel,
  entryToUserFact,
  memoryKindForUserFactCategory,
  userFactCategoryOfEntry,
} from "../user-profile-folder";

describe("user profile over the memory folder", () => {
  let base: string;
  let service: MemoryRepoService;
  const me = () => parseMemoryRepoEntries(fs.readFileSync(path.join(service.root, "me.md"), "utf8"));

  beforeEach(async () => {
    personality.name = undefined;
    base = fs.mkdtempSync(path.join(os.tmpdir(), "user-profile-folder-"));
    service = new MemoryRepoService({ root: path.join(base, "memory"), runtime: "node" });
    await service.start();
    UserProfileFolderModel.reset();
    MemoryRepoService.setInstance(service);
    UserProfileFolderModel.install();
    await UserProfileFolderModel.refresh();
  });

  afterEach(() => {
    UserProfileFolderModel.reset();
    MemoryRepoService.setInstance(null);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("maps entry kinds and category tags to profile categories", () => {
    const entry = (kind: string | null, metadata: Record<string, string> = {}) =>
      userFactCategoryOfEntry({ kind: kind as never, metadata });
    expect(entry("identity")).toBe("identity");
    expect(entry("preference")).toBe("preference");
    expect(entry("correction")).toBe("preference");
    expect(entry("rule")).toBe("constraint");
    expect(entry("insight")).toBe("other");
    expect(entry(null)).toBe("other");
    expect(entry("identity", { category: "goal" })).toBe("goal");
    expect(entry("identity", { category: "nonsense" })).toBe("identity");
    expect(memoryKindForUserFactCategory("work")).toBe("identity");
    expect(memoryKindForUserFactCategory("voice")).toBe("preference");
    expect(memoryKindForUserFactCategory("constraint")).toBe("rule");
  });

  it("reads me.md and MEMORY.md entries, refreshed after every folder change", async () => {
    await service.remember({
      text: "Prefers short answers",
      kind: "preference",
      scope: "global",
      by: "user",
      origin: "memory_hub",
    });
    await service.remember({
      text: "Answer in English",
      kind: "preference",
      scope: "global",
      by: "user",
      pinned: true,
      origin: "memory_hub",
    });
    await service.remember({
      text: "Works on the billing team",
      kind: "identity",
      scope: "global",
      by: "agent",
      taskId: "task-9",
      origin: "agent_tool",
    });
    // A lesson is not a profile fact.
    await service.remember({ text: "Run lint first", kind: "rule", scope: "global", by: "user", origin: "memory_hub" });
    await UserProfileFolderModel.refresh();
    const facts = UserProfileService.getProfile().facts;
    expect(facts.map((fact) => fact.value)).toEqual([
      "Answer in English",
      "Prefers short answers",
      "Works on the billing team",
    ]);
    expect(facts[0]).toMatchObject({ id: "repo:MEMORY.md#L3", pinned: true, source: "manual", confidence: 1 });
    expect(facts[2]).toMatchObject({
      category: "identity",
      source: "conversation",
      confidence: 0.7,
      lastTaskId: "task-9",
    });
    expect(facts[2].firstSeenAt).toBeGreaterThan(0);
  });

  it("includes PersonalityManager's name instead of folder name lines", async () => {
    personality.name = "Mesut";
    await service.remember({
      text: "Preferred name: Old",
      kind: "identity",
      scope: "global",
      by: "user",
      subject: "preferred_name",
      origin: "memory_hub",
    });
    await UserProfileFolderModel.refresh();
    const names = UserProfileService.getProfile().facts.filter((fact) => /preferred name/i.test(fact.value));
    expect(names).toEqual([
      expect.objectContaining({ value: "Preferred name: Mesut", category: "identity", pinned: true }),
    ]);
  });

  it("adds facts as the user's me.md lines with their category and sets the name", async () => {
    const fact = await UserProfileService.addFact({
      category: "work",
      value: "Current work context: billing",
      source: "manual",
      pinned: true,
    });
    expect(fact).toMatchObject({ id: "repo:MEMORY.md#L3", category: "work", value: "Current work context: billing" });
    await UserProfileService.addFact({ category: "identity", value: "Preferred name: Alex", source: "manual" });
    expect(personality.name).toBe("Alex");
    expect(me()).toEqual([
      expect.objectContaining({ text: "Preferred name: Alex", by: "user", subject: "preferred_name" }),
    ]);
  });

  it("replaces onboarding facts on re-onboarding and leaves the user's other lines", async () => {
    await service.remember({ text: "Likes tea", kind: "preference", scope: "global", by: "user", origin: "memory_hub" });
    const first = await UserProfileService.replaceTaggedFacts("onboarding", [
      { category: "identity", value: "Preferred name: Alex", source: "manual", pinned: true },
      { category: "work", value: "Current work context: payments", source: "manual", pinned: true },
    ]);
    expect(first).toBe(true);
    expect(me().map((entry) => [entry.text, entry.metadata.origin ?? null])).toEqual([
      ["Likes tea", null],
      ["Preferred name: Alex", "onboarding"],
      ["Current work context: payments", "onboarding"],
    ]);
    await UserProfileService.replaceTaggedFacts("onboarding", [
      { category: "work", value: "Current work context: billing", source: "manual" },
    ]);
    expect(me().map((entry) => entry.text)).toEqual(["Likes tea", "Current work context: billing"]);
    expect(me()[1].metadata).toMatchObject({ category: "work", origin: "onboarding", by: "user" });
  });

  it("deletes a folder fact by its id, guarded by the hash it read", async () => {
    await service.remember({ text: "Likes tea", kind: "preference", scope: "global", by: "user", origin: "memory_hub" });
    await UserProfileFolderModel.refresh();
    const [fact] = UserProfileService.getProfile().facts;
    expect(await UserProfileService.deleteFact("repo:lessons.md#L1")).toBe(false);
    expect(await UserProfileService.deleteFact(fact.id)).toBe(true);
    expect(me()).toEqual([]);
    expect(UserProfileService.getProfile().facts).toEqual([]);
    // The cache is gone with the line: a second delete does nothing.
    expect(await UserProfileService.deleteFact(fact.id)).toBe(false);
  });

  it("falls back to memory_items while the folder is off", async () => {
    MemoryRepoService.setInstance(null);
    await UserProfileFolderModel.refresh();
    expect(UserProfileFolderModel.facts()).toBeNull();
    expect(UserProfileService.getProfile().facts).toEqual([]);
    await expect(UserProfileService.replaceTaggedFacts("onboarding", [])).resolves.toBe(false);
  });

  it("builds a fact from an entry", () => {
    const [entry] = parseMemoryRepoEntries("- Uses vim [by: agent; kind: preference; added: 2026-10-05]");
    expect(entryToUserFact("me.md", entry)).toMatchObject({
      id: "repo:me.md#L1",
      category: "preference",
      firstSeenAt: Date.parse("2026-10-05T00:00:00Z"),
    });
  });
});
