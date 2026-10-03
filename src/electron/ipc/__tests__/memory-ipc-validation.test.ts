import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { validateInput } from "../../utils/validation";
import {
  AddUserFactRequestSchema,
  CommitmentsGetRequestSchema,
  isMemoryVisibleInWorkspace,
  KitOpenFileRequestSchema,
  MemoryDetailsRequestSchema,
  MemoryObservationSearchRequestSchema,
  MemoryRecentRequestSchema,
  MemorySaveSettingsRequestSchema,
  MemorySearchRequestSchema,
  MemoryTimelineRequestSchema,
  MemoryWriteApproveRequestSchema,
  MemoryWriteRejectRequestSchema,
  MessageFeedbackRequestSchema,
  RelationshipListRequestSchema,
  RelationshipUpdateRequestSchema,
  resolveKitOpenPath,
} from "../memory-ipc-validation";

const WS = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-open-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".cowork"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("memory IPC schemas (SEC-11)", () => {
  it("requires a workspace for memory search, timeline and details", () => {
    expect(() => validateInput(MemorySearchRequestSchema, { query: "x" })).toThrow();
    expect(() => validateInput(MemoryTimelineRequestSchema, { memoryId: "m1" })).toThrow();
    expect(() => validateInput(MemoryDetailsRequestSchema, ["m1"])).toThrow();
    expect(validateInput(MemoryDetailsRequestSchema, { workspaceId: WS, ids: ["m1"] })).toEqual({
      workspaceId: WS,
      ids: ["m1"],
    });
  });

  it("bounds query length, id counts and limits", () => {
    expect(() =>
      validateInput(MemorySearchRequestSchema, { workspaceId: WS, query: "q".repeat(1_001) }),
    ).toThrow();
    expect(() =>
      validateInput(MemoryDetailsRequestSchema, {
        workspaceId: WS,
        ids: Array.from({ length: 51 }, (_, i) => `m${i}`),
      }),
    ).toThrow();
    expect(
      validateInput(MemorySearchRequestSchema, { workspaceId: WS, query: "x", limit: 10_000 })
        .limit,
    ).toBe(100);
    expect(validateInput(MemoryRecentRequestSchema, { workspaceId: WS, limit: 1e9 }).limit).toBe(
      200,
    );
    expect(validateInput(CommitmentsGetRequestSchema, { limit: 1e6 })?.limit).toBe(100);
    expect(validateInput(CommitmentsGetRequestSchema, { limit: undefined })?.limit).toBeUndefined();
    expect(validateInput(RelationshipListRequestSchema, { limit: 1e6 })?.limit).toBe(500);
    expect(validateInput(RelationshipListRequestSchema, undefined)).toBeUndefined();
  });

  it("whitelists observation search fields", () => {
    expect(() =>
      validateInput(MemoryObservationSearchRequestSchema, { workspaceId: WS, sql: "1=1" }),
    ).toThrow();
    expect(() =>
      validateInput(MemoryObservationSearchRequestSchema, {
        workspaceId: WS,
        privacyStates: ["everything"],
      }),
    ).toThrow();
    expect(
      validateInput(MemoryObservationSearchRequestSchema, {
        workspaceId: WS,
        query: "q",
        limit: 500,
        privacyStates: ["private"],
      }).limit,
    ).toBe(100);
  });

  it("rejects unsafe excluded patterns in memory settings", () => {
    const ok = validateInput(MemorySaveSettingsRequestSchema, {
      workspaceId: WS,
      settings: { workspaceId: WS, enabled: true, excludedPatterns: ["api[_-]?key"] },
    });
    expect(ok.settings).toEqual({ enabled: true, excludedPatterns: ["api[_-]?key"] });
    expect(
      validateInput(MemorySaveSettingsRequestSchema, { workspaceId: WS, settings: {} }).settings,
    ).toEqual({});
    expect(() =>
      validateInput(MemorySaveSettingsRequestSchema, {
        workspaceId: WS,
        settings: { excludedPatterns: ["(a+)+$"] },
      }),
    ).toThrow(/nested or alternated/);
    expect(() =>
      validateInput(MemorySaveSettingsRequestSchema, {
        workspaceId: WS,
        settings: { privacyMode: "off" },
      }),
    ).toThrow();
  });

  it("forces user facts added from the renderer to a manual source", () => {
    const fact = validateInput(AddUserFactRequestSchema, {
      category: "preference",
      value: "Prefers tea",
      source: "conversation",
    });
    expect(fact.source).toBe("manual");
    expect(() =>
      validateInput(AddUserFactRequestSchema, { category: "nope", value: "x" }),
    ).toThrow();
  });

  it("checks relationship status and confidence", () => {
    expect(() =>
      validateInput(RelationshipUpdateRequestSchema, { id: "r1", status: "archived" }),
    ).toThrow();
    expect(() =>
      validateInput(RelationshipUpdateRequestSchema, { id: "r1", confidence: 7 }),
    ).toThrow();
    expect(
      validateInput(RelationshipUpdateRequestSchema, { id: "r1", status: "done", dueAt: null }),
    ).toEqual({ id: "r1", status: "done", dueAt: null });
  });

  it("restricts message feedback reasons and memory-write review payloads", () => {
    expect(() =>
      validateInput(MessageFeedbackRequestSchema, {
        taskId: "t1",
        decision: "rejected",
        reason: "<script>",
      }),
    ).toThrow();
    expect(
      validateInput(MessageFeedbackRequestSchema, {
        taskId: "t1",
        decision: "rejected",
        reason: "too_verbose",
      }).reason,
    ).toBe("too_verbose");
    expect(() => validateInput(MemoryWriteApproveRequestSchema, { id: "p1" })).toThrow();
    expect(() => validateInput(MemoryWriteRejectRequestSchema, { id: "p1" })).toThrow();
    expect(validateInput(MemoryWriteApproveRequestSchema, { id: "p1", workspaceId: WS })).toEqual({
      id: "p1",
      workspaceId: WS,
    });
  });

  it("only exposes other-workspace memories when they are imported", () => {
    expect(isMemoryVisibleInWorkspace({ workspaceId: WS, content: "x" }, WS)).toBe(true);
    expect(isMemoryVisibleInWorkspace({ workspaceId: "other", content: "secret" }, WS)).toBe(false);
    expect(
      isMemoryVisibleInWorkspace(
        { workspaceId: "other", content: "[Imported from ChatGPT]\nhello" },
        WS,
      ),
    ).toBe(true);
  });
});

describe("resolveKitOpenPath (SEC-11)", () => {
  it("accepts top-level kit files and marks them seedable", () => {
    const ws = makeWorkspace();
    const resolved = resolveKitOpenPath(ws, ".cowork/USER.md");
    expect(resolved.fileName).toBe("USER.md");
    expect(resolved.seedable).toBe(true);
    expect(resolveKitOpenPath(ws, ".cowork/projects/alpha/NOTES.md").seedable).toBe(false);
    expect(resolveKitOpenPath(ws, ".cowork/random.md").seedable).toBe(false);
  });

  it.each([".cowork/policy/rules.md", ".cowork/Policy/rules.md", ".cowork/policy/nested/deep.md"])(
    "rejects the protected path %s",
    (relPath) => {
      const ws = makeWorkspace();
      expect(() => resolveKitOpenPath(ws, relPath)).toThrow(/protected/);
    },
  );

  it.each([
    ".git/config.md",
    ".cowork/../.git/HEAD.md",
    ".cowork/./USER.md",
    ".cowork//USER.md",
    "../outside/.cowork/USER.md",
    ".cowork",
    ".cowork/tool.command",
    ".cowork/app.sh",
  ])("rejects the invalid path %s", (relPath) => {
    const ws = makeWorkspace();
    expect(() => resolveKitOpenPath(ws, relPath)).toThrow();
  });

  it("rejects a symlink that escapes .cowork", () => {
    const ws = makeWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kit-outside-"));
    tempDirs.push(outside);
    fs.writeFileSync(path.join(outside, "x.md"), "x");
    fs.symlinkSync(outside, path.join(ws, ".cowork", "link"));
    expect(() => resolveKitOpenPath(ws, ".cowork/link/x.md")).toThrow(/Invalid relPath/);
  });

  it("validates the request payload shape", () => {
    expect(() => validateInput(KitOpenFileRequestSchema, { workspaceId: WS })).toThrow();
    expect(() =>
      validateInput(KitOpenFileRequestSchema, { workspaceId: WS, relPath: 5 }),
    ).toThrow();
  });
});
