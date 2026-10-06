import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor";
import { MemoryRepoService } from "../../memory/repo/MemoryRepoService";

const MISTAKES = [
  "# Mistakes",
  "",
  "## Patterns",
  "<!-- cowork:auto:mistakes:start -->",
  "- Main: GENERATED_PATTERN",
  "<!-- cowork:auto:mistakes:end -->",
  "",
  "## Notes",
  "- HAND_WRITTEN_NOTE",
  "",
].join("\n");

function sharedContext(): string {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.workspace = { id: "workspace-1", path: "/tmp/ws", permissions: { read: true } };
  executor.readKitFilePrefix = (relPath: string) =>
    relPath === path.join(".cowork", "MISTAKES.md") ? MISTAKES : null;
  return executor.buildSharedContextBlock();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TaskExecutor shared context: MISTAKES.md", () => {
  it("keeps the feedback-pattern block while the memory folder is off", () => {
    vi.spyOn(MemoryRepoService, "get").mockReturnValue(null);
    const block = sharedContext();
    expect(block).toContain("GENERATED_PATTERN");
    expect(block).toContain("HAND_WRITTEN_NOTE");
  });

  it("drops the retired block and keeps hand-written text when the folder is writable", () => {
    vi.spyOn(MemoryRepoService, "get").mockReturnValue({
      isWritable: () => true,
    } as unknown as MemoryRepoService);
    const block = sharedContext();
    expect(block).not.toContain("GENERATED_PATTERN");
    expect(block).not.toContain("cowork:auto:mistakes");
    expect(block).toContain("HAND_WRITTEN_NOTE");
  });
});
