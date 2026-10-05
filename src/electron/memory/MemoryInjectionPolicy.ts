/**
 * MemoryInjectionPolicy (docs/memory-engine.md §4, audit §8.2): the one decision about which
 * memory may reach a prompt. Every injection site (pinned profile block, step/follow-up/
 * planning/chat prompts, awareness snapshot, external provider, shared kit context, project
 * guidance) asks this policy instead of re-deriving `retainMemory && gateway` on its own.
 *
 * `resolveMemoryInjection` is pure and synchronous; `DefaultMemoryInjectionPolicy` implements
 * the async contract in memory-engine-contracts.ts on top of it.
 */
import type { GatewayContextType, WorkerRoleKind } from "../../shared/types";
import type {
  MemoryInjectionContext,
  MemoryInjectionDecision,
  MemoryInjectionPolicy,
} from "./memory-engine-contracts";
import type { MemoryItem } from "./memory-items-types";
import { containsNoMemoryDirective, taskDisablesMemoryCapture } from "./no-memory-directive";

/**
 * Prompt layers the policy rules on.
 * - `l0`: identity, rules, pinned preferences, open commitments (memory_items, user-owned).
 * - `l1`: task-relevant memory (memory_items recall, archive recall, playbook, summaries,
 *   awareness snapshot).
 * - `external`: an external memory provider (Supermemory) profile/search block.
 * - `sharedContext`: the pinned `.cowork` PRIORITIES / CROSS_SIGNALS / MISTAKES block.
 * - `workspaceKit`: the `.cowork` kit slice of the memory section (USER.md, MEMORY.md, …).
 * - `projectGuidance`: repo-root AGENTS.md / CLAUDE.md and docs maps.
 * - `memoryRepo`: the `<cowork_memory_repo>` block (the user's memory folder: MEMORY.md and the
 *   workspace's file; docs/memory-repo-phase1-design.md §6.2).
 */
export type MemoryLayer =
  | "l0"
  | "l1"
  | "external"
  | "sharedContext"
  | "workspaceKit"
  | "projectGuidance"
  | "memoryRepo";

export const MEMORY_LAYERS: readonly MemoryLayer[] = [
  "l0",
  "l1",
  "external",
  "sharedContext",
  "workspaceKit",
  "projectGuidance",
  "memoryRepo",
];

export type MemoryPrivacyMode = "normal" | "strict" | "disabled";

export interface MemoryInjectionPolicyInput {
  /** `agentConfig.retainMemory`; undefined means the default for the task kind. */
  retainMemory?: boolean;
  /** Child task (`agentType === "sub"` or a parent task id): memory is off by default. */
  isSubAgent?: boolean;
  /** Internal worker role; verifiers never receive personal memory. */
  workerRole?: WorkerRoleKind | null;
  gatewayContext?: GatewayContextType;
  /** Group/public contexts trusted with shared memory. */
  allowSharedContextMemory?: boolean;
  /** Per-workspace memory settings; null/undefined when unavailable (treated as on). */
  workspaceSettings?: { enabled: boolean; privacyMode?: MemoryPrivacyMode } | null;
  /** Global "curated memory" feature switch (MemoryFeaturesManager). */
  curatedMemoryEnabled?: boolean;
  /** Global "context pack" switch for kit/shared-context/project-guidance injection. */
  contextPackInjectionEnabled?: boolean;
  /** The task or the current message carries `<no-memory>`. */
  noMemory?: boolean;
  /** Workspace read permission (file-backed layers only). */
  workspaceCanRead?: boolean;
  /** The workspace may reach the network without approval (external providers). */
  externalNetworkAllowed?: boolean;
  /** The memory folder setting (`memoryRepoEnabled`) is on and the repo service is ready. */
  memoryRepoEnabled?: boolean;
}

export interface MemoryLayerDecision {
  /** True when any memory layer (l0/l1/external) is allowed. */
  memory: boolean;
  layers: Record<MemoryLayer, boolean>;
  /** Why a layer is off (first reason wins), for diagnostics and the "memory used" view. */
  reasons: Partial<Record<MemoryLayer, MemoryInjectionDecision["reason"]>>;
  /** Private items (strict privacy mode, private notes) may be injected. */
  allowPrivateItems: boolean;
  /** Curated items (Memory Hub, kit files, distilled promotions) may be injected. */
  allowCuratedItems: boolean;
  gatewayContext: GatewayContextType;
}

function allOff(): Record<MemoryLayer, boolean> {
  return {
    l0: false,
    l1: false,
    external: false,
    sharedContext: false,
    workspaceKit: false,
    projectGuidance: false,
    memoryRepo: false,
  };
}

/** The one rule set. Pure: every input is passed in. */
export function resolveMemoryInjection(input: MemoryInjectionPolicyInput): MemoryLayerDecision {
  const gatewayContext: GatewayContextType = input.gatewayContext ?? "private";
  const isPrivateGateway = gatewayContext === "private";
  const trustedShared =
    input.allowSharedContextMemory === true &&
    (gatewayContext === "group" || gatewayContext === "public");
  const retainMemory = input.retainMemory ?? !input.isSubAgent;
  const isVerifier = input.workerRole === "verifier";
  const settings = input.workspaceSettings;
  const memoryOff =
    !!settings && (settings.enabled === false || settings.privacyMode === "disabled");
  const contextPack = input.contextPackInjectionEnabled !== false;
  const canRead = input.workspaceCanRead !== false;

  const layers = allOff();
  const reasons: MemoryLayerDecision["reasons"] = {};
  const deny = (layer: MemoryLayer, reason: MemoryInjectionDecision["reason"]) => {
    layers[layer] = false;
    if (!reasons[layer]) reasons[layer] = reason;
  };

  // Memory layers (database-backed, personal).
  let memoryReason: MemoryInjectionDecision["reason"] | undefined;
  if (input.noMemory) memoryReason = "no_memory_directive";
  else if (!retainMemory || isVerifier) memoryReason = "scope_mismatch";
  else if (!isPrivateGateway && !trustedShared) memoryReason = "group_channel";
  else if (memoryOff) memoryReason = "memory_off";
  for (const layer of ["l0", "l1", "external"] as const) {
    if (memoryReason) deny(layer, memoryReason);
    else layers[layer] = true;
  }
  if (layers.external && input.externalNetworkAllowed === false) {
    deny("external", "read_only_denied");
  }

  // File-backed layers. The shared `.cowork` context follows the memory gate's channel
  // rule and `<no-memory>`, but not the workspace memory switch (it is a file, not the DB).
  if (input.noMemory) deny("sharedContext", "no_memory_directive");
  else if (!contextPack || !canRead) deny("sharedContext", "read_only_denied");
  else if (!retainMemory || isVerifier) deny("sharedContext", "scope_mismatch");
  else if (!isPrivateGateway && !trustedShared) deny("sharedContext", "group_channel");
  else layers.sharedContext = true;

  // The kit slice carries USER.md / MEMORY.md (personal) and is private-gateway only.
  if (input.noMemory) deny("workspaceKit", "no_memory_directive");
  else if (!contextPack || !canRead) deny("workspaceKit", "read_only_denied");
  else if (!layers.l0) deny("workspaceKit", reasons.l0 ?? "scope_mismatch");
  else if (!isPrivateGateway) deny("workspaceKit", "group_channel");
  else layers.workspaceKit = true;

  // Repo instructions are not memory: private gateway, context pack and read access only.
  if (!contextPack || !canRead) deny("projectGuidance", "read_only_denied");
  else if (!isPrivateGateway) deny("projectGuidance", "group_channel");
  else layers.projectGuidance = true;

  // The memory folder is personal and spans workspaces: private gateway only (never group or
  // public, even with trusted shared context), never a sub-agent or verifier, and off with the
  // workspace memory switch. It lives outside the workspace, so read access does not matter.
  if (input.noMemory) deny("memoryRepo", "no_memory_directive");
  else if (input.memoryRepoEnabled !== true) deny("memoryRepo", "memory_off");
  else if (!retainMemory || input.isSubAgent || isVerifier) deny("memoryRepo", "scope_mismatch");
  else if (!isPrivateGateway) deny("memoryRepo", "group_channel");
  else if (memoryOff) deny("memoryRepo", "memory_off");
  else layers.memoryRepo = true;

  const memory = layers.l0 || layers.l1 || layers.external;
  return {
    memory,
    layers,
    reasons,
    // Private items only reach the user's own private conversation, never a sub-agent.
    allowPrivateItems: memory && isPrivateGateway && !input.isSubAgent,
    allowCuratedItems: input.curatedMemoryEnabled !== false,
    gatewayContext,
  };
}

/** Task fields the policy reads. */
export interface MemoryPolicyTaskShape {
  agentType?: string;
  parentTaskId?: string;
  workerRole?: WorkerRoleKind;
  prompt?: string | null;
  rawPrompt?: string | null;
  userPrompt?: string | null;
  agentConfig?: {
    retainMemory?: boolean;
    gatewayContext?: GatewayContextType;
    allowSharedContextMemory?: boolean;
  };
}

export function isSubAgentTaskShape(task: MemoryPolicyTaskShape | null | undefined): boolean {
  return (task?.agentType ?? "main") === "sub" || !!task?.parentTaskId;
}

/** The task-derived half of the policy input; callers add settings and permissions. */
export function memoryPolicyInputForTask(
  task: MemoryPolicyTaskShape | null | undefined,
  extras: Omit<
    MemoryInjectionPolicyInput,
    | "retainMemory"
    | "isSubAgent"
    | "workerRole"
    | "gatewayContext"
    | "allowSharedContextMemory"
    | "noMemory"
  > & { message?: string | null } = {},
): MemoryInjectionPolicyInput {
  const { message, ...rest } = extras;
  return {
    ...rest,
    retainMemory: task?.agentConfig?.retainMemory,
    isSubAgent: isSubAgentTaskShape(task),
    workerRole: task?.workerRole ?? null,
    gatewayContext: task?.agentConfig?.gatewayContext,
    allowSharedContextMemory: task?.agentConfig?.allowSharedContextMemory === true,
    noMemory: taskDisablesMemoryCapture(task) || containsNoMemoryDirective(message),
  };
}

/**
 * Whether one memory item may be injected under a decision. User-owned scopes only:
 * third-party / contact text is never injected unless the surface handles that contact,
 * private items only where the decision allows them.
 */
export function memoryItemAllowed(
  item: Pick<MemoryItem, "scope" | "scopeRef" | "source" | "privacy" | "status" | "workspaceId">,
  decision: MemoryLayerDecision,
  context: { workspaceId?: string | null; contactRef?: string; taskId?: string } = {},
): MemoryInjectionDecision {
  if (!decision.memory) return { allowed: false, reason: decision.reasons.l0 ?? "memory_off" };
  if (item.status !== "active") return { allowed: false, reason: "scope_mismatch" };
  if (item.privacy === "private" && !decision.allowPrivateItems) {
    return { allowed: false, reason: "private_item" };
  }
  if (item.scope === "contact") {
    if (!context.contactRef || item.scopeRef !== context.contactRef) {
      return { allowed: false, reason: "third_party_item" };
    }
    return { allowed: true };
  }
  if (item.source === "third_party") return { allowed: false, reason: "third_party_item" };
  if (item.scope === "task" && (!context.taskId || item.scopeRef !== context.taskId)) {
    return { allowed: false, reason: "scope_mismatch" };
  }
  if (
    item.workspaceId &&
    context.workspaceId !== undefined &&
    item.workspaceId !== context.workspaceId
  ) {
    return { allowed: false, reason: "scope_mismatch" };
  }
  if (item.source === "curated" && !decision.allowCuratedItems) {
    return { allowed: false, reason: "memory_off" };
  }
  return { allowed: true };
}

/** Surface → gateway mapping for callers that only know the contract's surface. */
function gatewayOfSurface(surface: MemoryInjectionContext["surface"]): GatewayContextType {
  return surface === "channel_group" ? "group" : "private";
}

export interface DefaultMemoryInjectionPolicyDeps {
  loadWorkspaceSettings?: (
    workspaceId: string,
  ) => Promise<{ enabled: boolean; privacyMode?: MemoryPrivacyMode } | null>;
  curatedMemoryEnabled?: () => boolean;
}

/**
 * The contract implementation (memory-engine-contracts.ts) for callers that think in
 * surfaces (tools, Memory Hub, channels). Prompt builders use `resolveMemoryInjection`
 * with the full task input.
 */
export class DefaultMemoryInjectionPolicy implements MemoryInjectionPolicy {
  constructor(private readonly deps: DefaultMemoryInjectionPolicyDeps = {}) {}

  async resolve(context: MemoryInjectionContext): Promise<MemoryLayerDecision> {
    let workspaceSettings: MemoryInjectionPolicyInput["workspaceSettings"] = null;
    if (context.workspaceId && this.deps.loadWorkspaceSettings) {
      try {
        workspaceSettings = await this.deps.loadWorkspaceSettings(context.workspaceId);
      } catch {
        workspaceSettings = null;
      }
    }
    return resolveMemoryInjection({
      gatewayContext: gatewayOfSurface(context.surface),
      workspaceSettings,
      noMemory: context.noMemory,
      curatedMemoryEnabled: this.deps.curatedMemoryEnabled?.() ?? true,
    });
  }

  async surfaceAllowed(context: MemoryInjectionContext): Promise<MemoryInjectionDecision> {
    const decision = await this.resolve(context);
    return decision.memory
      ? { allowed: true }
      : { allowed: false, reason: decision.reasons.l0 ?? "memory_off" };
  }

  itemAllowed(item: MemoryItem, context: MemoryInjectionContext): MemoryInjectionDecision {
    if (context.noMemory) return { allowed: false, reason: "no_memory_directive" };
    if (context.surface === "channel_group") return { allowed: false, reason: "group_channel" };
    const decision = resolveMemoryInjection({ gatewayContext: gatewayOfSurface(context.surface) });
    return memoryItemAllowed(item, decision, {
      workspaceId: context.workspaceId,
      contactRef: context.contactRef,
      taskId: context.taskId,
    });
  }
}
