import { randomUUID, createHash } from "crypto";
import {
  ActionPolicy,
  AutonomyAction,
  AutonomyConfig,
  AutonomyDecision,
  AutonomyOutcome,
  AutonomyPolicyLevel,
  AwarenessBelief,
  ChiefOfStaffActionType,
  ChiefOfStaffWorldModel,
  FocusSessionState,
  GoalState,
  OpenLoopState,
  ProjectState,
  RoutineState,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { getAwarenessService } from "./AwarenessService";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import { UserProfileService } from "../memory/UserProfileService";
import {
  getBackgroundDispatchBudget,
  type BackgroundDispatchBudgetAuthority,
} from "../agents/BackgroundDispatchBudget";
import { commitmentEntityKey } from "../agent/SuggestionSink";

const STORAGE_KEY = "autonomy-chief-of-staff";
/**
 * Heartbeat pulses call `evaluate()`; several heartbeat agents can pulse the same workspace,
 * so evaluations closer together than this are skipped (manual evaluations are not).
 */
const MIN_EVALUATION_INTERVAL_MS = 60_000;
const MAX_ACTIONS = 80;
const MAX_OUTCOMES = 80;
/**
 * v2: autonomous task creation is opt-in. Earlier states carried `execute_local` defaults for
 * `create_task` / `execute_local_action`; loading such a state resets them to `suggest_only`.
 */
const AUTONOMY_POLICY_VERSION = 2;
const OPT_IN_ACTION_TYPES: ChiefOfStaffActionType[] = ["create_task", "execute_local_action"];
/** World-model fields that change on every derivation and must not count as a change. */
const VOLATILE_WORLD_MODEL_KEYS = new Set([
  "generatedAt",
  "startedAt",
  "lastActiveAt",
  "lastObservedAt",
]);

interface PersistedAutonomyState {
  config: AutonomyConfig;
  worldModels: Record<string, ChiefOfStaffWorldModel>;
  decisions: AutonomyDecision[];
  actions: AutonomyAction[];
  outcomes: AutonomyOutcome[];
  policyVersion?: number;
}

/** A suggestion proposal for the shared SuggestionSink (kept structural to avoid a cycle). */
export interface AutonomySuggestionProposal {
  workspaceId: string;
  decision: AutonomyDecision;
}

interface AutonomyEngineDeps {
  getDefaultWorkspaceId?: () => string | undefined;
  listWorkspaceIds?: () => string[];
  createTask?: (
    workspaceId: string,
    title: string,
    prompt: string,
    options?: { backgroundDispatchTicket?: string },
  ) => Promise<{ id?: string }>;
  hasActiveManualTask?: (workspaceId: string) => boolean;
  recordActivity?: (params: {
    workspaceId: string;
    title: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }) => void;
  /** Route suggested decisions into the shared SuggestionSink. */
  proposeSuggestion?: (proposal: AutonomySuggestionProposal) => Promise<unknown>;
  /** Shared background dispatch budget; defaults to the process-wide one. */
  dispatchBudget?: BackgroundDispatchBudgetAuthority;
  log?: (...args: unknown[]) => void;
}

function stableWorldModelKey(model: ChiefOfStaffWorldModel | undefined): string {
  if (!model) return "";
  return JSON.stringify(model, (key, value) =>
    VOLATILE_WORLD_MODEL_KEYS.has(key) ? undefined : value,
  );
}

function normalizeEntityPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function hashFingerprint(parts: Array<string | number | undefined>): string {
  return createHash("sha1").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 20);
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function buildActionPolicy(
  actionType: ChiefOfStaffActionType,
  level: AutonomyPolicyLevel,
  cooldownMinutes: number,
  allowExternalSideEffects = false,
): ActionPolicy {
  return {
    actionType,
    level,
    cooldownMinutes,
    allowExternalSideEffects,
  };
}

export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  enabled: true,
  autoEvaluate: true,
  maxPendingDecisions: 12,
  actionPolicies: {
    prepare_briefing: buildActionPolicy("prepare_briefing", "suggest_only", 180),
    // Autonomous task creation is opt-in (SEC-18): the user can switch these to execute_local.
    create_task: buildActionPolicy("create_task", "suggest_only", 240),
    schedule_follow_up: buildActionPolicy("schedule_follow_up", "suggest_only", 180),
    draft_message: buildActionPolicy("draft_message", "execute_with_approval", 240, true),
    draft_agenda: buildActionPolicy("draft_agenda", "suggest_only", 180),
    organize_work_session: buildActionPolicy("organize_work_session", "suggest_only", 180),
    nudge_user: buildActionPolicy("nudge_user", "suggest_only", 90),
    execute_local_action: buildActionPolicy("execute_local_action", "suggest_only", 180),
  },
};

function defaultState(): PersistedAutonomyState {
  return {
    config: JSON.parse(JSON.stringify(DEFAULT_AUTONOMY_CONFIG)) as AutonomyConfig,
    worldModels: {},
    decisions: [],
    actions: [],
    outcomes: [],
    policyVersion: AUTONOMY_POLICY_VERSION,
  };
}

export class AutonomyEngine {
  private static instance: AutonomyEngine | null = null;
  private deps: AutonomyEngineDeps;
  private state: PersistedAutonomyState = defaultState();
  private loaded = false;
  private started = false;
  /** Unsaved changes; the encrypted state is written only when this is set. */
  private dirty = false;
  private mutationVersion = 0;
  private configIntent: { kind: "explicit" | "migration" } | null = null;
  private decisionEdits = new Map<
    string,
    { workspaceId?: string; status: AutonomyDecision["status"]; updatedAt: number }
  >();
  private evaluationInFlight = new Set<string>();
  private lastEvaluatedAt = new Map<string, number>();

  constructor(deps: AutonomyEngineDeps = {}) {
    this.deps = deps;
  }

  static initialize(deps: AutonomyEngineDeps = {}): AutonomyEngine {
    if (!this.instance) {
      this.instance = new AutonomyEngine(deps);
    } else {
      this.instance.deps = deps;
    }
    return this.instance;
  }

  static getInstance(): AutonomyEngine {
    return this.instance || this.initialize();
  }

  /**
   * AutonomyEngine no longer schedules itself: Heartbeat owns "when to think" and calls
   * `evaluate(workspaceId)` from its pulse. `start` only loads the persisted state.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.ensureLoaded();
    await this.saveIfDirtyAsync();
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.saveIfDirtyAsync();
  }

  /**
   * Heartbeat pulse phase: cheap, deterministic evaluation of one workspace. Skipped when the
   * engine is disabled, auto-evaluation is off, or this workspace was evaluated within the last
   * minute (several heartbeat agents may pulse the same workspace).
   */
  async evaluate(workspaceId: string): Promise<boolean> {
    this.ensureLoaded();
    if (!workspaceId || !this.state.config.enabled || !this.state.config.autoEvaluate) {
      return false;
    }
    const last = this.lastEvaluatedAt.get(workspaceId) || 0;
    if (Date.now() - last < MIN_EVALUATION_INTERVAL_MS) return false;
    await this.evaluateWorkspace(workspaceId);
    return true;
  }

  getConfig(): AutonomyConfig {
    this.ensureLoaded();
    return JSON.parse(JSON.stringify(this.state.config)) as AutonomyConfig;
  }

  saveConfig(config: AutonomyConfig): AutonomyConfig {
    this.ensureLoaded();
    this.state.config = {
      ...DEFAULT_AUTONOMY_CONFIG,
      ...config,
      actionPolicies: {
        ...DEFAULT_AUTONOMY_CONFIG.actionPolicies,
        ...config.actionPolicies,
      },
    };
    // An explicit save is the user's choice (including opting in to execute_local).
    this.state.policyVersion = AUTONOMY_POLICY_VERSION;
    this.configIntent = { kind: "explicit" };
    this.markDirty();
    this.saveIfDirty();
    return this.getConfig();
  }

  getWorldModel(workspaceId?: string): ChiefOfStaffWorldModel | null {
    this.ensureLoaded();
    const resolvedWorkspaceId = workspaceId || this.deps.getDefaultWorkspaceId?.();
    if (!resolvedWorkspaceId) return null;
    return this.state.worldModels[resolvedWorkspaceId] || null;
  }

  listDecisions(workspaceId?: string): AutonomyDecision[] {
    this.ensureLoaded();
    return this.state.decisions
      .filter((decision) => !workspaceId || decision.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((decision) => ({ ...decision, evidenceRefs: [...decision.evidenceRefs] }));
  }

  listActions(workspaceId?: string): AutonomyAction[] {
    this.ensureLoaded();
    return this.state.actions
      .filter((action) => !workspaceId || action.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((action) => ({
        ...action,
        metadata: action.metadata ? { ...action.metadata } : undefined,
      }));
  }

  listOutcomes(workspaceId?: string): AutonomyOutcome[] {
    this.ensureLoaded();
    return this.state.outcomes
      .filter((outcome) => !workspaceId || outcome.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((outcome) => ({ ...outcome }));
  }

  async triggerEvaluation(workspaceId?: string): Promise<ChiefOfStaffWorldModel | null> {
    this.ensureLoaded();
    const resolvedWorkspaceId = workspaceId || this.deps.getDefaultWorkspaceId?.();
    if (!resolvedWorkspaceId) return null;
    await this.evaluateWorkspace(resolvedWorkspaceId);
    return this.getWorldModel(resolvedWorkspaceId);
  }

  updateDecision(
    id: string,
    patch: Partial<Pick<AutonomyDecision, "status">>,
  ): AutonomyDecision | null {
    this.ensureLoaded();
    const decision = this.state.decisions.find((entry) => entry.id === id);
    if (!decision) return null;
    if (
      patch.status === "pending" ||
      patch.status === "suggested" ||
      patch.status === "executed" ||
      patch.status === "dismissed" ||
      patch.status === "done"
    ) {
      decision.status = patch.status;
      decision.updatedAt = Date.now();
      this.decisionEdits.set(id, {
        workspaceId: decision.workspaceId,
        status: patch.status,
        updatedAt: decision.updatedAt,
      });
      if (patch.status === "done" || patch.status === "dismissed") {
        this.state.outcomes.unshift({
          id: randomUUID(),
          actionId: decision.id,
          decisionId: decision.id,
          workspaceId: decision.workspaceId,
          outcome: patch.status === "done" ? "accepted" : "ignored",
          summary:
            patch.status === "done"
              ? `Decision completed: ${decision.title}`
              : `Decision dismissed: ${decision.title}`,
          createdAt: Date.now(),
        });
        this.state.outcomes = this.state.outcomes.slice(0, MAX_OUTCOMES);
      }
      this.markDirty();
      this.saveIfDirty();
    }
    const saved = this.state.decisions.find((entry) => entry.id === id);
    if (this.decisionEdits.has(id)) return null;
    return saved && saved.workspaceId === decision.workspaceId && saved.status === decision.status
      ? { ...saved, evidenceRefs: [...saved.evidenceRefs] }
      : null;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!SecureSettingsRepository.isInitialized()) {
      this.state = defaultState();
      return;
    }
    try {
      const repo = SecureSettingsRepository.getInstance();
      const stored = repo.load<PersistedAutonomyState>(STORAGE_KEY);
      const next: PersistedAutonomyState = stored
        ? {
            config: {
              ...DEFAULT_AUTONOMY_CONFIG,
              ...stored.config,
              actionPolicies: {
                ...DEFAULT_AUTONOMY_CONFIG.actionPolicies,
                ...stored.config?.actionPolicies,
              },
            },
            worldModels: stored.worldModels || {},
            decisions: Array.isArray(stored.decisions) ? stored.decisions : [],
            actions: Array.isArray(stored.actions) ? stored.actions : [],
            outcomes: Array.isArray(stored.outcomes) ? stored.outcomes : [],
            policyVersion: stored.policyVersion,
          }
        : defaultState();
      if ((next.policyVersion ?? 1) < AUTONOMY_POLICY_VERSION) {
        // Older states stored the former execute_local defaults; make task creation opt-in.
        for (const actionType of OPT_IN_ACTION_TYPES) {
          const policy = next.config.actionPolicies[actionType];
          if (policy?.level === "execute_local") {
            next.config.actionPolicies[actionType] = { ...policy, level: "suggest_only" };
          }
        }
        next.policyVersion = AUTONOMY_POLICY_VERSION;
        this.configIntent = { kind: "migration" };
        this.markDirty();
      }
      this.state = next;
    } catch {
      this.state = defaultState();
    }
  }

  private markDirty(): void {
    this.dirty = true;
    this.mutationVersion++;
  }

  private prepareStateSave() {
    const snapshot = structuredClone(this.state);
    const version = this.mutationVersion;
    const configIntent = this.configIntent;
    const edits = new Map(this.decisionEdits);
    const mutate = (current: PersistedAutonomyState | undefined): PersistedAutonomyState => {
      const writeConfig =
        configIntent?.kind === "explicit" ||
        (configIntent?.kind === "migration" &&
          current &&
          (current.policyVersion ?? 1) < AUTONOMY_POLICY_VERSION);
      const config = writeConfig
        ? {
            ...current?.config,
            ...snapshot.config,
            actionPolicies: {
              ...current?.config?.actionPolicies,
              ...snapshot.config.actionPolicies,
            },
          }
        : current?.config || structuredClone(DEFAULT_AUTONOMY_CONFIG);
      const decisions = new Map(
        (current?.decisions || []).map((entry) => [entry.id, structuredClone(entry)]),
      );
      const blockedEdits = new Set<string>();
      const intentKey = (entry: AutonomyDecision) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(entry)
              .filter(([key]) => key !== "status" && key !== "updatedAt")
              .sort(([a], [b]) => a.localeCompare(b)),
          ),
        );
      for (const incoming of snapshot.decisions) {
        const existing = decisions.get(incoming.id);
        const edit = edits.get(incoming.id);
        if (edit) {
          const revision = existing?.statusRevision ?? 0;
          if (
            existing &&
            existing.workspaceId === edit.workspaceId &&
            Number.isSafeInteger(revision) &&
            revision >= 0 &&
            revision < Number.MAX_SAFE_INTEGER
          )
            decisions.set(incoming.id, {
              ...existing,
              status: edit.status,
              updatedAt: edit.updatedAt,
              statusRevision: revision + 1,
            });
          else blockedEdits.add(incoming.id);
          continue;
        }
        if (!existing) {
          const repeated = [...decisions.values()].some(
            (entry) =>
              entry.workspaceId === incoming.workspaceId &&
              Boolean(incoming.fingerprint) &&
              entry.fingerprint === incoming.fingerprint &&
              entry.status !== "done" &&
              entry.status !== "dismissed" &&
              (entry.cooldownUntil || incoming.createdAt) >= incoming.createdAt,
          );
          if (!repeated) decisions.set(incoming.id, incoming);
          continue;
        }
        if (
          existing.status === "done" ||
          existing.status === "dismissed" ||
          incoming.updatedAt < existing.updatedAt ||
          intentKey(existing) !== intentKey(incoming)
        )
          continue;
        const executed =
          incoming.status === "executed" &&
          snapshot.actions.some(
            (action) => action.decisionId === incoming.id && action.status === "success",
          );
        if (existing.status === "pending" && (executed || incoming.status === "suggested"))
          decisions.set(incoming.id, {
            ...existing,
            status: incoming.status,
            updatedAt: incoming.updatedAt,
          });
      }
      const mergeRows = <T extends { id: string; createdAt: number }>(
        saved: T[],
        local: T[],
        maximum: number,
      ): T[] =>
        [...new Map([...local, ...saved].map((entry) => [entry.id, entry])).values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, maximum);
      const worldModels = { ...current?.worldModels };
      for (const [workspaceId, model] of Object.entries(snapshot.worldModels)) {
        if (!worldModels[workspaceId] || model.generatedAt >= worldModels[workspaceId].generatedAt)
          worldModels[workspaceId] = model;
      }
      return {
        ...current,
        config,
        worldModels,
        decisions: [...decisions.values()]
          .filter((entry) => Date.now() - entry.createdAt <= 7 * 24 * 60 * 60 * 1000)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 120),
        actions: mergeRows(current?.actions || [], snapshot.actions, MAX_ACTIONS),
        outcomes: mergeRows(
          current?.outcomes || [],
          snapshot.outcomes.filter(
            (entry) => !entry.decisionId || !blockedEdits.has(entry.decisionId),
          ),
          MAX_OUTCOMES,
        ),
        policyVersion: Math.max(
          current?.policyVersion ?? 1,
          snapshot.policyVersion ?? AUTONOMY_POLICY_VERSION,
        ),
      };
    };
    const finish = (saved: PersistedAutonomyState | undefined) => {
      if (!saved) return;
      if (this.configIntent === configIntent) this.configIntent = null;
      for (const [id, edit] of edits)
        if (this.decisionEdits.get(id) === edit) this.decisionEdits.delete(id);
      if (this.mutationVersion !== version) return;
      this.state = saved;
      this.dirty = false;
    };
    return { mutate, finish };
  }

  /** Explicit edits retain their synchronous API; automatic saves use the worker path. */
  private saveIfDirty(): void {
    if (!this.dirty || !SecureSettingsRepository.isInitialized()) return;
    try {
      const save = this.prepareStateSave();
      save.finish(SecureSettingsRepository.getInstance().update(STORAGE_KEY, save.mutate).value);
    } catch {
      // Keep the mutation and explicit intents for retry.
    }
  }

  private async saveIfDirtyAsync(): Promise<void> {
    if (!this.dirty || !SecureSettingsRepository.isInitialized()) return;
    try {
      const save = this.prepareStateSave();
      save.finish(
        (await SecureSettingsRepository.getInstance().updateAsync(STORAGE_KEY, save.mutate)).value,
      );
    } catch {
      // Keep the mutation and explicit intents for retry.
    }
  }

  private async evaluateWorkspace(workspaceId: string): Promise<void> {
    this.ensureLoaded();
    if (!workspaceId || this.evaluationInFlight.has(workspaceId)) return;
    this.evaluationInFlight.add(workspaceId);
    this.lastEvaluatedAt.set(workspaceId, Date.now());
    try {
      const worldModel = this.deriveWorldModel(workspaceId);
      const previous = this.state.worldModels[workspaceId];
      this.state.worldModels[workspaceId] = worldModel;
      if (stableWorldModelKey(previous) !== stableWorldModelKey(worldModel)) this.markDirty();
      const generated = this.generateDecisions(workspaceId, worldModel);
      if (generated.length > 0) {
        const fresh = this.mergeDecisions(generated);
        await this.executePendingDecisions(workspaceId);
        await this.proposeSuggestedDecisions(workspaceId, fresh);
      }
      this.pruneDecisions();
      await this.saveIfDirtyAsync();
    } catch (error) {
      this.deps.log?.("[AutonomyEngine] evaluation failed", workspaceId, error);
    } finally {
      this.evaluationInFlight.delete(workspaceId);
    }
  }

  /** Suggested (not executed) decisions become suggestions through the shared sink. */
  private async proposeSuggestedDecisions(
    workspaceId: string,
    decisions: AutonomyDecision[],
  ): Promise<void> {
    if (!this.deps.proposeSuggestion) return;
    for (const decision of decisions) {
      if (decision.status !== "suggested") continue;
      try {
        await this.deps.proposeSuggestion({ workspaceId, decision: { ...decision } });
      } catch (error) {
        this.deps.log?.("[AutonomyEngine] suggestion proposal failed", decision.id, error);
      }
    }
  }

  private deriveWorldModel(workspaceId: string): ChiefOfStaffWorldModel {
    const awareness = getAwarenessService();
    const summary = awareness.getSummary(workspaceId);
    const snapshot = awareness.getSnapshot(workspaceId);
    const profile = UserProfileService.getProfile();
    const now = Date.now();

    const goals = this.deriveGoals(workspaceId, summary.beliefs, profile.facts);
    const projects = this.deriveProjects(
      workspaceId,
      snapshot.recentProjects,
      snapshot.recentFiles,
      summary.beliefs,
    );
    const openLoops = this.deriveOpenLoops(workspaceId);
    const routines = this.deriveRoutines(workspaceId, summary.beliefs, summary.whatChanged);
    const focusSession = this.deriveFocusSession(workspaceId, snapshot, summary);
    const currentPriorities = Array.from(
      new Set([
        ...summary.dueSoon.map((item) => item.title),
        ...summary.whatMattersNow.map((item) => item.title),
        ...goals.slice(0, 3).map((goal) => goal.title),
      ]),
    ).slice(0, 8);
    const continuityNotes = [
      ...openLoops.slice(0, 3).map((loop) => `Open loop: ${loop.title}`),
      ...projects.slice(0, 2).map((project) => `Recent project: ${project.name}`),
      ...summary.whatChanged.slice(0, 3).map((item) => `Changed: ${item.title}`),
    ].slice(0, 8);

    return {
      generatedAt: now,
      workspaceId,
      focusSession,
      goals,
      projects,
      openLoops,
      routines,
      beliefs: summary.beliefs.slice(0, 12),
      currentPriorities,
      continuityNotes,
    };
  }

  private deriveGoals(
    workspaceId: string,
    beliefs: AwarenessBelief[],
    facts: Array<{
      id: string;
      category: string;
      value: string;
      confidence: number;
      lastUpdatedAt: number;
    }>,
  ): GoalState[] {
    const items: GoalState[] = [];
    for (const fact of facts.filter((entry) => entry.category === "goal").slice(0, 6)) {
      items.push({
        id: `goal-fact-${fact.id}`,
        workspaceId,
        title: fact.value.replace(/^Goal:\s*/i, "").trim(),
        status: "active",
        confidence: clampConfidence(fact.confidence ?? 0.75),
        source: "profile",
        evidenceRefs: [fact.id],
        lastSeenAt: fact.lastUpdatedAt,
      });
    }
    for (const belief of beliefs.filter((entry) => entry.beliefType === "user_goal").slice(0, 6)) {
      items.push({
        id: `goal-belief-${belief.id}`,
        workspaceId,
        title: belief.value.replace(/^Goal:\s*/i, "").trim(),
        status: belief.promotionStatus === "confirmed" ? "active" : "observed",
        confidence: clampConfidence(belief.confidence),
        source: belief.source,
        evidenceRefs: [...belief.evidenceRefs],
        lastSeenAt: belief.updatedAt,
      });
    }
    return this.dedupeByTitle(items).slice(0, 8);
  }

  private deriveProjects(
    workspaceId: string,
    recentProjects: string[],
    recentFiles: string[],
    beliefs: AwarenessBelief[],
  ): ProjectState[] {
    const items: ProjectState[] = recentProjects.map((project, index) => ({
      id: `project-snapshot-${project}-${index}`,
      workspaceId,
      name: project,
      confidence: 0.72,
      source: "files",
      evidenceRefs: recentFiles.filter((file) => file.includes(project)).slice(0, 4),
      lastActiveAt: Date.now() - index * 60_000,
      recentFiles: recentFiles.filter((file) => file.includes(project)).slice(0, 5),
    }));
    for (const belief of beliefs.filter((entry) => entry.beliefType === "project_affinity")) {
      const project = belief.value.replace(/^Frequently active in project\s+/i, "").trim();
      if (!project) continue;
      items.push({
        id: `project-belief-${belief.id}`,
        workspaceId,
        name: project,
        confidence: clampConfidence(belief.confidence),
        source: "belief",
        evidenceRefs: [...belief.evidenceRefs],
        lastActiveAt: belief.updatedAt,
        recentFiles: recentFiles.filter((file) => file.includes(project)).slice(0, 5),
      });
    }
    return this.dedupeByTitle(items).slice(0, 6);
  }

  private deriveOpenLoops(workspaceId: string): OpenLoopState[] {
    const dueSoon = RelationshipMemoryService.listDueSoonCommitments(72).slice(0, 8);
    const open = RelationshipMemoryService.listOpenCommitments(12).slice(0, 12);
    const items: OpenLoopState[] = [...dueSoon, ...open].map((item) => ({
      id: item.id,
      workspaceId,
      title: item.text,
      status: item.status === "done" ? "done" : "open",
      confidence: clampConfidence(item.confidence ?? 0.8),
      source: "relationship",
      evidenceRefs: [item.id],
      dueAt: item.dueAt,
      lastUpdatedAt: item.updatedAt,
    }));
    return this.dedupeByTitle(items).slice(0, 10);
  }

  private deriveRoutines(
    workspaceId: string,
    beliefs: AwarenessBelief[],
    whatChanged: Array<{ id: string; title: string; detail: string; tags: string[] }>,
  ): RoutineState[] {
    const items: RoutineState[] = beliefs
      .filter(
        (entry) => entry.beliefType === "workflow_habit" || entry.beliefType === "device_context",
      )
      .slice(0, 8)
      .map((belief) => ({
        id: `routine-${belief.id}`,
        workspaceId,
        title: belief.subject.replace(/_/g, " "),
        description: belief.value,
        confidence: clampConfidence(belief.confidence),
        source: belief.source,
        evidenceRefs: [...belief.evidenceRefs],
        trigger:
          belief.subject === "task_pattern" ? "repeated task completion" : "repeated context",
        suggestedActionType:
          belief.subject === "task_pattern" ? "create_task" : "organize_work_session",
        cooldownMinutes: 180,
        lastObservedAt: belief.updatedAt,
        lastExecutedAt: this.findLastExecutedAt(`routine-${belief.id}`),
      }));

    if (
      whatChanged.some(
        (item) => item.tags.includes("focus") && /code|editor|vscode|cursor/i.test(item.detail),
      )
    ) {
      items.push({
        id: `routine-editor-${workspaceId}`,
        workspaceId,
        title: "editor startup",
        description: "User shifted into editor-focused work and likely needs active work context.",
        confidence: 0.68,
        source: "apps",
        evidenceRefs: whatChanged
          .filter((item) => item.tags.includes("focus"))
          .map((item) => item.id),
        trigger: "focus enters editor work",
        suggestedActionType: "organize_work_session",
        cooldownMinutes: 120,
        lastObservedAt: Date.now(),
      });
    }

    return this.dedupeByTitle(items).slice(0, 8);
  }

  private deriveFocusSession(
    workspaceId: string,
    snapshot: ReturnType<typeof getAwarenessService>["getSnapshot"] extends (
      ...args: never[]
    ) => infer T
      ? T
      : never,
    summary: ReturnType<typeof getAwarenessService>["getSummary"] extends (
      ...args: never[]
    ) => infer T
      ? T
      : never,
  ): FocusSessionState | undefined {
    if (!snapshot.currentFocus && !snapshot.activeApp) return undefined;
    const label = snapshot.currentFocus || snapshot.activeApp || "Current work";
    return {
      id: `focus-${workspaceId}`,
      workspaceId,
      focusLabel: label,
      activeApp: snapshot.activeApp,
      activeWindowTitle: snapshot.activeWindowTitle,
      activeProject: snapshot.recentProjects[0],
      mode: this.classifyFocusMode(
        snapshot.activeApp,
        snapshot.activeWindowTitle,
        summary.currentFocus,
      ),
      startedAt: Date.now() - 5 * 60 * 1000,
      lastActiveAt: Date.now(),
    };
  }

  private classifyFocusMode(
    activeApp?: string,
    windowTitle?: string,
    currentFocus?: string,
  ): FocusSessionState["mode"] {
    const label = `${activeApp || ""} ${windowTitle || ""} ${currentFocus || ""}`.toLowerCase();
    if (/zoom|meet|calendar|meeting/.test(label)) return "meeting";
    if (/chrome|safari|arc|firefox|research|docs/.test(label)) return "research";
    if (/terminal|iterm|warp|shell/.test(label)) return "planning";
    if (/cursor|code|xcode|editor|webstorm/.test(label)) return "deep_work";
    return "mixed";
  }

  private generateDecisions(
    workspaceId: string,
    worldModel: ChiefOfStaffWorldModel,
  ): AutonomyDecision[] {
    const now = Date.now();
    const decisions: AutonomyDecision[] = [];
    const pushDecision = (
      title: string,
      description: string,
      actionType: ChiefOfStaffActionType,
      priority: AutonomyDecision["priority"],
      reason: string,
      evidenceRefs: string[],
      suggestedTaskTitle?: string,
      suggestedPrompt?: string,
      routineId?: string,
      entityKey?: string,
    ) => {
      const policy = this.state.config.actionPolicies[actionType];
      const fingerprint = hashFingerprint([workspaceId, actionType, title, reason]);
      if (this.hasActiveDecisionFingerprint(fingerprint, now)) return;
      decisions.push({
        id: randomUUID(),
        workspaceId,
        title,
        description,
        actionType,
        policyLevel: policy.level,
        priority,
        status: policy.level === "execute_local" ? "pending" : "suggested",
        reason,
        evidenceRefs: [...evidenceRefs].slice(0, 8),
        fingerprint,
        createdAt: now,
        updatedAt: now,
        cooldownUntil: now + policy.cooldownMinutes * 60_000,
        suggestedTaskTitle,
        suggestedPrompt,
        routineId,
        entityKey,
      });
    };

    for (const openLoop of worldModel.openLoops.slice(0, 2)) {
      if (openLoop.status !== "open") continue;
      const isUrgent =
        typeof openLoop.dueAt === "number" && openLoop.dueAt - now <= 24 * 60 * 60 * 1000;
      pushDecision(
        `Follow up on: ${openLoop.title}`.slice(0, 100),
        openLoop.dueAt
          ? `This open loop is due soon and should be clarified or scheduled before ${new Date(openLoop.dueAt).toLocaleString()}.`
          : "This open loop is active and should be scheduled or clarified.",
        "schedule_follow_up",
        isUrgent ? "high" : "normal",
        "due-soon open loop requires follow-up",
        openLoop.evidenceRefs,
        `Follow up: ${openLoop.title}`.slice(0, 100),
        `Review this open loop, clarify the next owner/step, and convert it into a concrete internal plan: ${openLoop.title}`,
        undefined,
        openLoop.source === "relationship" ? commitmentEntityKey(openLoop.id) : undefined,
      );
    }

    const primaryGoal = worldModel.goals[0];
    const focus = worldModel.focusSession;
    if (primaryGoal && focus) {
      pushDecision(
        `Organize next work session for ${primaryGoal.title}`.slice(0, 100),
        `Current focus suggests the user is in ${focus.mode.replace(/_/g, " ")} mode. Prepare the most relevant next actions for this goal.`,
        "organize_work_session",
        "normal",
        "current focus aligns with an active goal",
        [...primaryGoal.evidenceRefs, focus.id],
        `Organize work session: ${primaryGoal.title}`.slice(0, 100),
        `Use the current project, active app, and recent files to prepare the next concrete work session for this goal: ${primaryGoal.title}`,
        undefined,
        `goal:${normalizeEntityPart(primaryGoal.title)}`,
      );
    }

    const routine = worldModel.routines.find(
      (item) => !item.paused && this.isRoutineReady(item, now),
    );
    if (routine) {
      pushDecision(
        `Prepare routine context: ${routine.title}`.slice(0, 100),
        routine.description,
        routine.suggestedActionType,
        "normal",
        "repeated workflow detected",
        routine.evidenceRefs,
        `Routine prep: ${routine.title}`.slice(0, 100),
        `Prepare the local context and checklist for this routine: ${routine.description}`,
        routine.id,
        `routine:${routine.id}`,
      );
    }

    if (worldModel.currentPriorities.length > 0) {
      pushDecision(
        "Assemble a chief-of-staff briefing",
        "Summarize active goals, due-soon items, and likely next actions into a ready-to-use briefing.",
        "prepare_briefing",
        "normal",
        "multiple current priorities detected",
        worldModel.openLoops.slice(0, 3).map((loop) => loop.id),
        "Chief of Staff briefing",
        `Summarize the active goals, due-soon items, routines, and current focus into a concise internal briefing for this workspace.`,
        undefined,
        `autonomy:briefing:${workspaceId}`,
      );
    }

    return decisions.slice(0, this.state.config.maxPendingDecisions);
  }

  private mergeDecisions(decisions: AutonomyDecision[]): AutonomyDecision[] {
    if (decisions.length === 0) return [];
    const fresh = decisions.filter(
      (decision) => !this.hasActiveDecisionFingerprint(decision.fingerprint, decision.createdAt),
    );
    if (fresh.length === 0) return [];
    this.state.decisions = [...fresh, ...this.state.decisions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 120);
    this.markDirty();
    // Evaluation runs inside a Heartbeat pulse now, so there is no heartbeat to wake: suggested
    // decisions surface through the suggestion sink instead.
    return fresh;
  }

  private adoptSavedDispatchState(saved: PersistedAutonomyState): void {
    this.state.config = {
      ...DEFAULT_AUTONOMY_CONFIG,
      ...saved.config,
      enabled: saved.config?.enabled === true,
      actionPolicies: {
        ...DEFAULT_AUTONOMY_CONFIG.actionPolicies,
        ...saved.config?.actionPolicies,
      },
    };
    for (const entry of saved.decisions || []) {
      const local = this.state.decisions.find((decision) => decision.id === entry.id);
      if (!local) this.state.decisions.push(structuredClone(entry));
      else if (
        entry.updatedAt > local.updatedAt ||
        entry.status === "dismissed" ||
        entry.status === "done"
      )
        Object.assign(local, structuredClone(entry));
    }
    const actionIds = new Set(this.state.actions.map((entry) => entry.id));
    this.state.actions.push(...(saved.actions || []).filter((entry) => !actionIds.has(entry.id)));
    this.state.actions = this.state.actions
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ACTIONS);
    const outcomeIds = new Set(this.state.outcomes.map((entry) => entry.id));
    this.state.outcomes.push(
      ...(saved.outcomes || []).filter((entry) => !outcomeIds.has(entry.id)),
    );
    this.state.outcomes = this.state.outcomes
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_OUTCOMES);
    for (const [workspaceId, model] of Object.entries(saved.worldModels || {})) {
      const local = this.state.worldModels[workspaceId];
      if (!local || model.generatedAt > local.generatedAt)
        this.state.worldModels[workspaceId] = structuredClone(model);
    }
  }

  /** Persist the occurrence before task admission, using the current saved policy. */
  private async checkpointDispatchDecision(decision: AutonomyDecision): Promise<boolean> {
    if (!SecureSettingsRepository.isInitialized()) return false;
    const candidate = structuredClone(decision);
    let canonical: AutonomyDecision | undefined;
    let admitted = false;
    try {
      const result =
        await SecureSettingsRepository.getInstance().updateAsync<PersistedAutonomyState>(
          STORAGE_KEY,
          (current) => {
            canonical = undefined;
            admitted = false;
            if (!current || (current.policyVersion ?? 1) < AUTONOMY_POLICY_VERSION)
              return undefined;
            const decisions = Array.isArray(current.decisions) ? current.decisions : [];
            const existing =
              decisions.find((entry) => entry.id === candidate.id) ||
              decisions.find(
                (entry) =>
                  entry.workspaceId === candidate.workspaceId &&
                  Boolean(candidate.fingerprint) &&
                  entry.fingerprint === candidate.fingerprint &&
                  entry.status !== "dismissed" &&
                  entry.status !== "done" &&
                  (entry.cooldownUntil || candidate.createdAt) >= candidate.createdAt,
              );
            canonical = existing || candidate;
            if (canonical.workspaceId !== candidate.workspaceId) {
              canonical = undefined;
              return undefined;
            }
            if (
              current.config?.enabled !== true ||
              current.config.actionPolicies?.[canonical.actionType]?.level !== "execute_local" ||
              canonical.status !== "pending"
            )
              return undefined;
            admitted = true;
            if (existing) return undefined;
            return { ...current, decisions: [candidate, ...decisions].slice(0, 120) };
          },
        );
      if (!result.value || result.revision === null) return false;
      if ((result.value.policyVersion ?? 1) < AUTONOMY_POLICY_VERSION) return false;
      this.adoptSavedDispatchState(result.value);
      if (!canonical) return false;
      Object.assign(decision, structuredClone(canonical));
      this.state.decisions = this.state.decisions.filter(
        (entry) => entry === decision || entry.id !== decision.id,
      );
      return (
        admitted &&
        result.value.decisions.some((entry) => entry.id === decision.id) &&
        this.state.config.enabled &&
        decision.status === "pending" &&
        this.canExecuteLocally(decision.actionType)
      );
    } catch (error) {
      this.deps.log?.(
        "Autonomy dispatch checkpoint failed; work was not admitted",
        decision.id,
        error,
      );
      return false;
    }
  }

  private dispatchDecisionCurrent(decision: AutonomyDecision): boolean {
    try {
      if (!SecureSettingsRepository.isInitialized()) return false;
      const current =
        SecureSettingsRepository.getInstance().load<PersistedAutonomyState>(STORAGE_KEY);
      if (!current || (current.policyVersion ?? 1) < AUTONOMY_POLICY_VERSION) return false;
      const saved = current.decisions?.find((entry) => entry.id === decision.id);
      const unchanged = Boolean(saved) && JSON.stringify(saved) === JSON.stringify(decision);
      this.adoptSavedDispatchState(current);
      if (saved?.workspaceId === decision.workspaceId)
        Object.assign(decision, structuredClone(saved));
      return (
        unchanged &&
        this.state.config.enabled &&
        decision.status === "pending" &&
        this.canExecuteLocally(decision.actionType)
      );
    } catch (error) {
      this.deps.log?.("Autonomy dispatch authority could not be revalidated", decision.id, error);
      return false;
    }
  }

  private async executePendingDecisions(workspaceId: string): Promise<void> {
    const pending = this.state.decisions
      .filter((decision) => decision.workspaceId === workspaceId && decision.status === "pending")
      .slice(0, 3);
    if (pending.length === 0) return;

    if (this.deps.hasActiveManualTask?.(workspaceId)) {
      const now = Date.now();
      for (const decision of pending) {
        decision.status = "suggested";
        decision.updatedAt = now;
      }
      this.markDirty();
      this.deps.log?.(
        "Skipped local autonomy execution because a manual task is already active in this workspace",
        { workspaceId, decisionIds: pending.map((decision) => decision.id) },
      );
      return;
    }

    const budget = this.deps.dispatchBudget || getBackgroundDispatchBudget();
    for (const decision of pending) {
      if (decision.status !== "pending") continue;
      this.markDirty();
      if (!this.canExecuteLocally(decision.actionType)) {
        decision.status = "suggested";
        decision.updatedAt = Date.now();
        continue;
      }
      if (!this.deps.createTask) {
        decision.status = "suggested";
        decision.updatedAt = Date.now();
        continue;
      }
      if (!(await this.checkpointDispatchDecision(decision))) continue;
      // Task creation shares the background dispatch budget with Heartbeat, Workflow
      // Intelligence and the Strategic Planner; over budget, the decision stays a suggestion.
      const grant = decision.workspaceId
        ? await budget.tryConsume({
            workspaceId: decision.workspaceId,
            source: "autonomy",
            occurrenceKey: `autonomy:decision:${decision.id}`,
            entityKey: decision.entityKey || decision.fingerprint,
          })
        : undefined;
      if (grant && !grant.allowed) {
        decision.status = "suggested";
        decision.updatedAt = Date.now();
        this.markDirty();
        this.deps.log?.("Autonomy task creation deferred by the shared dispatch budget", {
          decisionId: decision.id,
          reason: grant.reason,
        });
        continue;
      }
      if (!this.dispatchDecisionCurrent(decision)) {
        await budget.refund(grant?.ticket);
        continue;
      }
      const action = await this.executeDecision(
        decision,
        grant?.durable ? grant.ticket : undefined,
      );
      if (action.status !== "success") await budget.refund(grant?.ticket);
      this.state.actions.unshift(action);
      this.state.actions = this.state.actions.slice(0, MAX_ACTIONS);
      this.markDirty();
    }
  }

  private buildActionMetadata(decision: AutonomyDecision): Record<string, unknown> | undefined {
    if (!decision.routineId) return undefined;
    return { routineId: decision.routineId };
  }

  private async executeDecision(
    decision: AutonomyDecision,
    backgroundDispatchTicket?: string,
  ): Promise<AutonomyAction> {
    const createdAt = Date.now();
    const metadata = this.buildActionMetadata(decision);
    if (!decision.workspaceId) {
      decision.status = "suggested";
      decision.updatedAt = createdAt;
      return {
        id: randomUUID(),
        decisionId: decision.id,
        actionType: decision.actionType,
        workspaceId: "",
        status: "skipped",
        summary: "Skipped execution because no workspace was available.",
        createdAt,
        metadata,
      };
    }

    try {
      if (!this.deps.createTask) throw new Error("Autonomy task execution is unavailable");
      const task = await this.deps.createTask(
        decision.workspaceId,
        decision.suggestedTaskTitle || decision.title,
        decision.suggestedPrompt || decision.description,
        ...(backgroundDispatchTicket ? [{ backgroundDispatchTicket }] : []),
      );
      if (!task?.id?.trim()) throw new Error("Autonomy task executor returned no task identity");
      decision.status = "executed";
      decision.updatedAt = createdAt;
      this.deps.recordActivity?.({
        workspaceId: decision.workspaceId,
        title: decision.title,
        description: `Chief-of-staff action executed: ${decision.actionType}`,
        metadata: {
          decisionId: decision.id,
          actionType: decision.actionType,
          ...(decision.routineId ? { routineId: decision.routineId } : {}),
        },
      });
      this.state.outcomes.unshift({
        id: randomUUID(),
        actionId: decision.id,
        decisionId: decision.id,
        workspaceId: decision.workspaceId,
        outcome: "succeeded",
        summary: `Executed local action for decision: ${decision.title}`,
        createdAt,
      });
      this.state.outcomes = this.state.outcomes.slice(0, MAX_OUTCOMES);
      return {
        id: randomUUID(),
        decisionId: decision.id,
        workspaceId: decision.workspaceId,
        actionType: decision.actionType,
        status: "success",
        summary: `Created internal task for: ${decision.title}`,
        createdAt,
        metadata,
      };
    } catch (error) {
      decision.status = "suggested";
      decision.updatedAt = createdAt;
      this.state.outcomes.unshift({
        id: randomUUID(),
        actionId: decision.id,
        decisionId: decision.id,
        workspaceId: decision.workspaceId,
        outcome: "failed",
        summary: `Local action failed for decision: ${decision.title}`,
        createdAt,
      });
      this.state.outcomes = this.state.outcomes.slice(0, MAX_OUTCOMES);
      return {
        id: randomUUID(),
        decisionId: decision.id,
        workspaceId: decision.workspaceId,
        actionType: decision.actionType,
        status: "failed",
        summary: error instanceof Error ? error.message : "Local action execution failed.",
        createdAt,
        metadata,
      };
    }
  }

  private canExecuteLocally(actionType: ChiefOfStaffActionType): boolean {
    const policy = this.state.config.actionPolicies[actionType];
    return policy.level === "execute_local";
  }

  private hasActiveDecisionFingerprint(fingerprint: string, now: number): boolean {
    return this.state.decisions.some(
      (decision) =>
        decision.fingerprint === fingerprint &&
        decision.status !== "dismissed" &&
        decision.status !== "done" &&
        (decision.cooldownUntil || now) >= now,
    );
  }

  private isRoutineReady(routine: RoutineState, now: number): boolean {
    const lastExecutedAt = routine.lastExecutedAt || 0;
    return !lastExecutedAt || now - lastExecutedAt >= routine.cooldownMinutes * 60_000;
  }

  private findLastExecutedAt(routineId: string): number | undefined {
    const action = this.state.actions.find(
      (entry) =>
        entry.metadata?.routineId === routineId &&
        entry.status === "success" &&
        typeof entry.createdAt === "number",
    );
    return action?.createdAt;
  }

  private dedupeByTitle<T extends { title?: string; name?: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    const output: T[] = [];
    for (const item of items) {
      const label = String(item.title || item.name || "")
        .trim()
        .toLowerCase();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      output.push(item);
    }
    return output;
  }

  private pruneDecisions(): void {
    const now = Date.now();
    const before = this.state.decisions.length;
    this.state.decisions = this.state.decisions
      .filter((decision) => now - decision.createdAt <= 7 * 24 * 60 * 60 * 1000)
      .slice(0, 120);
    if (this.state.decisions.length !== before) this.markDirty();
  }
}

export function getAutonomyEngine(): AutonomyEngine {
  return AutonomyEngine.getInstance();
}
