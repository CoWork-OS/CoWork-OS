/** Offline replay across the memory-folder lifecycle. Only model/task source adapters are scripted. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { Task, TaskEvent } from "../../../../shared/types";
import { MemoryRepoService } from "../../repo/MemoryRepoService";
import { MemoryRepoContext } from "../../repo/MemoryRepoContext";
import { MemoryRepoDreamer } from "../../repo/MemoryRepoDreamer";
import { createDreamTaskLister, isDreamCandidateTask } from "../../repo/memory-repo-dream-tasks";
import { createDreamExecutionEvidenceValidator } from "../../repo/memory-repo-dream-execution";
import { buildMemoryExecutionReceipt } from "../../repo/memory-repo-execution-receipt";
import { buildDreamInput } from "../../repo/memory-repo-dream-plan";
import { MemorySourceRecheckService, repoEntrySourceRef } from "../../MemorySourceRecheckService";
import { ensureMemorySourcesSchema, MEMORY_SOURCE_UNITS } from "../../memory-source-sql";
import { MemoryRecallService, defaultMemoryRecallDeps } from "../../MemoryRecall";
import { resolveMemoryInjection } from "../../MemoryInjectionPolicy";
import { runWithMemoryRepoAccess } from "../../../security/memory-repo-access";
import {
  gradeMemoryQuality,
  gradeSelectiveMemoryQuality,
  type QualityObservation,
  type SelectiveQualityPair,
} from "./memory-quality-metrics";

const Step = z
  .object({
    op: z.enum(["remember", "learn", "correct", "source-change", "source-correct", "lesson"]),
    text: z.string().min(8).max(260),
    workspace: z.enum(["atlas", "harbor"]).optional(),
    noMemory: z.boolean().optional(),
    kind: z.enum(["project_fact", "rule", "preference", "identity", "commitment"]).optional(),
    review: z.enum(["accept", "pending", "invalidate"]).optional(),
  })
  .strict();
export const QualityCorpus = z
  .object({
    version: z.literal(2),
    selectionThresholds: z
      .object({
        minMeanContextReduction: z.number().min(0).max(1),
        minInjectedRecallGain: z.number().min(0).max(1),
        maxIrrelevantContextHits: z.number().int().nonnegative(),
      })
      .strict(),
    thresholds: z
      .object({
        minSuccessRate: z.number().min(0).max(1),
        minSuccessGain: z.number().min(0).max(1),
        minRecallAt5: z.number().min(0).max(1),
        maxUnsupportedRate: z.number().min(0).max(1),
        maxStaleRate: z.number().min(0).max(1),
        maxExposures: z.number().int().nonnegative(),
        maxEstimatedMemoryTokens: z.number().int().positive(),
      })
      .strict(),
    cases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            category: z.string().min(1),
            history: z.array(Step).max(60),
            question: z.string().min(1),
            requiresRecall: z.boolean(),
            expectedCommand: z.string().min(1).nullable(),
            supportedCommands: z.array(z.string().min(1)),
            staleCommands: z.array(z.string().min(1)),
            mustNotExpose: z.array(z.string().min(1)),
            irrelevantContextMarkers: z.array(z.string().min(1)).default([]),
            requiredContextMarkers: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((corpus, ctx) => {
    if (new Set(corpus.cases.map((c) => c.id)).size !== corpus.cases.length)
      ctx.addIssue({ code: "custom", message: "Duplicate case ID" });
    for (const c of corpus.cases)
      if (
        c.expectedCommand &&
        (!c.supportedCommands.includes(c.expectedCommand) ||
          c.staleCommands.includes(c.expectedCommand))
      )
        ctx.addIssue({ code: "custom", message: `Invalid answer key for ${c.id}` });
  });
export type QualityCase = z.infer<typeof QualityCorpus>["cases"][number];
export interface QualityProbeRequest {
  question: string;
  context: string;
  recalled: string[];
}
export type QualityResponder = (request: QualityProbeRequest) => Promise<string | null>;

/** No answer key/history reaches this responder. It only selects backtick-delimited commands
 * from visible context, declining changed-source or unreviewed rows. This is a task proxy. */
export const commandSelectionProbe: QualityResponder = async ({ question, context, recalled }) => {
  const explicit = /`([^`]+)`/.exec(question)?.[1];
  if (explicit) return explicit;
  const terms = question.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  const rows = [...context.split("\n"), ...recalled].filter(
    (line) => !/source may have changed|\[unreviewed\]/i.test(line) && /`[^`]+`/.test(line),
  );
  rows.sort(
    (a, b) =>
      terms.filter((t) => b.toLowerCase().includes(t)).length -
      terms.filter((t) => a.toLowerCase().includes(t)).length,
  );
  return /`([^`]+)`/.exec(rows[0] ?? "")?.[1] ?? null;
};

const POLICY = { enabled: true, autoCapture: true, privacyMode: "normal" as const };
const NOW = Date.UTC(2026, 10, 7, 12);

export async function replayQualityCase(
  testCase: QualityCase,
  responder: QualityResponder = commandSelectionProbe,
): Promise<SelectiveQualityPair> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-memory-quality-"));
  const db = new Database(":memory:");
  let clock = NOW;
  const sources = new MemorySourceRecheckService({
    now: () => clock,
    run: async (name, args) => {
      const unit = MEMORY_SOURCE_UNITS[name as keyof typeof MEMORY_SOURCE_UNITS];
      return db.transaction(() => unit.run(db, unit.validate(args) as never))();
    },
  });
  let currentTask: Task | null = null;
  const events: TaskEvent[] = [];
  const taskSource = {
    findTaskById: async () => currentTask,
    findTasksCreatedBetween: async () => (currentTask ? [currentTask] : []),
    findTaskEvents: async () => [...events],
    getWorkspacePolicy: async () => POLICY,
    workspaceName: async () => "Atlas",
    now: () => clock,
  };
  const service = new MemoryRepoService({
    root: path.join(dir, "memory"),
    runtime: "desktop",
    now: () => clock,
    getWorkspacePolicy: async () => POLICY,
    ownerName: () => "Fixture owner",
    validateExecutionEvidence: createDreamExecutionEvidenceValidator({
      ...taskSource,
      isTaskEligible: isDreamCandidateTask,
    }),
  });
  let context: MemoryRepoContext | undefined;
  try {
    ensureMemorySourcesSchema(db);
    MemorySourceRecheckService.setDefault(sources);
    const status = await service.start();
    if (!status.gitAvailable || !status.writable)
      throw new Error("Benchmark requires writable temp Git repository");
    MemoryRepoService.setInstance(service);
    context = new MemoryRepoContext({ getService: () => service, getTeamRepos: () => [] });
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace);
    let remembered: { path: string; line: number; hash: string; text: string } | undefined;
    for (const [index, step] of testCase.history.entries()) {
      clock += 10_000;
      const workspaceId = step.workspace ?? "atlas";
      if (step.op === "remember") {
        const result = await service.remember({
          text: step.text,
          kind: step.kind ?? "project_fact",
          scope: "workspace",
          workspaceId,
          workspaceName: workspaceId,
          by: "user",
          origin: "memory_hub",
          noMemory: step.noMemory,
        });
        if (step.noMemory) {
          if (result.status !== "skipped") throw new Error("No-memory fixture was captured");
        } else {
          if (result.status !== "written")
            throw new Error(`Fixture write failed: ${JSON.stringify(result)}`);
          const entry = (await service.entries(result.path)).find((e) => e.line === result.line)!;
          remembered = { path: result.path, line: result.line, hash: entry.hash, text: entry.text };
        }
        continue;
      }
      if (step.op === "source-change") {
        if (!remembered) throw new Error("Source change needs an earlier memory");
        const file = path.join(workspace, "verification.md");
        await fs.writeFile(file, remembered.text);
        await sources.trackFile({
          workspaceId: "atlas",
          workspaceRoot: workspace,
          file: "verification.md",
          memoryRef: repoEntrySourceRef(remembered.path, remembered.hash),
        });
        await fs.writeFile(file, step.text);
        clock++;
        if (
          !(await sources.onFileChanged({
            workspaceId: "atlas",
            relPath: "verification.md",
            absolutePath: file,
          }))
        )
          throw new Error("Source change not detected");
        continue;
      }
      currentTask = {
        id: `history-${index}`,
        workspaceId: "atlas",
        title: "Atlas upgrade migrations",
        prompt: step.text,
        createdAt: clock - 2000,
        updatedAt: clock - 1000,
        status: "completed",
        terminalStatus: "ok",
        verificationVerdict: "PASS",
      } as Task;
      events.length = 0;
      const receipt =
        step.op === "lesson"
          ? buildMemoryExecutionReceipt({
              status: "completed",
              terminalStatus: "ok",
              verificationVerdict: "PASS",
              evidenceBundle: {
                entries: [
                  {
                    kind: "shell_command",
                    ok: true,
                    detail: "Verification passed: npm run verify:upgrade",
                    capturedAt: clock - 1500,
                  },
                ],
              },
            })
          : undefined;
      events.push({
        id: `completion-${index}`,
        taskId: currentTask.id,
        type: "task_completed",
        timestamp: clock - 1000,
        payload: {
          terminalStatus: "ok",
          verificationVerdict: "PASS",
          ...(receipt ? { memoryExecutionReceipt: receipt } : {}),
        },
      } as TaskEvent);
      const tasks = await createDreamTaskLister(taskSource)(0, 20);
      const rechecks = await sources.pendingForDream(10);
      const input = buildDreamInput({
        files: await service.readAllFiles(),
        tasks,
        rechecks,
        now: clock,
      });
      let operation: unknown;
      if (step.op === "learn")
        operation = {
          op: "add",
          file: "workspaces/atlas.md",
          text: step.text,
          kind: step.kind ?? "project_fact",
          evidence: [{ task: "T1", quote: step.text }],
        };
      else if (step.op === "lesson") {
        const check = input.executionEvidence?.get("E1");
        if (!check) throw new Error("Runtime receipt did not reach dreaming");
        operation = {
          op: "add_lesson",
          text: step.text,
          evidence: [{ outcome: "E1", quote: check.excerpt }],
        };
      } else {
        const line = [...input.lines.values()].find((line) => line.hash === remembered?.hash);
        if (!line) throw new Error("Correction fixture target missing");
        operation = { op: "update", line: line.alias, text: step.text };
        if (step.op === "source-correct" && !input.recheckSources.size)
          throw new Error("Source evidence missing from dream input");
      }
      const dreamer = new MemoryRepoDreamer({
        getService: () => service,
        listRecentTasks: async () => tasks,
        now: () => clock,
        settings: () => ({ enabled: true, dailyTokenBudget: 50000 }),
        sourceRechecks: {
          pending: (limit) => sources.pendingForDream(limit),
          reviewed: (rows) => sources.markReviewed(rows),
          forget: (rows) => sources.forget(rows),
        },
        client: {
          complete: async (request) => {
            // Model boundary is scripted. Production generation, validation and application run unchanged.
            const text = JSON.stringify({
              summary: "Synthetic history replay",
              operations: [operation],
            });
            return {
              text,
              inputTokens: Math.ceil((request.user.length + request.system.length) / 4),
              outputTokens: Math.ceil(text.length / 4),
            };
          },
        },
      });
      const result = await dreamer.run("manual");
      if (!result.ran || result.record.rejected || result.record.skipped)
        throw new Error(`Replay dream failed: ${JSON.stringify(result)}`);
      if (result.record.reviewStatus === "pending" && step.review !== "pending") {
        if (step.review === "invalidate")
          events.push({
            id: `correction-${index}`,
            taskId: currentTask.id,
            type: "user_message",
            timestamp: clock,
            payload: {
              message: "That verification did not validate the upgrade. Do not retain the lesson.",
            },
          } as TaskEvent);
        const accepted = await service.acceptDream(result.record.id);
        if (accepted.accepted !== (step.review !== "invalidate"))
          throw new Error(`Unexpected review result: ${JSON.stringify(accepted)}`);
      }
    }
    const observe = async (enabled: boolean, selective = true): Promise<QualityObservation> => {
      const policy = resolveMemoryInjection({
        retainMemory: enabled,
        memoryRepoEnabled: enabled,
        workspaceSettings: { enabled },
        gatewayContext: "private",
      });
      const block = policy.layers.memoryRepo
        ? await context!.build({
            workspaceId: "atlas",
            ...(selective ? { query: testCase.question } : {}),
          })
        : null;
      const recall = new MemoryRecallService({
        ...defaultMemoryRecallDeps(),
        laneEnabled: (lane) => lane === "repo",
      });
      const found = await runWithMemoryRepoAccess({ readAllowed: policy.layers.memoryRepo }, () =>
        recall.recall({
          text: testCase.question,
          workspaceId: "atlas",
          lanes: ["repo"],
          surface: "tool",
          detail: "full",
          limit: 5,
        }),
      );
      if (Object.keys(found.laneErrors).length)
        throw new Error(`Recall failed: ${JSON.stringify(found.laneErrors)}`);
      const request = {
        question: testCase.question,
        context: block?.text ?? "",
        recalled: found.hits.map((hit) => hit.content ?? hit.snippet ?? ""),
      };
      // A custom responder may keep or mutate its input; grading must retain the
      // exact evidence that the pipeline supplied, rather than the responder's edits.
      const command = await responder({ ...request, recalled: [...request.recalled] });
      if (command !== null && typeof command !== "string")
        throw new Error("Probe returned invalid command");
      return {
        command,
        context: request.context,
        recalled: request.recalled,
        estimatedMemoryTokens: Math.ceil(
          [request.context, ...request.recalled].join("\n").trim().length / 4,
        ),
      };
    };
    // Both arms see precisely the same retained history and public question. The policy
    // and actual tool access scope, rather than an answer-key conditional, disable memory.
    return {
      id: testCase.id,
      category: testCase.category,
      expectation: {
        requiresRecall: testCase.requiresRecall,
        expectedCommand: testCase.expectedCommand,
        supportedCommands: testCase.supportedCommands,
        staleCommands: testCase.staleCommands,
        mustNotExpose: testCase.mustNotExpose,
        irrelevantContextMarkers: testCase.irrelevantContextMarkers,
        requiredContextMarkers: testCase.requiredContextMarkers,
      },
      enabled: await observe(true),
      disabled: await observe(false),
      baseline: await observe(true, false),
    };
  } finally {
    context?.dispose();
    MemoryRepoService.setInstance(null);
    MemorySourceRecheckService.setDefault(null);
    await service.stop();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function runMemoryQualityBenchmark(
  raw: unknown,
  responder: QualityResponder = commandSelectionProbe,
) {
  const corpus = QualityCorpus.parse(raw);
  const pairs: SelectiveQualityPair[] = [];
  for (const testCase of corpus.cases) pairs.push(await replayQualityCase(testCase, responder));
  const quality = gradeMemoryQuality(pairs, corpus.thresholds);
  const selection = gradeSelectiveMemoryQuality(pairs, corpus.selectionThresholds);
  return {
    version: 2,
    responder:
      responder === commandSelectionProbe ? "deterministic-command-selection-v1" : "custom-probe",
    ...quality,
    passed: quality.passed && selection.passed,
    failures: [...quality.failures, ...selection.failures],
    selection,
    selectionThresholds: corpus.selectionThresholds,
    thresholds: corpus.thresholds,
    pairs,
  };
}
