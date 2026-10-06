import {
  memoryRepoSettingsProblem,
  memoryRepoStatus,
} from "../../electron/memory/repo/memory-repo-bootstrap";
import { MemoryRepoService } from "../../electron/memory/repo/MemoryRepoService";
import { readMemoryRepoLines } from "../../electron/memory/repo/memory-repo-read";
import { promoteObservationToMemoryFolder } from "../../electron/memory/repo/memory-repo-producers";
import {
  keepMemoryRepoEntry,
  listMemoryRepoEntries,
  pinMemoryRepoEntry,
  removeMemoryRepoEntry,
  updateMemoryRepoEntry,
} from "../../electron/memory/repo/memory-repo-hub";
import {
  MemoryRepoDreamIdSchema,
  MemoryRepoDreamPartSchema,
  MemoryRepoEntriesRequestSchema,
  MemoryRepoEntryRequestSchema,
  MemoryRepoKeepEntryRequestSchema,
  MemoryRepoRefsSchema,
  MemoryRepoUpdateEntryRequestSchema,
} from "../../electron/ipc/memory-repo-ipc-validation";
import { getMemoryRepoDreamer } from "../../electron/memory/repo/MemoryRepoDreamer";
import {
  buildMemoryRepoDreamsReport,
  loadMemoryRepoDreamSettings,
  memoryRepoDreamDiffText,
  runMemoryRepoDreamAction,
  toMemoryRepoDreamNowResult,
} from "../../electron/memory/repo/memory-repo-dream-report";
import {
  MEMORY_REPO_SYNC_FOLDER_OFF_ERROR,
  MEMORY_REPO_SYNC_OFF_ERROR,
  type MemoryRepoCompactResult,
  type MemoryRepoSyncNowResult,
} from "../../shared/memory-repo-types";
import path from "node:path";
import { statSync, existsSync } from "node:fs";
import {
  computeWorkspaceKitStatus,
  readWorkspaceKitState,
  ensureBootstrapLifecycleState,
} from "../../electron/context/kit-status";
import {
  createKitProject,
  templatesForInit,
  ensureDir,
  writeTemplate,
  ensureDefaultKitCronJobs,
} from "../../electron/context/kit-operations";
import {
  canonicalizeAccessPath,
  isAccessPathWithin,
} from "../../electron/security/access-profile-paths";
import { z } from "zod";
import { CuratedMemoryService } from "../../electron/memory/CuratedMemoryService";
import { MemorySynthesizer } from "../../electron/memory/MemorySynthesizer";
import { evaluateWorkspaceFilesystemAccess } from "../../electron/security/access-profile-paths";
import { MemoryWriteGate } from "../../electron/memory/MemoryWriteGate";
import { MemoryService } from "../../electron/memory/MemoryService";
import { MemoryWorkspacePurgeService } from "../../electron/memory/MemoryWorkspacePurgeService";
import { MemoryObservationService } from "../../electron/memory/MemoryObservationService";
import { RelationshipMemoryService } from "../../electron/memory/RelationshipMemoryService";
import { MemoryFeaturesManager } from "../../electron/settings/memory-features-manager";
import { ChronicleObservationRepository } from "../../electron/chronicle/ChronicleObservationRepository";
import type { MemoryFeaturesSettings, Workspace } from "../../shared/types";
import type { BrowserDesktopDefinition, BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { WebApplicationError } from "../web/WebApplication";
import { MemoryHubError, MemoryItemsHubService } from "../../electron/memory/MemoryItemsHubService";
import { MemoryWriter } from "../../electron/memory/MemoryWriter";
import type Database from "better-sqlite3";
import {
  MemoryReviewError,
  type MemoryReviewService,
} from "../../electron/memory/MemoryReviewService";
import {
  createMemoryHealthService,
  createMemoryReviewService,
} from "../../electron/memory/memory-review-wiring";
import type { MemoryHealthService } from "../../electron/memory/MemoryHealthService";
import { MemoryHubWorkspaceRequestSchema } from "../../electron/ipc/memory-health-ipc-validation";
import {
  MemoryReviewUndoRequestSchema,
  MemoryReviewWorkspaceRequestSchema,
} from "../../electron/ipc/memory-review-ipc-validation";
import {
  MemoryItemAddRequestSchema,
  MemoryItemPinRequestSchema,
  MemoryItemRefRequestSchema,
  MemoryItemsClearGlobalRequestSchema,
  MemoryItemsListRequestSchema,
  MemoryItemUpdateRequestSchema,
  MemoryUsedForTaskRequestSchema,
} from "../../electron/ipc/memory-ipc-validation";
import { attributeMemoryUse, type MemoryUsedTimelineEvent } from "../../shared/memory-used";

const id = z.string().trim().min(1).max(200);
const scope = z.object({ workspaceId: id });
const page = scope.extend({ limit: z.number().int().min(1).max(200).optional() }).strict();
const ids = z.array(id).max(100);
const confidence = z.number().finite().min(0).max(1);
const settingsPatch = z
  .object({
    enabled: z.boolean().optional(),
    autoCapture: z.boolean().optional(),
    compressionEnabled: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    maxStorageMb: z.number().int().min(10).max(5000).optional(),
    privacyMode: z.enum(["normal", "strict", "disabled"]).optional(),
    excludedPatterns: z.array(z.string().max(500)).max(100).optional(),
  })
  .strict();
const featureBooleanKeys = [
  "contextPackInjectionEnabled",
  "heartbeatMaintenanceEnabled",
  "checkpointCaptureEnabled",
  "wakeUpLayersEnabled",
  "temporalKnowledgeEnabled",
  "transcriptStoreEnabled",
  "durableContextEnabled",
  "queryOrchestratorEnabled",
  "curatedMemoryEnabled",
  "sessionRecallEnabled",
  "defaultArchiveInjectionEnabled",
  "autoPromoteToCuratedMemoryEnabled",
  "structuredObservationsEnabled",
  "memoryInspectorEnabled",
  "memoryRepoEnabled",
  "memoryRepoDreamingEnabled",
] as const;
const featureSettings = z
  .object({
    ...Object.fromEntries(featureBooleanKeys.map((key) => [key, z.boolean().optional()])),
    durableContextMode: z.enum(["off", "experimental", "on"]).optional(),
    durableContextLargePayloadThreshold: z.number().int().min(1).max(1_000_000).optional(),
    memoryCompressionDailyTokenBudget: z.number().int().min(1).max(1_000_000).optional(),
    memoryRepoPath: z.string().trim().max(1024).optional(),
    memoryRepoRemoteUrl: z.string().trim().max(500).optional(),
    memoryRepoRemoteConfirmedPrivate: z.boolean().optional(),
    memoryRepoTeamRepos: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(60),
            path: z.string().trim().min(1).max(1024),
            workspaceIds: z.array(z.string().max(128)).max(200).optional(),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    memoryRepoDreamDailyTokenBudget: z.number().int().min(1).max(1_000_000).optional(),
    memoryWriteApprovalMode: z
      .enum(["off", "curated_only", "external_only", "background_only", "all"])
      .optional(),
  })
  .strict();
const observationScope = scope.extend({ memoryId: id }).strict();
const observationStrings = z.array(z.string().trim().min(1).max(240)).max(12);
const observationPatch = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    subtitle: z.string().trim().max(200).optional(),
    narrative: z.string().trim().min(1).max(2000).optional(),
    facts: observationStrings.optional(),
    concepts: observationStrings.optional(),
    filesRead: observationStrings.optional(),
    filesModified: observationStrings.optional(),
    tools: observationStrings.optional(),
    sourceEventIds: observationStrings.optional(),
    privacyState: z.enum(["normal", "private", "redacted", "suppressed"]).optional(),
  })
  .strict();

export function createBrowserMemoryDefinitions(options: {
  resolveWorkspace: (workspaceId: string) => Promise<Workspace | null>;
  getRecentTask?: (
    workspaceId: string,
  ) => Promise<{ prompt?: string; assignedAgentRoleId?: string } | null>;
  getTask?: (
    taskId: string,
  ) => Promise<{ id: string; title?: string | null; workspaceId?: string | null } | null>;
  /** Memory Hub service override (tests). */
  memoryItems?: MemoryItemsHubService;
  /** Profile database, for the Memory Hub Review tab (Dreaming proposals and undo). */
  db?: Database.Database;
  /** Memory Hub Review service override (tests). */
  memoryReview?: MemoryReviewService;
  /** Memory Hub Sources and Health service override (tests). */
  memoryHealth?: Pick<MemoryHealthService, "sources" | "health">;
  /**
   * The task's `memory_used`, reply and user-message events (oldest first), or null when
   * the task is not in the workspace. Same contract as the desktop IPC
   * (`memoryItems:usedForTask`, memory-items-handlers.ts).
   */
  loadMemoryUsedTimeline?: (
    workspaceId: string,
    taskId: string,
  ) => Promise<MemoryUsedTimelineEvent[] | null>;
}): BrowserDesktopDefinitions {
  const requireWorkspace = async (
    workspaceId: string,
    permission: "read" | "write" | "delete" = "read",
  ) => {
    const workspace = await options.resolveWorkspace(workspaceId);
    if (!workspace?.permissions.read || !workspace.permissions[permission]) {
      throw new WebApplicationError("FORBIDDEN", "Workspace memory access is unavailable.", 403);
    }
    return workspace;
  };
  const action = <S extends z.ZodType>(
    schema: S,
    handler: (value: z.infer<S>) => unknown,
    mutation = false,
  ): BrowserDesktopDefinition => ({
    capability: "memory.manage",
    mutation,
    minArgs: 1,
    maxArgs: 1,
    validate: (args) => [schema.parse(args[0])],
    handler: ([value]) => handler(value as z.infer<S>),
  });
  const workspaceAction = <S extends z.ZodType<{ workspaceId: string }>>(
    schema: S,
    permission: "read" | "write" | "delete",
    handler: (value: z.infer<S>, workspace: Workspace) => unknown,
  ): BrowserDesktopDefinition =>
    action(
      schema,
      async (value) => {
        const workspace = await requireWorkspace(value.workspaceId, permission);
        return handler(value, workspace);
      },
      permission !== "read",
    );
  const workspaceIdAction = (
    permission: "read" | "write" | "delete",
    handler: (workspaceId: string) => unknown,
  ) =>
    action(
      id,
      async (workspaceId) => {
        await requireWorkspace(workspaceId, permission);
        return handler(workspaceId);
      },
      permission !== "read",
    );
  const noArgs = (handler: () => unknown, mutation = false): BrowserDesktopDefinition => ({
    capability: "memory.manage",
    mutation,
    minArgs: 0,
    maxArgs: 0,
    handler,
  });

  const kitGuard =
    (workspace: Workspace, trustedTemplateSeed = false) =>
    (candidatePath: string, operation: "read" | "write") => {
      if (!workspace.path || !path.isAbsolute(workspace.path))
        throw new WebApplicationError(
          "HOST_UNAVAILABLE",
          "Workspace kit path is unavailable.",
          503,
        );
      const evaluation = evaluateWorkspaceFilesystemAccess(workspace, candidatePath, operation);
      const relative = path
        .relative(canonicalizeAccessPath(workspace.path), canonicalizeAccessPath(candidatePath))
        .replaceAll("\\", "/");
      const policyTemplate =
        /^\.cowork\/policy(?:$|\/(?:README\.md|tools\.monty)(?:$)|\/\.history(?:$|\/(?:README\.md|tools\.monty)(?:$|\/)))/.test(
          relative,
        );
      const ownerSeedAllowed =
        trustedTemplateSeed &&
        operation === "write" &&
        evaluation.reason === "protected_path" &&
        policyTemplate &&
        evaluateWorkspaceFilesystemAccess(
          {
            ...workspace,
            permissions: {
              ...workspace.permissions,
              read: workspace.permissions.write,
              accessFilesystemRules: workspace.permissions.accessFilesystemRules?.map((rule) => ({
                ...rule,
                access: rule.access === "read" ? "deny" : rule.access === "write" ? "read" : "deny",
              })),
            },
          },
          candidatePath,
          "read",
        ).decision === "allow";
      if (
        !isAccessPathWithin(
          canonicalizeAccessPath(workspace.path),
          canonicalizeAccessPath(candidatePath),
        ) ||
        (evaluation.decision !== "allow" && !ownerSeedAllowed)
      ) {
        throw new WebApplicationError(
          "FORBIDDEN",
          "Workspace kit file access is unavailable.",
          403,
        );
      }
      try {
        const stat = statSync(candidatePath);
        if (stat.isFile() && stat.size > 2 * 1024 * 1024) {
          throw new WebApplicationError(
            "INVALID_REQUEST",
            "Workspace kit file exceeds the 2 MiB limit.",
            413,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };

  // Memory Hub "What CoWork knows": same service and schemas as the desktop IPC.
  const memoryItems =
    options.memoryItems ??
    new MemoryItemsHubService({
      getWriter: () => MemoryWriter.get(),
      getTask: async (taskId) => (await options.getTask?.(taskId)) ?? undefined,
      getWorkspaceName: async (workspaceId) =>
        (await options.resolveWorkspace(workspaceId))?.name ?? null,
    });
  // Memory Hub "Review": same service and schemas as the desktop IPC (memoryReview:*).
  const memoryReview =
    options.memoryReview ?? (options.db ? createMemoryReviewService(options.db) : null);
  // Memory Hub "Sources" and "Health": same service and schema as the desktop IPC
  // (memoryHub:*). Health is profile-wide aggregate counts; the workspace gates access.
  const memoryHealth =
    options.memoryHealth ?? (options.db ? createMemoryHealthService(options.db) : null);
  const healthCall = async <T>(
    run: (service: Pick<MemoryHealthService, "sources" | "health">) => Promise<T>,
  ): Promise<T> => {
    if (!memoryHealth) {
      throw new WebApplicationError("HOST_UNAVAILABLE", "Memory health is unavailable.", 503);
    }
    return run(memoryHealth);
  };
  const reviewCall = async <T>(
    run: (service: MemoryReviewService) => Promise<T> | T,
  ): Promise<T> => {
    if (!memoryReview) {
      throw new WebApplicationError("HOST_UNAVAILABLE", "Memory review is unavailable.", 503);
    }
    try {
      return await run(memoryReview);
    } catch (error) {
      if (error instanceof MemoryReviewError) {
        throw new WebApplicationError(
          error.code === "not_found" ? "NOT_FOUND" : "HOST_UNAVAILABLE",
          error.message,
          error.code === "not_found" ? 404 : 503,
        );
      }
      throw error;
    }
  };
  const hubCall = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof MemoryHubError) {
        throw new WebApplicationError(
          error.code === "not_found" ? "NOT_FOUND" : "HOST_UNAVAILABLE",
          error.message,
          error.code === "not_found" ? 404 : 503,
        );
      }
      throw error;
    }
  };

  const requirePending = async (pendingId: string, workspaceId?: string, mutate = false) => {
    const pending = await MemoryWriteGate.findPending(pendingId);
    if (!pending || (workspaceId && pending.workspaceId !== workspaceId)) {
      throw new WebApplicationError("NOT_FOUND", "Memory write approval is unavailable.", 404);
    }
    const workspace = await requireWorkspace(pending.workspaceId, mutate ? "write" : "read");
    return { pending, workspace };
  };

  return {
    listMemoryWriteApprovals: workspaceAction(page, "read", (value) =>
      MemoryWriteGate.listPendingForDisplay(value.workspaceId, value.limit ?? 100),
    ),
    getMemoryWriteApproval: action(id, async (pendingId) => {
      await requirePending(pendingId);
      return (await MemoryWriteGate.findPendingForDisplay(pendingId)) ?? null;
    }),
    getMemoryWriteApprovalCount: workspaceIdAction("read", async (workspaceId) => ({
      pending: await MemoryWriteGate.pendingCount(workspaceId),
    })),
    approveMemoryWriteApproval: action(
      scope.extend({ id }).strict(),
      async (value) => {
        const { pending, workspace } = await requirePending(value.id, value.workspaceId, true);
        if (pending.action === "remove" || pending.payload.action === "remove") {
          await requireWorkspace(pending.workspaceId, "delete");
        }
        if (
          pending.target === "external" &&
          (workspace.permissions.network !== true ||
            workspace.permissions.accessProfileUnavailable === true ||
            workspace.permissions.accessNetworkMode === "disabled" ||
            workspace.permissions.accessNetworkMode === "on-request")
        ) {
          throw new WebApplicationError(
            "FORBIDDEN",
            "Workspace automatic network access is unavailable.",
            403,
          );
        }
        return MemoryWriteGate.applyPending(value.id, {
          workspaceId: pending.workspaceId,
          reviewedBy: "user",
          effectiveWorkspace: workspace,
        });
      },
      true,
    ),
    rejectMemoryWriteApproval: action(
      scope.extend({ id, reason: z.string().trim().max(2000).optional() }).strict(),
      async (value) => {
        const { pending } = await requirePending(value.id, value.workspaceId, true);
        return MemoryWriteGate.rejectForDisplay(value.id, {
          workspaceId: pending.workspaceId,
          reviewedBy: "user",
          resolution: value.reason,
        });
      },
      true,
    ),
    getWorkspaceKitStatus: workspaceIdAction("read", async (workspaceId) => {
      const workspace = await requireWorkspace(workspaceId);
      return computeWorkspaceKitStatus(workspace.path, workspaceId, {
        readOnly: true,
        pathGuard: kitGuard(workspace),
      });
    }),
    initWorkspaceKit: workspaceAction(
      scope
        .extend({
          mode: z.enum(["missing", "overwrite"]).optional(),
          templatePreset: z.enum(["default", "venture_operator"]).optional(),
        })
        .strict(),
      "write",
      async (value, workspace) => {
        const guard = kitGuard(workspace, true);
        guard(path.join(workspace.path, ".cowork", "workspace-state.json"), "read");
        const state = await readWorkspaceKitState(workspace.path);
        for (const dir of [
          "memory",
          "memory/hourly",
          "memory/weekly",
          "projects",
          "agents",
          "uploads",
          "transforms",
          "router",
          "policy",
          "feedback",
        ]) {
          await ensureDir(workspace.path, path.join(".cowork", dir), guard);
        }
        const mode = value.mode ?? "missing";
        for (const template of templatesForInit(new Date(), value.templatePreset)) {
          guard(path.join(workspace.path, template.relPath), "read");
          if (
            template.relPath === path.join(".cowork", "BOOTSTRAP.md") &&
            mode === "missing" &&
            state.onboardingCompletedAt &&
            !existsSync(path.join(workspace.path, template.relPath))
          )
            continue;
          await writeTemplate(workspace.path, template.relPath, template.content, mode, guard);
        }
        await ensureBootstrapLifecycleState(workspace.path, state, guard);
        await MemoryService.syncWorkspaceMarkdown(
          workspace.id,
          path.join(workspace.path, ".cowork"),
          true,
          (candidatePath) => {
            try {
              guard(candidatePath, "read");
              return true;
            } catch {
              return false;
            }
          },
        );
        await ensureDefaultKitCronJobs(workspace.id, mode, true);
        return computeWorkspaceKitStatus(workspace.path, workspace.id, {
          readOnly: true,
          pathGuard: guard,
        });
      },
    ),
    createWorkspaceKitProject: workspaceAction(
      scope
        .extend({
          projectId: z
            .string()
            .trim()
            .regex(/^[a-zA-Z0-9._-]{1,80}$/)
            .refine((value) => !value.includes("..") && value !== "."),
        })
        .strict(),
      "write",
      async (value, workspace) => {
        return createKitProject(workspace.path, value.projectId, kitGuard(workspace));
      },
    ),
    getMemoryLayerPreview: workspaceIdAction("read", async (workspaceId) => {
      const workspace = await requireWorkspace(workspaceId);
      const task = await options.getRecentTask?.(workspaceId);
      const prompt = task?.prompt?.trim() || "Current workspace memory preview";
      return MemorySynthesizer.buildLayerPreview(workspaceId, workspace.path, prompt, {
        includeWorkspaceKit: true,
        workspaceCanRead: workspace.permissions?.read !== false,
        agentRoleId: task?.assignedAgentRoleId || null,
        filesystemReadGuard: (candidatePath) =>
          evaluateWorkspaceFilesystemAccess(workspace, candidatePath, "read").decision === "allow",
        boxBrainHits: await MemorySynthesizer.prefetchBoxBrainHits(workspaceId, prompt),
      });
    }),
    promoteMemoryObservation: workspaceAction(
      observationScope
        .extend({
          target: z.enum(["user", "workspace"]).optional(),
          kind: z
            .enum([
              "identity",
              "preference",
              "constraint",
              "workflow_rule",
              "project_fact",
              "active_commitment",
            ])
            .optional(),
        })
        .strict(),
      "write",
      async (value, workspace) => {
        const detail = (await MemoryObservationService.details([value.memoryId], workspace.id))[0];
        if (!detail || detail.workspaceId !== workspace.id) {
          throw new WebApplicationError("NOT_FOUND", "Memory observation is unavailable.", 404);
        }
        // An explicit user act: the user's line in the memory folder (same as the desktop
        // IPC); commitments and a folder that is off keep the curated path.
        const promoted = await promoteObservationToMemoryFolder({
          workspaceId: detail.workspaceId,
          workspaceName: workspace.name,
          taskId: detail.taskId,
          target: value.target ?? "workspace",
          kind: value.kind ?? "project_fact",
          content: detail.title || detail.narrative,
        });
        if (promoted) {
          if (!promoted.success) {
            throw new WebApplicationError(
              "CONFLICT",
              promoted.error || "Memory promotion could not be applied.",
              409,
            );
          }
          return promoted;
        }
        const result = await CuratedMemoryService.curate({
          workspaceId: detail.workspaceId,
          taskId: detail.taskId,
          action: "add",
          target: value.target ?? "workspace",
          kind: value.kind ?? "project_fact",
          content: detail.title || detail.narrative,
          reason: "Promoted from Memory Hub Inspector",
        });
        if (!result.success) {
          throw new WebApplicationError(
            "CONFLICT",
            result.error || "Memory promotion could not be applied.",
            409,
          );
        }
        return result;
      },
    ),
    getMemorySettings: workspaceIdAction("read", (workspaceId) =>
      MemoryService.getSettings(workspaceId),
    ),
    getMemoryStats: workspaceIdAction("read", (workspaceId) => MemoryService.getStats(workspaceId)),
    getImportedMemoryStats: workspaceIdAction("read", (workspaceId) =>
      MemoryService.getImportedStats(workspaceId),
    ),
    saveMemorySettings: workspaceAction(
      scope.extend({ settings: settingsPatch }).strict(),
      "write",
      async (value) => {
        await MemoryService.updateSettings(value.workspaceId, value.settings);
        return { success: true };
      },
    ),
    getRecentMemories: workspaceAction(page, "read", (value) =>
      MemoryService.getRecent(value.workspaceId, value.limit ?? 20),
    ),
    searchMemories: workspaceAction(
      page.extend({ query: z.string().trim().min(1).max(4000) }).strict(),
      "read",
      (value) => MemoryService.searchAsync(value.workspaceId, value.query, value.limit ?? 30),
    ),
    // Accepts the desktop shape `{ workspaceId, ids }` (SEC-11) and the older bare id list.
    getMemoryDetails: action(
      z.union([ids, z.object({ workspaceId: id, ids }).strict()]),
      async (value) => {
        const scope = Array.isArray(value) ? undefined : value.workspaceId;
        const details = await MemoryService.getFullDetails(Array.isArray(value) ? value : value.ids);
        const visible = scope
          ? details.filter((memory) => memory.workspaceId === scope)
          : details;
        for (const workspaceId of new Set(visible.map((memory) => memory.workspaceId)))
          await requireWorkspace(workspaceId);
        return visible;
      },
    ),
    getMemoryTimeline: action(
      z
        .object({
          workspaceId: id.optional(),
          memoryId: id,
          windowSize: z.number().int().min(1).max(50).optional(),
        })
        .strict(),
      async (value) => {
        const [memory] = await MemoryService.getFullDetails([value.memoryId]);
        if (!memory) return [];
        if (value.workspaceId && memory.workspaceId !== value.workspaceId) return [];
        await requireWorkspace(memory.workspaceId);
        return MemoryService.getTimelineContext(value.memoryId, value.windowSize);
      },
    ),
    findImportedMemories: workspaceAction(
      page.extend({ offset: z.number().int().min(0).max(1_000_000).optional() }).strict(),
      "read",
      (value) =>
        MemoryService.findImported(value.workspaceId, value.limit ?? 50, value.offset ?? 0),
    ),
    deleteImportedMemories: workspaceIdAction("delete", async (workspaceId) => ({
      success: true,
      deleted: await MemoryService.deleteImported(workspaceId),
    })),
    deleteImportedMemoryEntry: workspaceAction(observationScope, "delete", async (value) => ({
      success: await MemoryService.deleteImportedEntry(value.workspaceId, value.memoryId),
    })),
    setImportedMemoryPromptRecallIgnored: workspaceAction(
      observationScope.extend({ ignored: z.boolean() }).strict(),
      "write",
      async (value) => {
        const memory = await MemoryService.setImportedPromptRecallIgnored(
          value.workspaceId,
          value.memoryId,
          value.ignored,
        );
        return { success: Boolean(memory), memory };
      },
    ),
    clearMemory: workspaceIdAction("delete", async (workspaceId) => {
      const workspace = await requireWorkspace(workspaceId, "delete");
      // Same purge as the desktop IPC path: every memory store, with per-store counts.
      return MemoryWorkspacePurgeService.purgeWorkspace({ id: workspaceId, path: workspace.path });
    }),
    importMemoryFromText: workspaceAction(
      scope
        .extend({
          provider: z.string().trim().min(1).max(80),
          pastedText: z.string().trim().min(1).max(1_000_000),
          forcePrivate: z.boolean().optional(),
        })
        .strict(),
      "write",
      (value) => MemoryService.importFromText(value),
    ),
    listChronicleObservations: workspaceAction(page, "read", async (value, workspace) => {
      const observations = await ChronicleObservationRepository.list(
        workspace.path,
        value.limit ?? 50,
      );
      return observations.map(
        ({
          id,
          appName,
          windowTitle,
          localTextSnippet,
          capturedAt,
          destinationHints,
          memoryId,
        }) => ({
          id,
          appName,
          windowTitle,
          localTextSnippet,
          capturedAt,
          destinationHints,
          memoryId,
        }),
      );
    }),
    listRelationshipMemory: {
      ...action(
        z
          .object({
            layer: z
              .enum(["identity", "preferences", "context", "commitments"])
              .optional(),
            includeDone: z.boolean().optional(),
            limit: z.number().int().min(1).max(200).optional(),
          })
          .strict()
          .optional(),
        (value) => RelationshipMemoryService.listItems(value ?? { limit: 80 }),
      ),
      minArgs: 0,
    },
    updateRelationshipMemory: action(
      z
        .object({
          id,
          text: z.string().trim().min(1).max(4000).optional(),
          confidence: confidence.optional(),
          status: z.enum(["open", "done"]).optional(),
          dueAt: z.number().int().min(0).nullable().optional(),
        })
        .strict(),
      ({ id, ...patch }) => RelationshipMemoryService.updateItem(id, patch),
      true,
    ),
    deleteRelationshipMemory: action(
      id,
      async (itemId) => ({ success: await RelationshipMemoryService.deleteItem(itemId) }),
      true,
    ),
    getDueSoonCommitments: {
      ...action(z.number().finite().min(1).max(8760).optional(), (windowHours) => {
        const items = RelationshipMemoryService.listDueSoonCommitments(windowHours ?? 72);
        return {
          items,
          reminderText: items.length
            ? `You have ${items.length} commitment(s) due soon.`
            : "No commitments due soon.",
        };
      }),
      minArgs: 0,
    },
    getMemoryFeaturesSettings: noArgs(() => MemoryFeaturesManager.loadSettings()),
    saveMemoryFeaturesSettings: action(
      featureSettings,
      async (value) => {
        const repoPathProblem = await memoryRepoSettingsProblem(value);
        if (repoPathProblem) throw new Error(repoPathProblem);
        MemoryFeaturesManager.saveSettings({
          ...MemoryFeaturesManager.loadSettings(),
          ...value,
        } as MemoryFeaturesSettings);
        return { success: true };
      },
      true,
    ),
    searchMemoryObservations: workspaceAction(
      page
        .extend({
          query: z.string().max(4000).optional(),
          offset: z.number().int().min(0).max(1_000_000).optional(),
          observationTypes: observationStrings.optional(),
          origins: observationStrings.optional(),
          privacyStates: z
            .array(z.enum(["normal", "private", "redacted", "suppressed"]))
            .max(4)
            .optional(),
          dateStart: z.number().int().min(0).optional(),
          dateEnd: z.number().int().min(0).optional(),
        })
        .strict(),
      "read",
      (value) => MemoryObservationService.search(value),
    ),
    getMemoryObservationDetails: workspaceAction(scope.extend({ ids }).strict(), "read", (value) =>
      MemoryObservationService.details(value.ids, value.workspaceId),
    ),
    getMemoryObservationTimeline: workspaceAction(
      scope
        .extend({
          memoryId: id.optional(),
          query: z.string().max(4000).optional(),
          windowSize: z.number().int().min(1).max(50).optional(),
        })
        .strict(),
      "read",
      (value) => MemoryObservationService.timeline(value),
    ),
    updateMemoryObservation: workspaceAction(
      observationScope.extend({ patch: observationPatch }).strict(),
      "write",
      (value) => MemoryObservationService.update(value.workspaceId, value.memoryId, value.patch),
    ),
    redactMemoryObservation: workspaceAction(
      observationScope
        .extend({ replacement: z.string().trim().min(1).max(500).optional() })
        .strict(),
      "write",
      (value) =>
        MemoryObservationService.redact(value.workspaceId, value.memoryId, value.replacement),
    ),
    deleteMemoryObservation: workspaceAction(observationScope, "delete", async (value) => ({
      success: await MemoryObservationService.delete(value.workspaceId, value.memoryId),
    })),
    listMemoryItems: workspaceAction(MemoryItemsListRequestSchema, "read", (value) =>
      hubCall(() => memoryItems.list(value)),
    ),
    getMemoryItem: workspaceAction(MemoryItemRefRequestSchema, "read", (value) =>
      hubCall(() => memoryItems.get(value.workspaceId, value.id)),
    ),
    getMemoryItemWhy: workspaceAction(MemoryItemRefRequestSchema, "read", (value) =>
      hubCall(() => memoryItems.why(value.workspaceId, value.id)),
    ),
    // Per-reply "Memory used" (hidden memory_used events attributed to the replies).
    getMemoryUsedForTask: workspaceAction(MemoryUsedForTaskRequestSchema, "read", async (value) =>
      attributeMemoryUse(
        value.taskId,
        (await options.loadMemoryUsedTimeline?.(value.workspaceId, value.taskId)) ?? [],
      ),
    ),
    addMemoryItem: workspaceAction(MemoryItemAddRequestSchema, "write", (value) =>
      hubCall(() => memoryItems.add(value)),
    ),
    updateMemoryItem: workspaceAction(MemoryItemUpdateRequestSchema, "write", (value) =>
      hubCall(() => memoryItems.update(value)),
    ),
    setMemoryItemPinned: workspaceAction(MemoryItemPinRequestSchema, "write", (value) =>
      hubCall(() => memoryItems.setPinned(value)),
    ),
    deleteMemoryItem: workspaceAction(MemoryItemRefRequestSchema, "delete", (value) =>
      hubCall(() => memoryItems.delete(value)),
    ),
    clearGlobalMemoryItems: workspaceAction(MemoryItemsClearGlobalRequestSchema, "delete", () =>
      hubCall(() => memoryItems.clearGlobal()),
    ),
    getMemoryReview: workspaceAction(MemoryReviewWorkspaceRequestSchema, "read", (value) =>
      reviewCall((service) => service.state(value.workspaceId)),
    ),
    undoMemoryChange: workspaceAction(MemoryReviewUndoRequestSchema, "write", (value) =>
      reviewCall((service) => service.undo(value.workspaceId, value.id)),
    ),
    getMemorySources: workspaceAction(MemoryHubWorkspaceRequestSchema, "read", (value) =>
      healthCall((service) => service.sources(value.workspaceId)),
    ),
    getMemoryHealth: workspaceAction(MemoryHubWorkspaceRequestSchema, "read", () =>
      healthCall((service) => service.health()),
    ),
    // Memory folder: same contract as the desktop IPC (memoryRepo:*). Opening the
    // folder is desktop-only; the browser host has no local file manager to open it in.
    getMemoryRepoStatus: noArgs(() => memoryRepoStatus()),
    compactMemoryRepoHistory: noArgs(async (): Promise<MemoryRepoCompactResult> => {
      const service = MemoryRepoService.get();
      if (!service) return { compacted: false, error: "The memory folder is off." };
      return service.compactHistory();
    }, true),
    readMemoryRepoLines: action(MemoryRepoRefsSchema, (refs) => readMemoryRepoLines(refs)),
    // Memory Hub "What CoWork knows" over the folder; "Open file" stays desktop-only.
    getMemoryRepoEntries: workspaceAction(MemoryRepoEntriesRequestSchema, "read", (value) =>
      listMemoryRepoEntries(MemoryRepoService.get(), value.workspaceId),
    ),
    updateMemoryRepoEntry: workspaceAction(MemoryRepoUpdateEntryRequestSchema, "write", (value) =>
      updateMemoryRepoEntry(MemoryRepoService.get(), value),
    ),
    removeMemoryRepoEntry: workspaceAction(MemoryRepoEntryRequestSchema, "delete", (value) =>
      removeMemoryRepoEntry(MemoryRepoService.get(), value),
    ),
    pinMemoryRepoEntry: workspaceAction(MemoryRepoEntryRequestSchema, "write", (value) =>
      pinMemoryRepoEntry(MemoryRepoService.get(), value),
    ),
    // Keep an inbox entry. Importing a folder stays desktop-only (it needs a native picker).
    keepMemoryRepoEntry: workspaceAction(
      MemoryRepoKeepEntryRequestSchema,
      "write",
      (value, workspace) =>
        keepMemoryRepoEntry(MemoryRepoService.get(), { ...value, workspaceName: workspace.name }),
    ),
    // Dreams over the memory folder (docs/memory-repo-phase2-design.md §5-§7).
    getMemoryRepoDreams: noArgs(() =>
      buildMemoryRepoDreamsReport({
        service: MemoryRepoService.get(),
        settings: loadMemoryRepoDreamSettings(),
      }),
    ),
    getMemoryRepoDreamDiff: {
      capability: "memory.manage",
      mutation: false,
      minArgs: 2,
      maxArgs: 2,
      validate: (args) => [
        MemoryRepoDreamIdSchema.parse(args[0]),
        MemoryRepoDreamPartSchema.parse(args[1]),
      ],
      handler: ([dreamId, part]) =>
        memoryRepoDreamDiffText(
          MemoryRepoService.get(),
          dreamId as string,
          part as "review" | "auto",
        ),
    },
    acceptMemoryRepoDream: action(
      MemoryRepoDreamIdSchema,
      (dreamId) => runMemoryRepoDreamAction(MemoryRepoService.get(), "accept", dreamId),
      true,
    ),
    rejectMemoryRepoDream: action(
      MemoryRepoDreamIdSchema,
      (dreamId) => runMemoryRepoDreamAction(MemoryRepoService.get(), "reject", dreamId),
      true,
    ),
    undoMemoryRepoDream: action(
      MemoryRepoDreamIdSchema,
      (dreamId) => runMemoryRepoDreamAction(MemoryRepoService.get(), "undo", dreamId),
      true,
    ),
    // Shares a running dream; the daily token budget bounds what repeated calls can spend.
    dreamMemoryRepoNow: noArgs(async () => {
      const dreamer = getMemoryRepoDreamer();
      return toMemoryRepoDreamNowResult(dreamer ? await dreamer.run("manual") : null);
    }, true),
    // Sync with the private remote (docs/memory-repo-phase4-design.md §1): same results as
    // the desktop `memoryRepo:syncNow`.
    syncMemoryRepoNow: noArgs(async (): Promise<MemoryRepoSyncNowResult> => {
      const service = MemoryRepoService.get();
      if (!service) return { error: MEMORY_REPO_SYNC_FOLDER_OFF_ERROR };
      if (!service.isSyncConfigured()) return { error: MEMORY_REPO_SYNC_OFF_ERROR };
      return service.syncNow({ push: true });
    }, true),
    getMemoryObservationBackfillStatus: noArgs(() => MemoryObservationService.getBackfillStatus()),
    rebuildMemoryObservationMetadata: {
      ...action(
        z.object({ force: z.boolean().optional() }).strict().optional(),
        (value) => MemoryObservationService.startBackfill(value?.force === true),
        true,
      ),
      minArgs: 0,
    },
  };
}
