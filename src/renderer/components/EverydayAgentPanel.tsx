import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Bot,
  CheckCircle2,
  CircleDot,
  Clock,
  Database,
  Eye,
  FileClock,
  KeyRound,
  PauseCircle,
  Play,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  EVERYDAY_AGENT_CAPABILITY_BUNDLES,
  EVERYDAY_AGENT_CONSENT_VERSION,
  type EverydayActionPreview,
  type EverydayActionReceipt,
  type EverydayActionRisk,
  type EverydayAgentProfileResult,
  type EverydayCapabilityBundle,
  type EverydayPauseScope,
  type ProactiveSuggestion,
  type Workspace,
} from "../../shared/types";
import "./everyday-agent.css";

interface EverydayAgentPanelProps {
  workspace?: Workspace | null;
  settingsMode?: boolean;
  onOpenSettings?: () => void;
  onOpenMissionControl?: () => void;
  onCreateTask?: (title: string, prompt: string) => void;
}

type PauseKind = EverydayPauseScope["kind"];
type PriorityTone = "danger" | "warn" | "quiet" | "success";
type EverydayAgentStatus = "loading" | "enabled" | "paused" | "disabled" | "blocked";
export type EverydayAgentTemporaryModes = {
  noMemory: boolean;
  disposableBrowser: boolean;
  readOnly: boolean;
};

export interface EverydayAgentPriorityItem {
  id: string;
  title: string;
  detail: string;
  tone: PriorityTone;
  meta?: string;
  actionKind?: "settings" | "resume" | "memory" | "receipt" | "suggestion" | "preview";
}

interface EverydayRoutineSummary {
  id: string;
  name: string;
  detail: string;
  status: string;
  tone: PriorityTone;
  enabled: boolean;
  lastRunAt?: number;
}

export interface EverydayAgentPlanStep {
  id: string;
  title: string;
  detail: string;
  capability: EverydayCapabilityBundle;
  riskClass: EverydayActionRisk;
  posture: "read_only" | "preview" | "approval" | "trusted" | "blocked";
}

export interface EverydayAgentRecoveryItem {
  id: string;
  title: string;
  detail: string;
  actionLabel: string;
  tone: PriorityTone;
}

export function updateEverydayAgentTemporaryMode(
  current: EverydayAgentTemporaryModes,
  mode: keyof EverydayAgentTemporaryModes,
  checked: boolean,
): EverydayAgentTemporaryModes {
  return {
    ...current,
    [mode]: checked,
  };
}

interface EverydayAgentRecipe {
  id: string;
  title: string;
  description: string;
  capability: EverydayCapabilityBundle;
  riskClass: EverydayActionRisk;
  surfaces: string[];
  prompt: string;
}

interface EverydaySecureLane {
  id: string;
  title: string;
  description: string;
  capability: EverydayCapabilityBundle;
  status: "available" | "disabled" | "restricted";
}

const RISK_LABELS: Record<EverydayActionRisk, string> = {
  read: "Read",
  draft: "Draft",
  stage: "Stage",
  execute_low_risk: "Low-risk execution",
  execute_sensitive: "Sensitive execution",
  destructive: "Destructive",
  data_export: "Data export",
  spend: "Spend",
  credential_sensitive: "Credential-sensitive",
};

const PAUSE_KINDS: PauseKind[] = [
  "global",
  "capability",
  "connector",
  "workspace",
  "device",
  "channel",
];

const EVERYDAY_AGENT_RECIPES: EverydayAgentRecipe[] = [
  {
    id: "daily-inbox-triage",
    title: "Daily inbox triage",
    description: "Group urgent mail, draft replies, and stage follow-up tasks.",
    capability: "inbox",
    riskClass: "execute_sensitive",
    surfaces: ["Inbox Agent", "Home", "Receipts"],
    prompt: "Run a review-first inbox triage and preview any drafts before sending.",
  },
  {
    id: "meeting-prep",
    title: "Meeting prep brief",
    description: "Build a calendar brief from approved docs, email, and recent tasks.",
    capability: "calendar",
    riskClass: "data_export",
    surfaces: ["Calendar", "Docs", "Memory"],
    prompt: "Prepare a meeting brief using approved sources and cite the evidence used.",
  },
  {
    id: "follow-up-detector",
    title: "Follow-up detector",
    description: "Find promised next steps and turn them into reviewable suggestions.",
    capability: "automations",
    riskClass: "stage",
    surfaces: ["Workflow Intelligence", "Routines"],
    prompt: "Detect open follow-ups and preview a trusted routine candidate.",
  },
  {
    id: "weekly-status-draft",
    title: "Weekly status draft",
    description: "Summarize completed work, blockers, and next actions for review.",
    capability: "docs",
    riskClass: "draft",
    surfaces: ["Docs", "Mission Control"],
    prompt: "Draft a weekly status update with source-backed bullets and no external posting.",
  },
];

export function isEverydayAgentUuid(value: string | undefined): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  );
}

function formatTime(value?: number): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function capabilityLabel(capability: EverydayCapabilityBundle): string {
  return (
    EVERYDAY_AGENT_CAPABILITY_BUNDLES.find((bundle) => bundle.id === capability)?.label ||
    capability
  );
}

export function getEverydayAgentStatus(
  result: EverydayAgentProfileResult | null,
): EverydayAgentStatus {
  if (!result) return "loading";
  if (result.compiledPolicy.adminPolicy.blocked) return "blocked";
  if (!result.profile.enabled) return "disabled";
  if (!result.compiledPolicy.enabled) return "paused";
  return "enabled";
}

function statusLabel(result: EverydayAgentProfileResult | null): string {
  const status = getEverydayAgentStatus(result);
  if (status === "blocked") return "Blocked by admin";
  if (status === "disabled") return "Disabled";
  if (status === "paused") return "Paused";
  if (status === "enabled") return "Enabled";
  return "Loading";
}

export function isEverydayAgentConsentRequired(
  result: EverydayAgentProfileResult | null,
): boolean {
  if (!result) return false;
  const declinedCurrentConsent =
    (result.profile.declinedConsentVersion ?? 0) >= EVERYDAY_AGENT_CONSENT_VERSION;
  return (
    !declinedCurrentConsent &&
    result.profile.acceptedConsentVersion < EVERYDAY_AGENT_CONSENT_VERSION
  );
}

function riskTone(risk: EverydayActionRisk): "quiet" | "warn" | "danger" {
  if (risk === "destructive" || risk === "spend" || risk === "credential_sensitive") {
    return "danger";
  }
  if (risk === "execute_sensitive" || risk === "data_export") return "warn";
  return "quiet";
}

function receiptTone(status: EverydayActionReceipt["status"]): PriorityTone {
  if (status === "blocked" || status === "failed") return "danger";
  if (status === "paused" || status === "previewed") return "warn";
  return "quiet";
}

function suggestionDescription(suggestion: ProactiveSuggestion): string {
  return suggestion.actionPrompt || suggestion.description || "Review suggested next action";
}

function inferSuggestionCapability(suggestion: ProactiveSuggestion): EverydayCapabilityBundle {
  const haystack =
    `${suggestion.title} ${suggestion.description} ${suggestion.actionPrompt || ""} ${suggestion.sourceEntity || ""}`.toLowerCase();
  if (haystack.includes("mail") || haystack.includes("inbox")) return "inbox";
  if (haystack.includes("calendar") || haystack.includes("meeting")) return "calendar";
  if (haystack.includes("browser") || haystack.includes("web")) return "browser";
  if (haystack.includes("file")) return "files";
  if (haystack.includes("doc")) return "docs";
  if (haystack.includes("message") || haystack.includes("slack")) return "messages";
  if (haystack.includes("github") || haystack.includes("pull request")) return "github_work";
  if (haystack.includes("memory")) return "memory";
  if (haystack.includes("device")) return "remote_devices";
  return "automations";
}

function previewTargetLabel(preview: EverydayActionPreview): string {
  return (
    preview.target.connectorAccountId ||
    preview.target.destination ||
    preview.target.targetIdentity ||
    preview.target.channelId ||
    preview.target.deviceId ||
    preview.target.browserProfileId ||
    preview.target.workspaceId ||
    "Scoped target"
  );
}

export function buildEverydayAgentPriorityItems({
  result,
  receipts,
  suggestions,
  memoryCandidateCount,
  preview,
}: {
  result: EverydayAgentProfileResult | null;
  receipts: EverydayActionReceipt[];
  suggestions: ProactiveSuggestion[];
  memoryCandidateCount: number | null;
  preview?: EverydayActionPreview | null;
}): EverydayAgentPriorityItem[] {
  const items: EverydayAgentPriorityItem[] = [];
  const status = getEverydayAgentStatus(result);

  if (status === "blocked") {
    items.push({
      id: "admin-blocked",
      title: "Everyday Agent is blocked",
      detail: "Organization policy is preventing all Everyday Agent work.",
      tone: "danger",
      actionKind: "settings",
    });
  } else if (status === "disabled") {
    items.push({
      id: "disabled",
      title: "Enable required before work can start",
      detail: "Review consent and capability scopes before the agent watches signals.",
      tone: "warn",
      actionKind: "settings",
    });
  } else if (status === "paused") {
    items.push({
      id: "paused",
      title: "Everyday Agent is paused",
      detail: "No new work will begin until active pause scopes are cleared.",
      tone: "warn",
      actionKind: "resume",
    });
  }

  if (preview && (preview.status === "pending" || preview.status === "blocked")) {
    items.push({
      id: `preview-${preview.id}`,
      title: preview.status === "blocked" ? "Preview is blocked" : "Action preview needs approval",
      detail: preview.proposedMutation,
      tone: preview.status === "blocked" ? "danger" : "warn",
      meta: RISK_LABELS[preview.riskClass],
      actionKind: "preview",
    });
  }

  receipts
    .filter((receipt) =>
      ["blocked", "failed", "paused", "previewed"].includes(receipt.status),
    )
    .slice(0, 3)
    .forEach((receipt) => {
      items.push({
        id: `receipt-${receipt.id}`,
        title: receipt.title,
        detail: receipt.summary,
        tone: receiptTone(receipt.status),
        meta: `${receipt.status} - ${capabilityLabel(receipt.capability)}`,
        actionKind: "receipt",
      });
    });

  if (memoryCandidateCount && memoryCandidateCount > 0) {
    items.push({
      id: "memory-review",
      title: `${memoryCandidateCount} memory candidates need review`,
      detail: "Review-first memory is waiting for approval before it becomes prompt-visible.",
      tone: "quiet",
      actionKind: "memory",
    });
  }

  suggestions
    .filter((suggestion) => !suggestion.dismissed && !suggestion.actedOn)
    .slice(0, 2)
    .forEach((suggestion) => {
      items.push({
        id: `suggestion-${suggestion.id}`,
        title: suggestion.title,
        detail: suggestionDescription(suggestion),
        tone: suggestion.urgency === "high" ? "warn" : "quiet",
        meta: suggestion.urgency,
        actionKind: "suggestion",
      });
    });

  if (items.length === 0) {
    items.push({
      id: "clear",
      title: "No approvals or failures waiting",
      detail: "Idle, watching approved signals and trusted routines.",
      tone: "success",
    });
  }

  return items.slice(0, 7);
}

export function classifyEverydayAgentRecovery(
  receipt: EverydayActionReceipt,
): EverydayAgentRecoveryItem | null {
  if (!["blocked", "failed", "paused"].includes(receipt.status)) return null;
  const text = `${receipt.title} ${receipt.summary} ${receipt.retryState?.lastError || ""}`.toLowerCase();

  if (text.includes("oauth") || text.includes("auth") || text.includes("scope")) {
    return {
      id: `recovery-${receipt.id}`,
      title: "Connector access needs repair",
      detail: receipt.retryState?.lastError || receipt.summary,
      actionLabel: "Reconnect app",
      tone: "warn",
    };
  }
  if (text.includes("network") || text.includes("timeout") || text.includes("offline")) {
    return {
      id: `recovery-${receipt.id}`,
      title: "Network interruption",
      detail: "Retry as a dry-run first so duplicate side effects stay blocked.",
      actionLabel: "Retry dry-run",
      tone: "warn",
    };
  }
  if (text.includes("duplicate") || text.includes("idempotency")) {
    return {
      id: `recovery-${receipt.id}`,
      title: "Possible duplicate side effect",
      detail: `Review external IDs and idempotency key ${receipt.idempotencyKey}.`,
      actionLabel: "Review receipt",
      tone: "danger",
    };
  }
  if (text.includes("policy") || receipt.status === "blocked") {
    return {
      id: `recovery-${receipt.id}`,
      title: "Policy blocked action",
      detail: receipt.summary,
      actionLabel: "Open policy",
      tone: "danger",
    };
  }
  return {
    id: `recovery-${receipt.id}`,
    title: "Recoverable action failure",
    detail: receipt.retryState?.lastError || receipt.summary,
    actionLabel: "Review and retry",
    tone: "warn",
  };
}

export function buildEverydayAgentPlanSteps({
  status,
  busy,
  preview,
  suggestions,
  receipts,
}: {
  status: EverydayAgentStatus;
  busy: string | null;
  preview: EverydayActionPreview | null;
  suggestions: ProactiveSuggestion[];
  receipts: EverydayActionReceipt[];
}): EverydayAgentPlanStep[] {
  if (status === "blocked") {
    return [
      {
        id: "blocked",
        title: "Stop before work starts",
        detail: "Admin policy blocks this operator surface.",
        capability: "automations",
        riskClass: "read",
        posture: "blocked",
      },
    ];
  }

  const firstSuggestion = suggestions.find((suggestion) => !suggestion.dismissed && !suggestion.actedOn);
  const firstReceipt = receipts[0];
  const targetCapability =
    preview?.capability ||
    (firstSuggestion ? inferSuggestionCapability(firstSuggestion) : firstReceipt?.capability) ||
    "automations";
  const targetRisk = preview?.riskClass || firstReceipt?.riskClass || "stage";

  return [
    {
      id: "collect",
      title: busy || "Watch approved signals",
      detail: "Read-only evidence collection from enabled capabilities.",
      capability: targetCapability,
      riskClass: "read",
      posture: "read_only",
    },
    {
      id: "compose",
      title: preview ? "Review proposed mutation" : firstSuggestion ? "Shape suggested next action" : "Wait for useful work",
      detail: preview?.proposedMutation || firstSuggestion?.description || "No side effect is prepared.",
      capability: targetCapability,
      riskClass: targetRisk,
      posture: preview ? "preview" : "read_only",
    },
    {
      id: "approval",
      title: "Ask before consequential actions",
      detail: "Sends, posts, exports, credentials, spending, deletes, and cross-workspace movement require approval.",
      capability: targetCapability,
      riskClass: targetRisk,
      posture:
        targetRisk === "read" || targetRisk === "draft" || targetRisk === "stage"
          ? "preview"
          : "approval",
    },
    {
      id: "receipt",
      title: "Write receipt and learn only after review",
      detail: "Receipts stay inspectable; memory and trusted patterns remain review-first.",
      capability: "memory",
      riskClass: "stage",
      posture: "trusted",
    },
  ];
}

function buildSecureLanes(
  enabledCapabilities: EverydayCapabilityBundle[],
  connectedAppsCount: number,
  pausedScopes: EverydayPauseScope[],
): EverydaySecureLane[] {
  const hasPause = (capability: EverydayCapabilityBundle) =>
    pausedScopes.some((scope) => scope.kind === "capability" && scope.capability === capability);
  const laneFor = (
    id: string,
    title: string,
    description: string,
    capability: EverydayCapabilityBundle,
  ): EverydaySecureLane => ({
    id,
    title,
    description,
    capability,
    status: hasPause(capability)
      ? "restricted"
      : enabledCapabilities.includes(capability) || connectedAppsCount > 0
        ? "available"
        : "disabled",
  });

  return [
    laneFor("browser", "Visible browser lane", "Browser Workbench preferred; takeover pauses before side effects.", "browser"),
    laneFor("mail", "Mail lane", "Drafts and sends bind to account, destination, approval, and receipt.", "inbox"),
    laneFor("files", "Files lane", "Local files are evidence by default; deletion and export always ask first.", "files"),
    laneFor("connectors", "Connector lane", "Connected app scopes stay account-bound and revocable.", "docs"),
    laneFor("devices", "Device lane", "Remote device dispatch remains visible, pausable, and auditable.", "remote_devices"),
  ];
}

function routineTriggerSummary(routine: Any): string {
  if (Array.isArray(routine?.triggers) && routine.triggers.length > 0) {
    return routine.triggers.map((trigger: Any) => trigger.type || "trigger").join(", ");
  }
  if (routine?.trigger?.type) return routine.trigger.type;
  return "Trusted routine";
}

function routineRunFor(routineId: string, runs: Any[]): Any | undefined {
  return runs.find((run) => run.routineId === routineId);
}

function summarizeRoutine(routine: Any, latestRun?: Any): EverydayRoutineSummary {
  const enabled = routine.enabled !== false;
  const failed = latestRun?.status === "failed" || latestRun?.status === "error";
  return {
    id: String(routine.id),
    name: routine.name || "Untitled routine",
    detail: latestRun?.errorSummary || routine.description || routineTriggerSummary(routine),
    enabled,
    lastRunAt: latestRun?.finishedAt || latestRun?.startedAt,
    status: !enabled ? "Paused" : failed ? "Needs attention" : "Monitoring",
    tone: !enabled ? "quiet" : failed ? "danger" : "success",
  };
}

async function loadRoutineSummaries(
  profile: EverydayAgentProfileResult["profile"],
  workspaceId?: string,
): Promise<EverydayRoutineSummary[]> {
  const summaries: EverydayRoutineSummary[] = [];

  if (profile.managedAgentId && window.electronAPI.listManagedAgentRoutines) {
    const managedRows = await window.electronAPI
      .listManagedAgentRoutines(profile.managedAgentId)
      .catch(() => []);
    for (const row of managedRows || []) {
      summaries.push(summarizeRoutine(row));
    }
  }

  const routineRows = window.electronAPI.listRoutines
    ? await window.electronAPI.listRoutines().catch(() => [])
    : [];
  const runRows = window.electronAPI.listRoutineRuns
    ? await window.electronAPI.listRoutineRuns(undefined, 50).catch(() => [])
    : [];

  for (const routine of routineRows || []) {
    if (workspaceId && routine.workspaceId && routine.workspaceId !== workspaceId) continue;
    if (summaries.some((summary) => summary.id === String(routine.id))) continue;
    summaries.push(summarizeRoutine(routine, routineRunFor(String(routine.id), runRows || [])));
  }

  return summaries.slice(0, 5);
}

export function EverydayAgentPanel({
  workspace,
  settingsMode = false,
  onOpenSettings,
  onOpenMissionControl,
  onCreateTask,
}: EverydayAgentPanelProps) {
  const [result, setResult] = useState<EverydayAgentProfileResult | null>(null);
  const [receipts, setReceipts] = useState<EverydayActionReceipt[]>([]);
  const [suggestions, setSuggestions] = useState<ProactiveSuggestion[]>([]);
  const [routines, setRoutines] = useState<EverydayRoutineSummary[]>([]);
  const [memoryCandidateCount, setMemoryCandidateCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<EverydayActionPreview | null>(null);
  const [pauseKind, setPauseKind] = useState<PauseKind>("global");
  const [pauseTarget, setPauseTarget] = useState("");
  const [temporaryModes, setTemporaryModes] = useState<EverydayAgentTemporaryModes>({
    noMemory: false,
    disposableBrowser: true,
    readOnly: false,
  });
  const updateTemporaryMode = (mode: keyof EverydayAgentTemporaryModes, checked: boolean) => {
    setTemporaryModes((current) => updateEverydayAgentTemporaryMode(current, mode, checked));
  };
  const [previewForm, setPreviewForm] = useState({
    title: "Triage inbox follow-ups",
    action: "Draft replies and stage follow-up tasks",
    capability: "inbox" as EverydayCapabilityBundle,
    toolName: "mailbox.generateDraft",
    destination: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const profileResult = await window.electronAPI.everydayAgentGetProfile();
      setResult(profileResult);
      const [receiptRows, routineRows] = await Promise.all([
        window.electronAPI.everydayAgentListReceipts({
          profileId: profileResult.profile.id,
          workspaceId: workspace?.id,
          limit: 25,
        }),
        loadRoutineSummaries(profileResult.profile, workspace?.id),
      ]);
      setReceipts(receiptRows);
      setRoutines(routineRows);
      if (workspace?.id && window.electronAPI.listSuggestions) {
        const suggestionRows = await window.electronAPI.listSuggestions(workspace.id);
        setSuggestions((suggestionRows || []).slice(0, 8));
      } else {
        setSuggestions([]);
      }
      if (window.electronAPI.listCoreMemoryCandidates) {
        if (isEverydayAgentUuid(profileResult.profile.id) && isEverydayAgentUuid(workspace?.id)) {
          const candidates = await window.electronAPI
            .listCoreMemoryCandidates({
              profileId: profileResult.profile.id,
              workspaceId: workspace.id,
              status: "proposed",
              limit: 50,
            })
            .catch(() => []);
          setMemoryCandidateCount(candidates.length);
        } else {
          setMemoryCandidateCount(0);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Everyday Agent");
    } finally {
      setLoading(false);
    }
  }, [workspace?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const consentRequired = isEverydayAgentConsentRequired(result);
  const enabledCapabilities = result?.compiledPolicy.allowedCapabilities || [];
  const pausedScopes = result?.compiledPolicy.pausedScopes || [];
  const adminBlocked = result?.compiledPolicy.adminPolicy.blocked === true;
  const status = getEverydayAgentStatus(result);
  const canResume = Boolean(result && !adminBlocked && (status === "paused" || status === "disabled"));

  const connectedApps = useMemo(() => {
    if (!result) return [];
    return Object.values(result.profile.connectorAllowlists).filter((entry) => entry.enabled);
  }, [result]);

  const priorityItems = useMemo(
    () =>
      buildEverydayAgentPriorityItems({
        result,
        receipts,
        suggestions,
        memoryCandidateCount,
        preview,
      }),
    [memoryCandidateCount, preview, receipts, result, suggestions],
  );

  const activeSuggestions = useMemo(
    () => suggestions.filter((suggestion) => !suggestion.dismissed && !suggestion.actedOn).slice(0, 4),
    [suggestions],
  );

  const recentReceipts = receipts.slice(0, 6);
  const recoveryItems = useMemo(
    () =>
      receipts
        .map((receipt) => classifyEverydayAgentRecovery(receipt))
        .filter((item): item is EverydayAgentRecoveryItem => Boolean(item))
        .slice(0, 4),
    [receipts],
  );
  const planSteps = useMemo(
    () =>
      buildEverydayAgentPlanSteps({
        status,
        busy,
        preview,
        suggestions,
        receipts,
      }),
    [busy, preview, receipts, status, suggestions],
  );
  const secureLanes = useMemo(
    () => buildSecureLanes(enabledCapabilities, connectedApps.length, pausedScopes),
    [connectedApps.length, enabledCapabilities, pausedScopes],
  );

  const run = async <T,>(label: string, action: () => Promise<T>): Promise<T | null> => {
    setBusy(label);
    setError(null);
    try {
      const value = await action();
      await load();
      return value;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${label}`);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const updateCapability = (capability: EverydayCapabilityBundle, enabled: boolean) =>
    run("update capability", () =>
      window.electronAPI.everydayAgentUpdateProfile({
        capabilitySettings: {
          [capability]: { enabled, paused: false },
        },
      }),
    );

  const acceptConsent = (enabled: boolean) =>
    run(enabled ? "enable Everyday Agent" : "decline Everyday Agent", () =>
      window.electronAPI.everydayAgentAcceptConsent({
        enabled,
        accepted: enabled,
        workspaceId: workspace?.id,
      }),
    );

  const pause = (scope: Partial<EverydayPauseScope>) =>
    run("pause Everyday Agent", () => window.electronAPI.everydayAgentPause(scope));

  const resume = () =>
    run("resume Everyday Agent", async () => {
      let next = result;
      if (!next?.profile.enabled) {
        next = await window.electronAPI.everydayAgentUpdateProfile({ enabled: true });
      }
      if (next?.compiledPolicy.pausedScopes.length || next?.profile.pauseScopes.length) {
        next = await window.electronAPI.everydayAgentClearData({ pauseScopes: true });
      }
      return next;
    });

  const revokeCapability = (capability: EverydayCapabilityBundle) =>
    run("revoke capability", () =>
      window.electronAPI.everydayAgentRevokeCapability(capability),
    );

  const clearActivity = () =>
    run("clear Everyday Agent data", () =>
      window.electronAPI.everydayAgentClearData({
        receipts: true,
        previews: true,
        cachedConnectorSummaries: true,
        browserProfileMetadata: true,
      }),
    );

  const deleteLocalAgentData = () =>
    run("delete local Everyday Agent data", () =>
      window.electronAPI.everydayAgentClearData({
        receipts: true,
        previews: true,
        trustPatterns: true,
        consentHistory: true,
        pauseScopes: true,
        memoryCandidates: true,
        routineProvenance: true,
        cachedConnectorSummaries: true,
        browserProfileMetadata: true,
      }),
    );

  const createPreview = async () => {
    const created = await run("preview action", () =>
      window.electronAPI.everydayAgentPreviewAction({
        title: previewForm.title,
        action: previewForm.action,
        capability: previewForm.capability,
        toolName: previewForm.toolName,
        workspaceId: workspace?.id,
        destination: previewForm.destination || undefined,
        sourceEvidence: ["Everyday Agent console preview"],
        proposedMutation: previewForm.action,
      }),
    );
    if (created) setPreview(created);
  };

  const previewSuggestion = async (suggestion: ProactiveSuggestion, trustPattern = false) => {
    const capability = inferSuggestionCapability(suggestion);
    const created = await run(trustPattern ? "preview trusted pattern" : "preview suggestion", () =>
      window.electronAPI.everydayAgentPreviewAction({
        title: trustPattern ? `Trust pattern: ${suggestion.title}` : suggestion.title,
        action: trustPattern
          ? `Promote this accepted suggestion into a scoped trusted pattern: ${suggestionDescription(suggestion)}`
          : suggestionDescription(suggestion),
        capability,
        toolName: trustPattern ? "workflow.promoteTrustedPattern" : "workflow.previewSuggestion",
        workspaceId: suggestion.workspaceId || workspace?.id,
        destination: suggestion.sourceEntity,
        sourceEvidence: [suggestion.description],
        proposedMutation: trustPattern
          ? "Create a scoped trusted pattern after approval"
          : suggestionDescription(suggestion),
      }),
    );
    if (created) setPreview(created);
  };

  const previewRecipe = async (recipe: EverydayAgentRecipe) => {
    if (!enabledCapabilities.includes(recipe.capability)) {
      onOpenSettings?.();
      return;
    }
    const created = await run("preview recipe", () =>
      window.electronAPI.everydayAgentPreviewAction({
        title: recipe.title,
        action: recipe.prompt,
        capability: recipe.capability,
        toolName: "everyday.recipe.preview",
        workspaceId: workspace?.id,
        sourceEvidence: recipe.surfaces,
        proposedMutation: temporaryModes.readOnly
          ? `Run read-only setup for recipe: ${recipe.description}`
          : recipe.prompt,
        metadata: {
          recipeId: recipe.id,
          temporaryModes,
        },
      }),
    );
    if (created) setPreview(created);
  };

  const approvePreview = async () => {
    if (!preview) return;
    const receipt = await run("approve preview", () =>
      window.electronAPI.everydayAgentApproveAction({
        previewId: preview.id,
      }),
    );
    if (receipt) setPreview(null);
  };

  const startSuggestion = async (suggestion: ProactiveSuggestion) => {
    const prompt = suggestion.actionPrompt || suggestion.description;
    const suggestionWorkspaceId = suggestion.workspaceId;
    if (suggestionWorkspaceId && window.electronAPI.actOnSuggestion) {
      await run("start suggestion", () =>
        window.electronAPI.actOnSuggestion(suggestionWorkspaceId, suggestion.id),
      );
    }
    onCreateTask?.(suggestion.title, prompt);
  };

  const consentModal = consentRequired && !settingsMode && (
    <div className="ea-consent-backdrop">
      <div className="ea-consent-modal">
        <div className="ea-consent-mark">
          <Sparkles size={30} />
        </div>
        <h2>Enable Everyday Agent</h2>
        <p>
          Let CoWork suggest and operate on approved everyday work with visible browser
          execution, reviewable memory, scoped connectors, and audit-grade receipts.
        </p>
        <div className="ea-consent-list">
          <div>
            <ShieldCheck size={18} />
            <span>Data stays local-first unless a connected app action is explicitly approved.</span>
          </div>
          <div>
            <Eye size={18} />
            <span>
              Browser work prefers the visible Browser Workbench. Real-browser attach is
              off by default.
            </span>
          </div>
          <div>
            <KeyRound size={18} />
            <span>
              Sends, posts, exports, destructive actions, spending, credentials, and
              cross-workspace movement always ask first.
            </span>
          </div>
          <div>
            <ReceiptText size={18} />
            <span>
              Every preview, block, approval, skip, and execution writes a receipt you
              can inspect or delete.
            </span>
          </div>
        </div>
        <div className="ea-consent-actions">
          <button
            type="button"
            className="ea-secondary-button"
            onClick={() => void acceptConsent(false)}
            disabled={Boolean(busy)}
          >
            No thanks
          </button>
          <button
            type="button"
            className="ea-primary-button"
            onClick={() => void acceptConsent(true)}
            disabled={Boolean(busy) || adminBlocked}
          >
            Enable Everyday Agent
          </button>
        </div>
      </div>
    </div>
  );

  if (loading && !result) {
    return (
      <main className="main-content everyday-agent-main">
        <div className="everyday-agent-panel">
          <div className="everyday-agent-loading">Loading Everyday Agent...</div>
        </div>
      </main>
    );
  }

  if (settingsMode) {
    return (
      <main className="main-content everyday-agent-main settings-mode">
        <div className="everyday-agent-panel">
          <section className="ea-hero">
            <div>
              <div className="ea-kicker">
                <SettingsIcon size={16} />
                Everyday Agent
              </div>
              <h1>Everyday Agent Settings</h1>
              <p>
                Configure capability bundles, scoped pauses, connector access, previews,
                receipts, and local data controls.
              </p>
            </div>
            <div className="ea-hero-actions">
              <span className={`ea-status ${status}`}>{statusLabel(result)}</span>
              <button
                type="button"
                className="ea-icon-button"
                onClick={() => void load()}
                title="Refresh"
                disabled={Boolean(busy)}
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </section>

          {error && (
            <div className="ea-alert danger">
              <ShieldAlert size={16} />
              {error}
            </div>
          )}

          {adminBlocked && (
            <div className="ea-alert danger">
              <Ban size={16} />
              Everyday Agent is blocked by organization policy.
            </div>
          )}

          <section className="ea-settings-summary">
            <article>
              <span>State</span>
              <strong>{statusLabel(result)}</strong>
            </article>
            <article>
              <span>Capabilities</span>
              <strong>{enabledCapabilities.length} active</strong>
            </article>
            <article>
              <span>Receipts retained</span>
              <strong>{receipts.length} recent</strong>
            </article>
            <article>
              <span>Memory review</span>
              <strong>
                {memoryCandidateCount === null ? "Review-first" : `${memoryCandidateCount} candidates`}
              </strong>
            </article>
          </section>

          <section className="ea-control-row">
            <button
              type="button"
              className="ea-secondary-button"
              onClick={() =>
                void pause({
                  kind: "global",
                  reason: "Paused from Everyday Agent settings",
                })
              }
              disabled={Boolean(busy) || !result?.profile.enabled}
            >
              <PauseCircle size={16} />
              Pause all
            </button>
            <button
              type="button"
              className="ea-secondary-button"
              onClick={() => void resume()}
              disabled={Boolean(busy) || !canResume}
            >
              <RotateCcw size={16} />
              Resume
            </button>
            <button
              type="button"
              className="ea-secondary-button danger"
              onClick={() => void clearActivity()}
              disabled={Boolean(busy)}
            >
              <Trash2 size={16} />
              Clear activity
            </button>
          </section>

          <section className="ea-section">
            <div className="ea-section-header">
              <div>
                <h2>Capability Bundles</h2>
                <p>
                  Enabled bundles compile into managed-agent, connector, permission,
                  workflow, and routine policy.
                </p>
              </div>
            </div>
            <div className="ea-capability-grid">
              {EVERYDAY_AGENT_CAPABILITY_BUNDLES.map((bundle) => {
                const setting = result?.profile.capabilitySettings[bundle.id];
                const blocked =
                  result?.compiledPolicy.adminPolicy.blockedBundles.includes(bundle.id);
                const revoked = result?.profile.revokedCapabilities.includes(bundle.id);
                const active = enabledCapabilities.includes(bundle.id);
                return (
                  <article
                    key={bundle.id}
                    className={`ea-capability-card ${active ? "active" : ""} ${blocked || revoked ? "blocked" : ""}`}
                  >
                    <div className="ea-card-topline">
                      <div>
                        <h3>{bundle.label}</h3>
                        <p>{bundle.description}</p>
                      </div>
                      <label className="ea-switch">
                        <input
                          type="checkbox"
                          checked={Boolean(setting?.enabled)}
                          disabled={Boolean(blocked || revoked || busy || adminBlocked)}
                          onChange={(event) =>
                            void updateCapability(bundle.id, event.currentTarget.checked)
                          }
                        />
                        <span />
                      </label>
                    </div>
                    <div className="ea-tags">
                      {bundle.surfaces.slice(0, 3).map((surface) => (
                        <span key={surface}>{surface}</span>
                      ))}
                    </div>
                    <div className="ea-card-actions">
                      <button
                        type="button"
                        onClick={() =>
                          void pause({
                            kind: "capability",
                            capability: bundle.id,
                            reason: "Paused capability from Everyday Agent settings",
                          })
                        }
                        disabled={Boolean(busy || blocked || revoked)}
                      >
                        Pause
                      </button>
                      <button
                        type="button"
                        onClick={() => void revokeCapability(bundle.id)}
                        disabled={Boolean(busy || revoked)}
                      >
                        Revoke
                      </button>
                    </div>
                    {(blocked || revoked) && (
                      <div className="ea-card-footnote">
                        {blocked ? "Blocked by admin policy" : "Revoked locally"}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="ea-two-column">
            <div className="ea-section">
              <div className="ea-section-header">
                <h2>Scoped Pauses</h2>
              </div>
              <div className="ea-pause-builder">
                <select
                  value={pauseKind}
                  onChange={(event) => setPauseKind(event.currentTarget.value as PauseKind)}
                >
                  {PAUSE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind.replace("_", " ")}
                    </option>
                  ))}
                </select>
                {pauseKind === "capability" ? (
                  <select
                    value={pauseTarget}
                    onChange={(event) => setPauseTarget(event.currentTarget.value)}
                  >
                    <option value="">Select capability</option>
                    {EVERYDAY_AGENT_CAPABILITY_BUNDLES.map((bundle) => (
                      <option key={bundle.id} value={bundle.id}>
                        {bundle.label}
                      </option>
                    ))}
                  </select>
                ) : pauseKind !== "global" ? (
                  <input
                    value={pauseTarget}
                    onChange={(event) => setPauseTarget(event.currentTarget.value)}
                    placeholder={`${pauseKind} id`}
                  />
                ) : null}
                <button
                  type="button"
                  className="ea-secondary-button"
                  onClick={() =>
                    void pause({
                      kind: pauseKind,
                      capability:
                        pauseKind === "capability"
                          ? (pauseTarget as EverydayCapabilityBundle)
                          : undefined,
                      targetId:
                        pauseKind !== "global" && pauseKind !== "capability"
                          ? pauseTarget
                          : undefined,
                      reason: "Scoped pause from Everyday Agent settings",
                    })
                  }
                  disabled={
                    Boolean(busy) ||
                    (pauseKind !== "global" && pauseTarget.trim().length === 0)
                  }
                >
                  Add pause
                </button>
              </div>
              <div className="ea-list">
                {pausedScopes.length === 0 ? (
                  <div className="ea-empty">No active pauses</div>
                ) : (
                  pausedScopes.map((scope) => (
                    <div className="ea-list-item" key={scope.id || `${scope.kind}-${scope.pausedAt}`}>
                      <PauseCircle size={16} />
                      <div>
                        <strong>
                          {scope.kind}
                          {scope.capability ? `: ${capabilityLabel(scope.capability)}` : ""}
                          {scope.targetId ? `: ${scope.targetId}` : ""}
                        </strong>
                        <span>
                          {scope.reason || "Manual pause"} - {formatTime(scope.pausedAt)}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="ea-section">
              <div className="ea-section-header">
                <h2>Connected Apps</h2>
              </div>
              <div className="ea-list">
                {connectedApps.length === 0 ? (
                  <div className="ea-empty">No connector allowlists yet</div>
                ) : (
                  connectedApps.map((entry) => (
                    <div className="ea-list-item" key={entry.connectorId}>
                      <CheckCircle2 size={16} />
                      <div>
                        <strong>{entry.connectorId}</strong>
                        <span>{entry.accountIds?.length || 0} accounts scoped</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>

          <section className="ea-two-column">
            <div className="ea-section">
              <div className="ea-section-header">
                <h2>Run Defaults</h2>
              </div>
              <label className="ea-check-row">
                <input
                  type="checkbox"
                  checked={temporaryModes.noMemory}
                  onChange={(event) =>
                    updateTemporaryMode("noMemory", event.currentTarget.checked)
                  }
                />
                <span>
                  <strong>Run without memory</strong>
                  <small>No memory candidates or prompt-visible learning for sensitive runs.</small>
                </span>
              </label>
              <label className="ea-check-row">
                <input
                  type="checkbox"
                  checked={temporaryModes.disposableBrowser}
                  onChange={(event) =>
                    updateTemporaryMode("disposableBrowser", event.currentTarget.checked)
                  }
                />
                <span>
                  <strong>Disposable browser</strong>
                  <small>Prefer an ephemeral visible browser profile for browser work.</small>
                </span>
              </label>
              <label className="ea-check-row">
                <input
                  type="checkbox"
                  checked={temporaryModes.readOnly}
                  onChange={(event) =>
                    updateTemporaryMode("readOnly", event.currentTarget.checked)
                  }
                />
                <span>
                  <strong>Read-only until approved</strong>
                  <small>Convert recipe starts into dry-run previews.</small>
                </span>
              </label>
            </div>

            <div className="ea-section">
              <div className="ea-section-header">
                <h2>Secure Lanes</h2>
              </div>
              <div className="ea-lane-list">
                {secureLanes.map((lane) => (
                  <article className={`ea-lane ${lane.status}`} key={lane.id}>
                    <div>
                      <strong>{lane.title}</strong>
                      <span>{lane.description}</span>
                    </div>
                    <span>{lane.status}</span>
                  </article>
                ))}
              </div>
            </div>
          </section>

          <section className="ea-section">
            <div className="ea-section-header">
              <div>
                <h2>Recipe Gallery</h2>
                <p>Prebuilt review-first routines you can preview before trusting.</p>
              </div>
            </div>
            <div className="ea-recipe-list ea-recipe-grid">
              {EVERYDAY_AGENT_RECIPES.map((recipe) => {
                const enabled = enabledCapabilities.includes(recipe.capability);
                return (
                  <article className={`ea-recipe ${enabled ? "" : "disabled"}`} key={recipe.id}>
                    <div>
                      <strong>{recipe.title}</strong>
                      <span>{recipe.description}</span>
                      <div className="ea-plan-meta">
                        <span>{capabilityLabel(recipe.capability)}</span>
                        <span>{RISK_LABELS[recipe.riskClass]}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="ea-secondary-button"
                      onClick={() => void previewRecipe(recipe)}
                      disabled={Boolean(busy)}
                    >
                      {enabled ? "Preview" : "Configure"}
                    </button>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="ea-two-column">
            <div className="ea-section">
              <div className="ea-section-header">
                <h2>Action Preview</h2>
              </div>
              <div className="ea-preview-form">
                <input
                  value={previewForm.title}
                  onChange={(event) =>
                    setPreviewForm((current) => ({ ...current, title: event.currentTarget.value }))
                  }
                  placeholder="Action title"
                />
                <textarea
                  value={previewForm.action}
                  onChange={(event) =>
                    setPreviewForm((current) => ({ ...current, action: event.currentTarget.value }))
                  }
                  placeholder="Proposed action"
                />
                <div className="ea-inline-fields">
                  <select
                    value={previewForm.capability}
                    onChange={(event) =>
                      setPreviewForm((current) => ({
                        ...current,
                        capability: event.currentTarget.value as EverydayCapabilityBundle,
                      }))
                    }
                  >
                    {EVERYDAY_AGENT_CAPABILITY_BUNDLES.map((bundle) => (
                      <option key={bundle.id} value={bundle.id}>
                        {bundle.label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={previewForm.toolName}
                    onChange={(event) =>
                      setPreviewForm((current) => ({
                        ...current,
                        toolName: event.currentTarget.value,
                      }))
                    }
                    placeholder="Tool"
                  />
                </div>
                <input
                  value={previewForm.destination}
                  onChange={(event) =>
                    setPreviewForm((current) => ({
                      ...current,
                      destination: event.currentTarget.value,
                    }))
                  }
                  placeholder="Destination/account/channel"
                />
                <button
                  type="button"
                  className="ea-primary-button"
                  onClick={() => void createPreview()}
                  disabled={Boolean(busy || !previewForm.title || !previewForm.action)}
                >
                  Preview action
                </button>
              </div>
              {preview && (
                <div className="ea-preview-card">
                  <div className="ea-card-topline">
                    <div>
                      <h3>{preview.title}</h3>
                      <p>{preview.proposedMutation}</p>
                    </div>
                    <span className={`ea-risk ${riskTone(preview.riskClass)}`}>
                      {RISK_LABELS[preview.riskClass]}
                    </span>
                  </div>
                  <div className="ea-preview-details">
                    <span>Approval: {preview.approvalRequired ? "Required" : "Not required"}</span>
                    <span>Status: {preview.status}</span>
                    <span>Idempotency: {preview.idempotencyKey}</span>
                  </div>
                  <p className="ea-preview-reason">{preview.approvalReason}</p>
                  <button
                    type="button"
                    className="ea-primary-button"
                    onClick={() => void approvePreview()}
                    disabled={Boolean(busy || preview.status === "blocked")}
                  >
                    Approve preview
                  </button>
                </div>
              )}
            </div>

            <div className="ea-section">
              <div className="ea-section-header">
                <h2>Data Controls</h2>
              </div>
              <div className="ea-list">
                <div className="ea-list-item">
                  <ReceiptText size={16} />
                  <div>
                    <strong>Receipts</strong>
                    <span>Every preview, block, skip, approval, and execution is inspectable.</span>
                  </div>
                </div>
                <div className="ea-list-item">
                  <FileClock size={16} />
                  <div>
                    <strong>Memory policy</strong>
                    <span>Memory candidates remain review-first by default.</span>
                  </div>
                </div>
                <div className="ea-list-item">
                  <ShieldCheck size={16} />
                  <div>
                    <strong>Consent</strong>
                    <span>Accepted version {result?.profile.acceptedConsentVersion || 0}</span>
                  </div>
                </div>
                <div className="ea-list-item">
                  <Database size={16} />
                  <div>
                    <strong>Local deletion</strong>
                    <span>Delete receipts, previews, trust patterns, memory candidates, connector summaries, and browser metadata.</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void deleteLocalAgentData()}
                    disabled={Boolean(busy)}
                  >
                    Delete local data
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="main-content everyday-agent-main">
      <div className="everyday-agent-panel ea-console">
        <section className="ea-console-header">
          <div>
            <div className="ea-kicker">
              <Sparkles size={16} />
              Everyday Agent
            </div>
            <h1>Everyday Agent</h1>
            <p>
              Supervise the operator: pending approvals, active work, trusted routines,
              recent receipts, and intervention controls.
            </p>
          </div>
          <div className="ea-console-actions">
            <span className={`ea-status ${status}`}>{statusLabel(result)}</span>
            {canResume ? (
              <button
                type="button"
                className="ea-secondary-button"
                onClick={() => void resume()}
                disabled={Boolean(busy)}
              >
                <RotateCcw size={16} />
                Resume
              </button>
            ) : (
              <button
                type="button"
                className="ea-secondary-button"
                onClick={() =>
                  void pause({
                    kind: "global",
                    reason: "Paused from Everyday Agent console",
                  })
                }
                disabled={Boolean(busy) || !result?.profile.enabled || adminBlocked}
              >
                <PauseCircle size={16} />
                Pause all
              </button>
            )}
            <button
              type="button"
              className="ea-icon-button"
              onClick={() => void load()}
              title="Refresh"
              disabled={Boolean(busy)}
            >
              <RefreshCw size={16} />
            </button>
            {onOpenSettings && (
              <button type="button" className="ea-secondary-button" onClick={onOpenSettings}>
                <SettingsIcon size={16} />
                Settings
              </button>
            )}
          </div>
        </section>

        {error && (
          <div className="ea-alert danger">
            <ShieldAlert size={16} />
            {error}
          </div>
        )}

        {adminBlocked && (
          <div className="ea-alert danger">
            <Ban size={16} />
            Everyday Agent is blocked by organization policy.
          </div>
        )}

        {consentModal}

        <section className="ea-operator-card">
          <div className="ea-operator-main">
            <div className="ea-operator-icon">
              <Bot size={20} />
            </div>
            <div>
              <span>Current activity</span>
              <h2>
                {status === "enabled"
                  ? busy || "Idle, watching approved signals"
                  : statusLabel(result)}
              </h2>
              <p>
                Work remains bound to profile, workspace, connector account, browser
                profile, channel, device, and target identity before execution.
              </p>
            </div>
          </div>
          <div className="ea-operator-metrics">
            <div>
              <strong>{priorityItems.filter((item) => item.tone !== "success").length}</strong>
              <span>needs attention</span>
            </div>
            <div>
              <strong>{activeSuggestions.length}</strong>
              <span>suggestions</span>
            </div>
            <div>
              <strong>{recentReceipts.length}</strong>
              <span>recent receipts</span>
            </div>
          </div>
        </section>

        <section className="ea-live-board">
          <div className="ea-live-rail">
            <div className="ea-section-header">
              <div>
                <h2>Live Plan</h2>
                <p>Review what the agent will do before it mutates anything.</p>
              </div>
            </div>
            <div className="ea-plan-steps">
              {planSteps.map((step, index) => (
                <article className={`ea-plan-step ${step.posture}`} key={step.id}>
                  <div className="ea-plan-index">{index + 1}</div>
                  <div>
                    <div className="ea-plan-title">
                      <strong>{step.title}</strong>
                      <span>{step.posture.replace("_", " ")}</span>
                    </div>
                    <p>{step.detail}</p>
                    <div className="ea-plan-meta">
                      <span>{capabilityLabel(step.capability)}</span>
                      <span>{RISK_LABELS[step.riskClass]}</span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <div className="ea-console-grid">
          <div className="ea-console-main">
            <section className="ea-section ea-priority-section">
              <div className="ea-section-header">
                <div>
                  <h2>Priority Queue</h2>
                  <p>Approvals, blocked actions, and recoverable failures appear first.</p>
                </div>
              </div>
              <div className="ea-priority-list">
                {priorityItems.map((item) => (
                  <article className={`ea-priority-item ${item.tone}`} key={item.id}>
                    <div className="ea-priority-icon">
                      {item.tone === "danger" ? (
                        <AlertTriangle size={17} />
                      ) : item.tone === "warn" ? (
                        <ShieldAlert size={17} />
                      ) : item.tone === "success" ? (
                        <CheckCircle2 size={17} />
                      ) : (
                        <CircleDot size={17} />
                      )}
                    </div>
                    <div>
                      <div className="ea-priority-title">
                        <strong>{item.title}</strong>
                        {item.meta && <span>{item.meta}</span>}
                      </div>
                      <p>{item.detail}</p>
                    </div>
                    {item.actionKind === "resume" && (
                      <button
                        type="button"
                        className="ea-secondary-button"
                        onClick={() => void resume()}
                        disabled={Boolean(busy) || !canResume}
                      >
                        Resume
                      </button>
                    )}
                    {(item.actionKind === "settings" || item.actionKind === "memory") &&
                      onOpenSettings && (
                        <button
                          type="button"
                          className="ea-secondary-button"
                          onClick={onOpenSettings}
                        >
                          Settings
                        </button>
                      )}
                    {item.actionKind === "receipt" && onOpenMissionControl && (
                      <button
                        type="button"
                        className="ea-secondary-button"
                        onClick={onOpenMissionControl}
                      >
                        Mission Control
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </section>

            {preview && (
              <section className="ea-section">
                <div className="ea-section-header">
                  <div>
                    <h2>Action Preview</h2>
                    <p>Review source evidence, target, mutation, risk, rollback, and idempotency.</p>
                  </div>
                </div>
                <div className="ea-preview-card">
                  <div className="ea-card-topline">
                    <div>
                      <h3>{preview.title}</h3>
                      <p>{preview.proposedMutation}</p>
                    </div>
                    <span className={`ea-risk ${riskTone(preview.riskClass)}`}>
                      {RISK_LABELS[preview.riskClass]}
                    </span>
                  </div>
                  <div className="ea-preview-details">
                    <span>Target: {previewTargetLabel(preview)}</span>
                    <span>Approval: {preview.approvalRequired ? "Required" : "Not required"}</span>
                    <span>Rollback: {preview.rollbackAvailable ? "Available" : "Unavailable"}</span>
                    <span>Idempotency: {preview.idempotencyKey}</span>
                  </div>
                  <p className="ea-preview-reason">{preview.approvalReason}</p>
                  <button
                    type="button"
                    className="ea-primary-button"
                    onClick={() => void approvePreview()}
                    disabled={Boolean(busy || preview.status === "blocked")}
                  >
                    Approve preview
                  </button>
                </div>
              </section>
            )}

            <section className="ea-section">
              <div className="ea-section-header">
                <div>
                  <h2>Suggestions</h2>
                  <p>Accepted, rejected, snoozed, and trusted patterns stay scoped.</p>
                </div>
              </div>
              <div className="ea-list ea-suggestion-list">
                {activeSuggestions.length === 0 ? (
                  <div className="ea-empty">No suggestions waiting</div>
                ) : (
                  activeSuggestions.map((suggestion) => (
                    <div className="ea-list-item" key={suggestion.id}>
                      <Sparkles size={16} />
                      <div>
                        <strong>{suggestion.title}</strong>
                        <span>{suggestion.description}</span>
                        <div className="ea-evidence-row">
                          <span>Why now: {suggestion.urgency || "normal"} urgency</span>
                          <span>Confidence: {Math.round(suggestion.confidence * 100)}%</span>
                          {suggestion.sourceEntity && <span>Source: {suggestion.sourceEntity}</span>}
                          {suggestion.snoozedUntil && <span>Snoozed until {formatTime(suggestion.snoozedUntil)}</span>}
                        </div>
                      </div>
                      <div className="ea-row-actions">
                        <button
                          type="button"
                          onClick={() => void previewSuggestion(suggestion)}
                          disabled={Boolean(busy)}
                        >
                          Preview
                        </button>
                        <button
                          type="button"
                          onClick={() => void startSuggestion(suggestion)}
                          disabled={Boolean(busy || !onCreateTask)}
                        >
                          Start
                        </button>
                        <button
                          type="button"
                          onClick={() => void previewSuggestion(suggestion, true)}
                          disabled={Boolean(busy)}
                        >
                          Trust pattern
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="ea-section">
              <div className="ea-section-header">
                <div>
                  <h2>Recent Receipts</h2>
                  <p>Executed, skipped, blocked, previewed, and approved work remains inspectable.</p>
                </div>
                {onOpenMissionControl && (
                  <button type="button" className="ea-secondary-button" onClick={onOpenMissionControl}>
                    <Play size={16} />
                    Mission Control
                  </button>
                )}
              </div>
              <div className="ea-receipts compact">
                {recentReceipts.length === 0 ? (
                  <div className="ea-empty">No receipts yet</div>
                ) : (
                  recentReceipts.map((receipt) => (
                    <article className="ea-receipt" key={receipt.id}>
                      <div className="ea-receipt-icon">
                        {receipt.status === "blocked" || receipt.status === "failed" ? (
                          <XCircle size={16} />
                        ) : receipt.status === "paused" ? (
                          <PauseCircle size={16} />
                        ) : (
                          <ReceiptText size={16} />
                        )}
                      </div>
                      <div>
                        <div className="ea-receipt-title">
                          <strong>{receipt.title}</strong>
                          <span className={`ea-risk ${riskTone(receipt.riskClass)}`}>
                            {RISK_LABELS[receipt.riskClass]}
                          </span>
                        </div>
                        <p>{receipt.summary}</p>
                        <div className="ea-receipt-meta">
                          <span>{receipt.status}</span>
                          <span>{capabilityLabel(receipt.capability)}</span>
                          <span>
                            <Clock size={12} />
                            {formatTime(receipt.createdAt)}
                          </span>
                        </div>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>

            <section className="ea-section">
              <div className="ea-section-header">
                <div>
                  <h2>Recoverable Failures</h2>
                  <p>Auth, policy, network, duplicate, and partial-failure states become explicit actions.</p>
                </div>
              </div>
              <div className="ea-recovery-list">
                {recoveryItems.length === 0 ? (
                  <div className="ea-empty">No recovery actions waiting</div>
                ) : (
                  recoveryItems.map((item) => (
                    <article className={`ea-recovery-item ${item.tone}`} key={item.id}>
                      <div className="ea-recovery-icon">
                        {item.tone === "danger" ? <AlertTriangle size={16} /> : <RefreshCw size={16} />}
                      </div>
                      <div>
                        <strong>{item.title}</strong>
                        <span>{item.detail}</span>
                      </div>
                      <button
                        type="button"
                        className="ea-secondary-button"
                        onClick={() => {
                          if (item.actionLabel.includes("policy")) {
                            onOpenSettings?.();
                          } else {
                            onOpenMissionControl?.();
                          }
                        }}
                        disabled={Boolean(busy) || (!onOpenSettings && !onOpenMissionControl)}
                      >
                        {item.actionLabel}
                      </button>
                    </article>
                  ))
                )}
              </div>
            </section>

            <section className="ea-section">
              <div className="ea-section-header">
                <div>
                  <h2>Active Routines</h2>
                  <p>Trusted routines, dry-runs, pauses, and failures.</p>
                </div>
              </div>
              <div className="ea-routine-list">
                {routines.length === 0 ? (
                  <div className="ea-empty">No trusted routines yet</div>
                ) : (
                  routines.map((routine) => (
                    <article className={`ea-routine ${routine.tone}`} key={routine.id}>
                      <div>
                        <strong>{routine.name}</strong>
                        <span>{routine.detail}</span>
                      </div>
                      <div className="ea-routine-meta">
                        <span>{routine.status}</span>
                        {routine.lastRunAt && <span>{formatTime(routine.lastRunAt)}</span>}
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

export function EverydayAgentSettingsPanel({
  workspaceId,
  onCreateTask,
}: {
  workspaceId?: string;
  onCreateTask?: (title: string, prompt: string) => void;
}) {
  return (
    <EverydayAgentPanel
      settingsMode
      workspace={workspaceId ? ({ id: workspaceId } as Workspace) : null}
      onCreateTask={onCreateTask}
    />
  );
}
