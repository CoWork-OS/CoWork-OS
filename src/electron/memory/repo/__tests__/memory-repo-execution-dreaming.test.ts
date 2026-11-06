import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepoDreamer, type DreamModelClient } from "../MemoryRepoDreamer";
import { MemoryRepoService } from "../MemoryRepoService";
import {
  applyDreamOperations,
  buildDreamInput,
  classifyDreamOperations,
  confirmedDreamRechecks,
  parseDreamOutput,
  type DreamTaskInput,
} from "../memory-repo-dream-plan";
import type {
  DreamExecutionEvidence,
  DreamExecutionEvidenceRef,
} from "../memory-repo-dream-execution";
import { isMemoryRepoMarker, parseMemoryRepoEntries } from "../memory-repo-format";
import { renderMemoryRepoFile } from "../MemoryRepoContext";
import { hashMemoryItemContent } from "../../memory-items-types";

const NOW = Date.UTC(2026, 10, 6, 12);
const OBSERVATION = "The migration smoke test passed against the older database schema.";
const LESSON = "Check the upgrade path when changing database migrations.";
const RECEIPT: DreamExecutionEvidence = {
  taskId: "task-1",
  workspaceId: "ws-billing",
  eventId: "event-completion-1",
  contentHash: "a".repeat(64),
  excerpt: OBSERVATION,
};
const RECEIPT_REF: DreamExecutionEvidenceRef = {
  taskId: RECEIPT.taskId,
  workspaceId: RECEIPT.workspaceId,
  eventId: RECEIPT.eventId,
  contentHash: RECEIPT.contentHash,
};

function task(evidence: DreamExecutionEvidence = RECEIPT): DreamTaskInput {
  return {
    taskId: "task-1",
    workspaceId: "ws-billing",
    workspaceName: "Billing",
    title: "Verify a database migration",
    createdAt: NOW - 60_000,
    userMessages: ["Please fix the migration. Always show the validation results."],
    finalReply: "The migration is ready.",
    executionEvidence: evidence,
  };
}

function files(): Map<string, string> {
  return new Map([
    ["MEMORY.md", "# Memory\n\n## Index\n- [[me]]\n- [[workspaces/billing]]\n"],
    ["me.md", "# About me\n\n- Prefers short answers [by: user; kind: preference]\n"],
    [
      "workspaces/billing.md",
      "# Billing\n\n- CoWork workspace [by: user; workspace: ws-billing]\n",
    ],
    ["workspaces/other.md", "# Other\n\n- CoWork workspace [by: user; workspace: ws-other]\n"],
  ]);
}

function lesson(extra: Record<string, unknown> = {}) {
  return {
    op: "add_lesson",
    text: LESSON,
    evidence: [{ outcome: "E1", quote: OBSERVATION }],
    ...extra,
  };
}

function classify(
  rawOperation: unknown,
  input = buildDreamInput({ files: files(), tasks: [task()] }),
) {
  const parsed = parseDreamOutput(JSON.stringify({ operations: [rawOperation] }));
  return { parsed, classified: classifyDreamOperations(parsed.operations, input), input };
}

describe("execution-backed dream lessons", () => {
  it("exposes only receipt evidence from tasks included in the bounded dream input", () => {
    const included = buildDreamInput({ files: files(), tasks: [task()], now: NOW });
    expect(included.user).toContain(OBSERVATION);
    expect(included.executionEvidence?.get("E1")).toEqual(RECEIPT);

    const withoutEvidence = { ...task(), executionEvidence: undefined };
    const omitted = buildDreamInput({
      files: files(),
      tasks: [
        ...Array.from({ length: 20 }, (_, index) => ({
          ...withoutEvidence,
          taskId: `earlier-${index}`,
        })),
        task(),
      ],
      now: NOW,
    });
    expect(omitted.user).not.toContain(OBSERVATION);
    expect(omitted.executionEvidence?.size ?? 0).toBe(0);
    expect(classify(lesson(), omitted).classified[0]?.decision).toBe("rejected");
  });

  it("stages a quoted observation and an explicit inference for review in the evidence workspace", () => {
    const { classified, input } = classify(lesson());
    expect(classified).toHaveLength(1);
    expect(classified[0]).toMatchObject({
      decision: "review",
      executionEvidence: [RECEIPT_REF],
    });

    const result = applyDreamOperations({
      files: files(),
      operations: classified,
      by: "user",
      now: NOW,
    });
    expect(result.skipped).toEqual([]);
    const written = result.files.get("workspaces/billing.md") ?? "";
    expect(written).toContain(OBSERVATION);
    expect(written).toContain(LESSON);
    const entry = parseMemoryRepoEntries(written).find((candidate) =>
      candidate.text.includes(LESSON),
    );
    expect(entry?.kind).toBe("insight");
    expect(entry?.metadata).toMatchObject({
      learning: "execution",
      evidence: RECEIPT.contentHash,
      source: `cowork://tasks/${RECEIPT.taskId}`,
      event: RECEIPT.eventId,
      execution_workspace: RECEIPT.workspaceId,
    });
    if (!entry) throw new Error("execution lesson was not written");
    expect(isMemoryRepoMarker(entry)).toBe(false);
    expect(
      renderMemoryRepoFile("workspaces/billing.md", written, 1_000, {
        skipWorkspaceMarker: true,
      }).lines.join("\n"),
    ).toContain(LESSON);
    expect(result.files.has("me.md")).toBe(false);
    expect(result.files.has("workspaces/other.md")).toBe(false);
    expect(input.executionEvidence?.get("E1")?.workspaceId).toBe("ws-billing");
  });

  it.each([
    { name: "an invented receipt alias", evidence: [{ outcome: "E999", quote: OBSERVATION }] },
    {
      name: "an invented observation",
      evidence: [{ outcome: "E1", quote: "All production data was independently verified." }],
    },
    { name: "a trivial quoted fragment", evidence: [{ outcome: "E1", quote: "The" }] },
  ])("rejects $name", async ({ evidence }) => {
    const { parsed, classified } = classify(lesson({ evidence }));
    expect(parsed.invalid + classified.length).toBeGreaterThan(0);
    expect(classified.every((operation) => operation.decision === "rejected")).toBe(true);
  });

  it("rejects a quote outside the excerpt actually shown to the model", () => {
    const hidden = "This hidden observation was never included in the prompt.";
    const input = buildDreamInput({
      files: files(),
      tasks: [task({ ...RECEIPT, excerpt: `${"visible check completed\n".repeat(300)}${hidden}` })],
    });
    expect(input.user).not.toContain(hidden);
    expect(input.executionEvidence?.get("E1")?.excerpt).toContain("visible check completed");
    expect(
      classify(lesson({ evidence: [{ outcome: "E1", quote: hidden }] }), input).classified[0]
        ?.decision,
    ).toBe("rejected");
  });

  it("does not turn text embedded in a shell command into an observed test result", () => {
    const check = "- shell_command: Verification passed: printf 'all migration tests passed'";
    const input = buildDreamInput({
      files: files(),
      tasks: [task({ ...RECEIPT, excerpt: check })],
    });
    const fragment = classify(
      lesson({ evidence: [{ outcome: "E1", quote: "all migration tests passed" }] }),
      input,
    );
    expect(fragment.classified[0]?.decision).toBe("rejected");

    const complete = classify(lesson({ evidence: [{ outcome: "E1", quote: check }] }), input);
    expect(complete.classified[0]?.decision).toBe("review");
    expect(complete.classified[0]?.text).toContain(check);
  });

  it("requires existence-only qualifications to remain in the cited observation", () => {
    const check = '- file_exists: All required files exist (existence only): "dist/app.js"';
    const input = buildDreamInput({
      files: files(),
      tasks: [task({ ...RECEIPT, excerpt: check })],
    });
    expect(
      classify(lesson({ evidence: [{ outcome: "E1", quote: "All required files exist" }] }), input)
        .classified[0]?.decision,
    ).toBe("rejected");
    expect(
      classify(lesson({ evidence: [{ outcome: "E1", quote: check }] }), input).classified[0]
        ?.decision,
    ).toBe("review");
  });

  it("prevents the model from redirecting a lesson to another workspace or a user preference", () => {
    const { parsed, classified } = classify(
      lesson({ file: "workspaces/other.md", kind: "preference", scope: "global" }),
    );
    expect(parsed.invalid).toBeGreaterThan(0);
    expect(classified).toEqual([]);
  });

  it("does not expose a receipt belonging to a different task or workspace", () => {
    for (const evidence of [
      { ...RECEIPT, workspaceId: "ws-other" },
      { ...RECEIPT, taskId: "task-other" },
    ]) {
      const input = buildDreamInput({ files: files(), tasks: [task(evidence)] });
      expect(input.executionEvidence?.size ?? 0).toBe(0);
      expect(input.user).not.toContain(OBSERVATION);
      expect(classify(lesson(), input).classified[0]?.decision).toBe("rejected");
    }
  });

  it("does not apply a lesson if its destination was reassigned to another workspace", () => {
    const { classified } = classify(lesson());
    const changed = files();
    changed.set(
      "workspaces/billing.md",
      "# Reassigned\n\n- CoWork workspace [by: user; workspace: ws-other]\n",
    );

    const result = applyDreamOperations({
      files: changed,
      operations: classified,
      by: "user",
      now: NOW,
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.files.size).toBe(0);
  });

  it("does not recreate a deleted workspace file without its scope marker", () => {
    const { classified } = classify(lesson());
    const changed = files();
    changed.delete("workspaces/billing.md");

    const result = applyDreamOperations({
      files: changed,
      operations: classified,
      by: "user",
      now: NOW,
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.files.size).toBe(0);
  });

  it("does not create a second file when a workspace acquired a memory file during inference", () => {
    const original = files();
    original.delete("workspaces/billing.md");
    const input = buildDreamInput({ files: original, tasks: [task()] });
    const { classified } = classify(lesson(), input);
    expect(classified[0]?.createWorkspace?.id).toBe("ws-billing");

    const result = applyDreamOperations({
      files: files(),
      operations: classified,
      by: "user",
      now: NOW,
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.files.size).toBe(0);
  });

  it("keeps the ordinary user-quoted add path unchanged", () => {
    const { classified } = classify({
      op: "add",
      file: "workspaces/billing.md",
      text: "Always show the validation results",
      kind: "preference",
      evidence: [{ task: "T1", quote: "Always show the validation results" }],
    });
    expect(classified[0]).toMatchObject({ decision: "auto", sourceTaskId: "task-1" });
    expect(classified[0].executionEvidence).toBeUndefined();
  });

  it("keeps source rechecks independent when a dream also proposes a new execution lesson", () => {
    const source = {
      file: "me.md",
      entryHash: hashMemoryItemContent("Prefers short answers"),
      source: "docs/preferences.md",
      changedAt: NOW,
      excerpt: "Prefers short answers",
      evidenceAvailable: true,
      observedContentHash: "b".repeat(64),
    };
    const input = buildDreamInput({ files: files(), tasks: [task()], rechecks: [source] });
    const parsed = parseDreamOutput(
      JSON.stringify({
        operations: [lesson()],
        rechecks: [{ source: "R1", verdict: "confirmed", quote: source.excerpt }],
      }),
    );

    expect(confirmedDreamRechecks(parsed, input)).toEqual([source]);
  });

  it("rejects multiple receipts until the stored provenance can represent them", () => {
    const { parsed } = classify(
      lesson({
        evidence: [
          { outcome: "E1", quote: OBSERVATION },
          { outcome: "E2", quote: "A separate verification passed." },
        ],
      }),
    );
    expect(parsed.operations).toEqual([]);
    expect(parsed.invalid).toBeGreaterThan(0);
  });

  it("blocks rewriting or relocating execution-derived lessons while allowing reviewed removal", () => {
    const sourceFiles = files();
    const protectedLine = `- ${LESSON} [by: user; kind: insight; learning: execution; evidence: ${RECEIPT.contentHash}; task: task-1; event: event-completion-1]\n`;
    sourceFiles.set(
      "workspaces/billing.md",
      `${sourceFiles.get("workspaces/billing.md")}${protectedLine}- A separate note [by: agent; kind: insight]\n`,
    );
    sourceFiles.set("inbox.md", `# Inbox\n\n${protectedLine}`);
    const input = buildDreamInput({ files: sourceFiles, tasks: [task()] });
    const entryAlias = [...input.lines].find(
      ([, entry]) => entry.path === "workspaces/billing.md" && entry.text === LESSON,
    )![0];
    const otherAlias = [...input.lines].find(([, entry]) => entry.text === "A separate note")![0];
    const inboxAlias = [...input.lines].find(
      ([, entry]) => entry.inbox && entry.text === LESSON,
    )![0];
    const operations = [
      { op: "update", line: entryAlias, text: "Every migration is safe without tests" },
      { op: "merge", lines: [entryAlias, otherAlias], text: "Every migration is safe" },
      { op: "move", line: entryAlias, file: "me.md" },
      { op: "promote", line: inboxAlias, file: "lessons.md" },
    ];
    for (const operation of operations) {
      expect(classify(operation, input).classified[0]?.decision).toBe("rejected");
    }
    expect(classify({ op: "remove", line: entryAlias }, input).classified[0]?.decision).toBe(
      "review",
    );
  });

  it("rechecks execution provenance added after operation classification", () => {
    const sourceFiles = files();
    const original = `- ${LESSON} [by: agent; kind: insight]\n`;
    sourceFiles.set(
      "workspaces/billing.md",
      `${sourceFiles.get("workspaces/billing.md")}${original}`,
    );
    const input = buildDreamInput({ files: sourceFiles, tasks: [task()] });
    const alias = [...input.lines].find(([, entry]) => entry.text === LESSON)![0];
    const { classified } = classify(
      { op: "update", line: alias, text: "Every migration is safe without tests" },
      input,
    );
    expect(classified[0].decision).toBe("auto");
    sourceFiles.set(
      "workspaces/billing.md",
      sourceFiles
        .get("workspaces/billing.md")!
        .replace(original, original.replace("kind: insight", "kind: insight; learning: execution")),
    );

    const result = applyDreamOperations({
      files: sourceFiles,
      operations: classified,
      by: "agent",
      now: NOW,
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.files.size).toBe(0);
  });
});

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithGit = hasGit() ? describe : describe.skip;

describeWithGit("execution lesson review lifecycle", () => {
  let base: string;
  let service: MemoryRepoService;
  let valid: boolean;
  let validationError: boolean;
  let duringModelCall: () => void;
  let validate: ReturnType<typeof vi.fn<(refs: DreamExecutionEvidenceRef[]) => Promise<boolean>>>;

  const client: DreamModelClient = {
    async complete() {
      duringModelCall();
      return {
        text: JSON.stringify({ operations: [lesson()] }),
        inputTokens: 1_000,
        outputTokens: 150,
      };
    },
  };

  const dream = () =>
    new MemoryRepoDreamer({
      getService: () => service,
      client,
      listRecentTasks: async () => [task()],
      settings: () => ({ enabled: true, dailyTokenBudget: 50_000 }),
      now: () => NOW,
    }).run("manual");

  const workspaceText = async () => {
    const file = await service.workspaceFile("ws-billing");
    return file ? fs.readFileSync(path.join(service.root, file), "utf8") : "";
  };

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-execution-review-"));
    valid = true;
    validationError = false;
    duringModelCall = () => {};
    validate = vi.fn(async (_refs: DreamExecutionEvidenceRef[]) => {
      if (validationError) throw new Error("execution evidence unavailable");
      return valid;
    });
    service = new MemoryRepoService({
      root: path.join(base, "repo"),
      runtime: "desktop",
      now: () => NOW,
      validateExecutionEvidence: validate,
    });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("keeps a validated lesson out of active memory until approval and revalidates on acceptance", async () => {
    const outcome = await dream();
    if (!outcome.ran) throw new Error(`Dream did not run: ${outcome.reason}`);
    expect(outcome.record).toMatchObject({ autoCount: 0, reviewCount: 1, reviewStatus: "pending" });
    expect(await workspaceText()).not.toContain(LESSON);
    expect(await service.dreamDiff(outcome.record.id, "review")).toContain(OBSERVATION);
    expect(validate).toHaveBeenCalledWith([RECEIPT_REF]);
    const beforeAccept = validate.mock.calls.length;

    expect(await service.acceptDream(outcome.record.id)).toMatchObject({ accepted: true });
    expect(validate.mock.calls.length).toBeGreaterThan(beforeAccept);
    const written = await workspaceText();
    expect(written).toContain(LESSON);
    expect(written).toContain(OBSERVATION);
    expect(
      parseMemoryRepoEntries(written).find((entry) => entry.text.includes(LESSON))?.metadata,
    ).toMatchObject({
      learning: "execution",
      evidence: RECEIPT.contentHash,
      source: `cowork://tasks/${RECEIPT.taskId}`,
      event: RECEIPT.eventId,
    });
  });

  it("does not stage evidence that became invalid while the model was running", async () => {
    duringModelCall = () => {
      valid = false;
    };
    const outcome = await dream();
    if (!outcome.ran) throw new Error(`Dream did not run: ${outcome.reason}`);
    expect(outcome.record.reviewCount).toBe(0);
    expect(outcome.record.autoCount).toBe(0);
    expect(await workspaceText()).not.toContain(LESSON);
    expect(validate).toHaveBeenCalledWith([RECEIPT_REF]);
  });

  it("refuses approval when the destination workspace changed without a text merge conflict", async () => {
    await service.remember({
      text: "Keep the current invoice import format",
      kind: "project_fact",
      scope: "workspace",
      workspaceId: "ws-billing",
      workspaceName: "Billing",
      by: "user",
      origin: "memory_hub",
    });
    const file = await service.workspaceFile("ws-billing");
    if (!file) throw new Error("workspace file missing");
    const absolute = path.join(service.root, file);
    // Keep the owner marker far from the appended lesson, so a normal three-way merge
    // would accept both edits rather than detecting a textual conflict.
    fs.appendFileSync(
      absolute,
      Array.from({ length: 25 }, (_, index) => `- Existing note ${index} [by: user]\n`).join(""),
    );
    const outcome = await dream();
    if (!outcome.ran) throw new Error(`Dream did not run: ${outcome.reason}`);
    expect(outcome.record.reviewStatus).toBe("pending");
    fs.writeFileSync(
      absolute,
      fs.readFileSync(absolute, "utf8").replace("workspace: ws-billing", "workspace: ws-other"),
    );

    expect(await service.acceptDream(outcome.record.id)).toMatchObject({ accepted: false });
    expect((await service.getDream(outcome.record.id))?.reviewStatus).toBe("stale");
    expect(fs.readFileSync(absolute, "utf8")).not.toContain(LESSON);
  });

  it("refuses approval when a new workspace memory file was created after the review was staged", async () => {
    const outcome = await dream();
    if (!outcome.ran) throw new Error(`Dream did not run: ${outcome.reason}`);
    expect(outcome.record.reviewStatus).toBe("pending");
    await service.remember({
      text: "Keep the current invoice import format",
      kind: "project_fact",
      scope: "workspace",
      workspaceId: "ws-billing",
      workspaceName: "Billing",
      by: "user",
      origin: "memory_hub",
    });

    expect(await service.acceptDream(outcome.record.id)).toMatchObject({ accepted: false });
    expect((await service.getDream(outcome.record.id))?.reviewStatus).toBe("stale");
    expect(await workspaceText()).not.toContain(LESSON);
    expect(await workspaceText()).toContain("Keep the current invoice import format");
  });

  it.each(["invalid", "unavailable"])(
    "refuses acceptance after evidence becomes %s",
    async (state) => {
      const outcome = await dream();
      if (!outcome.ran) throw new Error(`Dream did not run: ${outcome.reason}`);
      expect(outcome.record.reviewStatus).toBe("pending");
      if (state === "invalid") valid = false;
      else validationError = true;

      expect(await service.acceptDream(outcome.record.id)).toMatchObject({ accepted: false });
      expect(await workspaceText()).not.toContain(LESSON);
    },
  );

  it("fails closed when no execution-evidence validator is configured", async () => {
    await service.stop();
    service = new MemoryRepoService({
      root: path.join(base, "without-validator"),
      runtime: "desktop",
      now: () => NOW,
    });
    await service.start();
    const outcome = await dream();
    if (!outcome.ran) throw new Error(`Dream did not run: ${outcome.reason}`);
    expect(outcome.record.reviewCount).toBe(0);
    expect(outcome.record.autoCount).toBe(0);
    expect(await workspaceText()).not.toContain(LESSON);
  });
});
