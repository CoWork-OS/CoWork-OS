import { v4 as uuidv4 } from "uuid";
import * as fs from "fs/promises";
import * as path from "path";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { LLMProviderFactory } from "../agent/llm/provider-factory";
import { recordLlmCallError, recordLlmCallSuccess } from "../agent/llm/usage-telemetry";
import type { LLMMessage } from "../agent/llm/types";
import {
  HEALTH_SOURCE_TEMPLATES,
  type HealthDashboard,
  type HealthInsight,
  type HealthMetric,
  type HealthMetricKey,
  type HealthRecord,
  type HealthSource,
  type HealthSourceInput,
  type HealthSourceConnectionMode,
  type HealthSourceKind,
  type HealthSourceProvider,
  type HealthSourceStatus,
  type HealthState,
  type HealthSyncEvent,
  type HealthSyncResult,
  type HealthWorkflow,
  type HealthWorkflowRequest,
  type HealthWorkflowSection,
  type HealthWorkflowType,
  type HealthWritebackItem,
  type HealthWritebackPreview,
  type HealthWritebackRequest,
  type HealthWritebackType,
} from "../../shared/health";
import { AppleHealthBridge } from "./apple-health-bridge";

const SETTINGS_CATEGORY = "health";
const STATE_VERSION = 1 as const;

function now(): number {
  return Date.now();
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createId(prefix: string): string {
  return `${prefix}:${uuidv4()}`;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isHealthyRepoAvailable(): boolean {
  return SecureSettingsRepository.isInitialized();
}

const APPLE_HEALTH_READ_TYPES: HealthWritebackType[] = [
  "steps",
  "sleep",
  "heart_rate",
  "hrv",
  "weight",
  "glucose",
  "workout",
];

const APPLE_HEALTH_WRITE_TYPES: HealthWritebackType[] = [
  "steps",
  "sleep",
  "heart_rate",
  "hrv",
  "weight",
  "glucose",
  "workout",
];

function isAppleHealthSource(source: HealthSource | HealthSourceInput): boolean {
  return source.provider === "apple-health";
}

function defaultConnectionModeForSource(input: HealthSourceInput): HealthSourceConnectionMode {
  if (input.connectionMode) return input.connectionMode;
  if (input.provider === "apple-health") {
    return AppleHealthBridge.isAvailable() ? "native" : "import";
  }
  return "import";
}

function defaultPermissionStateForSource(
  input: HealthSourceInput,
): HealthSource["permissionState"] {
  if (input.provider !== "apple-health") return undefined;
  return AppleHealthBridge.isAvailable() ? "not-determined" : "import-only";
}

function appendSyncEvent(
  source: HealthSource,
  event: Omit<HealthSyncEvent, "id" | "sourceId" | "createdAt"> &
    Partial<Pick<HealthSyncEvent, "id" | "sourceId" | "createdAt">>,
): HealthSource {
  const history = [...(source.syncHistory || [])];
  history.unshift({
    id: event.id || createId("health-sync-event"),
    sourceId: event.sourceId || source.id,
    action: event.action,
    status: event.status,
    message: event.message,
    createdAt: event.createdAt || now(),
  });
  return {
    ...source,
    syncHistory: history.slice(0, 20),
    updatedAt: now(),
  };
}

function sourceReadTypes(source: HealthSource): HealthWritebackType[] {
  if (source.provider === "apple-health") {
    return source.readableTypes && source.readableTypes.length > 0
      ? source.readableTypes
      : APPLE_HEALTH_READ_TYPES;
  }
  return [];
}

function sourceWriteTypes(source: HealthSource): HealthWritebackType[] {
  if (source.provider === "apple-health") {
    return source.writableTypes && source.writableTypes.length > 0
      ? source.writableTypes
      : APPLE_HEALTH_WRITE_TYPES;
  }
  return [];
}

function defaultState(): HealthState {
  return {
    version: STATE_VERSION,
    sources: [],
    metrics: [],
    records: [],
    insights: [],
    workflows: [],
    lastUpdatedAt: now(),
  };
}

function normalizeSourceInput(input: HealthSourceInput, existing?: HealthSource): HealthSource {
  const timestamp = now();
  const connectionMode = defaultConnectionModeForSource(input);
  return {
    id: existing?.id || createId("health-source"),
    provider: input.provider,
    kind: input.kind,
    name: input.name.trim(),
    description:
      input.description?.trim() ||
      HEALTH_SOURCE_TEMPLATES.find((template) => template.provider === input.provider)
        ?.description ||
      titleCase(input.provider),
    status: existing?.status || "connected",
    enabled: existing?.enabled ?? true,
    accountLabel: input.accountLabel?.trim() || existing?.accountLabel,
    notes: input.notes?.trim() || existing?.notes,
    provenance: existing?.provenance || `Local ${titleCase(input.kind)} source`,
    connectionMode: input.connectionMode || existing?.connectionMode || connectionMode,
    permissionState:
      existing?.permissionState ||
      (input.connectionMode === "import" ? "import-only" : defaultPermissionStateForSource(input)),
    readableTypes: existing?.readableTypes,
    writableTypes: existing?.writableTypes,
    syncHistory: existing?.syncHistory || [],
    bridgeStatus:
      existing?.bridgeStatus || (input.provider === "apple-health" ? "unavailable" : undefined),
    connectedAt: existing?.connectedAt ?? timestamp,
    lastSyncedAt: existing?.lastSyncedAt,
    lastSyncStatus: existing?.lastSyncStatus,
    lastError: existing?.lastError,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function scoreTrend(previous: number | undefined, current: number): "up" | "down" | "stable" {
  if (previous == null) return "stable";
  const diff = current - previous;
  if (Math.abs(diff) < Math.max(1, Math.abs(previous) * 0.03)) return "stable";
  return diff > 0 ? "up" : "down";
}

function metricLabelForKey(key: HealthMetricKey): { label: string; unit: string } {
  switch (key) {
    case "steps":
      return { label: "Steps", unit: "steps" };
    case "sleep_minutes":
      return { label: "Sleep", unit: "min" };
    case "resting_hr":
      return { label: "Resting HR", unit: "bpm" };
    case "hrv":
      return { label: "HRV", unit: "ms" };
    case "training_load":
      return { label: "Training Load", unit: "au" };
    case "weight":
      return { label: "Weight", unit: "lb" };
    case "glucose":
      return { label: "Glucose", unit: "mg/dL" };
    case "a1c":
      return { label: "A1C", unit: "%" };
    case "ldl":
      return { label: "LDL", unit: "mg/dL" };
    case "hdl":
      return { label: "HDL", unit: "mg/dL" };
    case "triglycerides":
      return { label: "Triglycerides", unit: "mg/dL" };
    case "symptom_score":
      return { label: "Symptoms", unit: "/10" };
    default:
      return { label: titleCase(key), unit: "" };
  }
}

function sourceLabel(source: HealthSource): string {
  return source.accountLabel ? `${source.name} · ${source.accountLabel}` : source.name;
}

function extractNumber(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const parsed = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseImportedText(content: string): {
  metrics: Array<{ key: HealthMetricKey; value: number }>;
  summary: string;
} {
  const lowered = content.toLowerCase();
  const metrics: Array<{ key: HealthMetricKey; value: number }> = [];

  const a1c = extractNumber(content, [
    /a1c[:\s]+([0-9]+(?:\.[0-9]+)?)/i,
    /hba1c[:\s]+([0-9]+(?:\.[0-9]+)?)/i,
  ]);
  const glucose = extractNumber(content, [
    /glucose[:\s]+([0-9]+(?:\.[0-9]+)?)/i,
    /blood sugar[:\s]+([0-9]+(?:\.[0-9]+)?)/i,
  ]);
  const ldl = extractNumber(content, [/ldl[:\s]+([0-9]+(?:\.[0-9]+)?)/i]);
  const hdl = extractNumber(content, [/hdl[:\s]+([0-9]+(?:\.[0-9]+)?)/i]);
  const triglycerides = extractNumber(content, [/triglycerides[:\s]+([0-9]+(?:\.[0-9]+)?)/i]);
  const symptomScore = extractNumber(content, [/symptom score[:\s]+([0-9]+(?:\.[0-9]+)?)/i]);

  if (a1c != null) metrics.push({ key: "a1c", value: a1c });
  if (glucose != null) metrics.push({ key: "glucose", value: glucose });
  if (ldl != null) metrics.push({ key: "ldl", value: ldl });
  if (hdl != null) metrics.push({ key: "hdl", value: hdl });
  if (triglycerides != null) metrics.push({ key: "triglycerides", value: triglycerides });
  if (symptomScore != null) metrics.push({ key: "symptom_score", value: symptomScore });

  if (metrics.length === 0) {
    if (/sleep|steps|hrv|heart rate|training/i.test(lowered)) {
      const steps = extractNumber(content, [/steps[:\s]+([0-9,]+)/i]);
      if (steps != null) {
        metrics.push({ key: "steps", value: Number(String(steps).replace(/,/g, "")) });
      }
    }
  }

  const summary = content.trim().slice(0, 220) || "Imported health document";

  return { metrics: metrics.filter((metric) => Number.isFinite(metric.value)), summary };
}

function makeMetric(
  source: HealthSource,
  key: HealthMetricKey,
  value: number,
  recordedAt = now(),
): HealthMetric {
  const meta = metricLabelForKey(key);
  return {
    id: createId("health-metric"),
    key,
    label: meta.label,
    value,
    unit: meta.unit,
    recordedAt,
    sourceId: source.id,
    sourceLabel: sourceLabel(source),
  };
}

function makeRecord(
  source: HealthSource,
  title: string,
  summary: string,
  tags: string[],
  recordedAt = now(),
): HealthRecord {
  return {
    id: createId("health-record"),
    sourceId: source.id,
    sourceLabel: sourceLabel(source),
    kind: source.kind,
    title,
    summary,
    recordedAt,
    provenance: source.provenance,
    tags,
  };
}

function mergeMetrics(existing: HealthMetric[], next: HealthMetric[]): HealthMetric[] {
  const byKey = new Map<string, HealthMetric>();
  for (const metric of existing) {
    byKey.set(`${metric.sourceId}:${metric.key}`, metric);
  }
  for (const metric of next) {
    byKey.set(`${metric.sourceId}:${metric.key}`, metric);
  }
  return [...byKey.values()].sort((a, b) => b.recordedAt - a.recordedAt);
}

function deriveInsights(state: HealthState): HealthInsight[] {
  const insights: HealthInsight[] = [];
  const latestByKey = new Map<HealthMetricKey, HealthMetric[]>();
  for (const metric of state.metrics) {
    const list = latestByKey.get(metric.key) || [];
    list.push(metric);
    latestByKey.set(metric.key, list);
  }
  for (const list of latestByKey.values()) {
    list.sort((a, b) => b.recordedAt - a.recordedAt);
  }

  const steps = latestByKey.get("steps")?.[0];
  const sleep = latestByKey.get("sleep_minutes")?.[0];
  const restingHr = latestByKey.get("resting_hr")?.[0];
  const hrv = latestByKey.get("hrv")?.[0];
  const a1c = latestByKey.get("a1c")?.[0];
  const glucose = latestByKey.get("glucose")?.[0];
  const symptom = latestByKey.get("symptom_score")?.[0];

  if (steps && steps.value < 7000) {
    insights.push({
      id: createId("health-insight"),
      title: "Activity is below your usual target",
      summary: `${Math.round(steps.value)} steps is under the 7k baseline we use for healthy daily movement.`,
      detail:
        "Consider a short walk or a low-intensity session to lift the baseline without overreaching.",
      severity: "watch",
      sourceIds: [steps.sourceId],
      metricKeys: ["steps"],
      createdAt: now(),
    });
  }

  if (sleep && sleep.value < 420) {
    insights.push({
      id: createId("health-insight"),
      title: "Sleep debt may be accumulating",
      summary: `${Math.round(sleep.value / 60)}h ${Math.round(sleep.value % 60)}m of sleep is below the 7h target.`,
      detail:
        "Protect the next recovery window with an earlier bedtime, fewer late stimulants, and a lighter training load.",
      severity: "action",
      sourceIds: [sleep.sourceId],
      metricKeys: ["sleep_minutes"],
      createdAt: now(),
    });
  }

  if (restingHr && restingHr.value > 72) {
    insights.push({
      id: createId("health-insight"),
      title: "Resting heart rate is elevated",
      summary: `Resting heart rate at ${Math.round(restingHr.value)} bpm can indicate stress, illness, or a hard training block.`,
      detail:
        "Cross-check with sleep, illness symptoms, and recovery signals before pushing intensity.",
      severity: "watch",
      sourceIds: [restingHr.sourceId],
      metricKeys: ["resting_hr"],
      createdAt: now(),
    });
  }

  if (hrv && hrv.value < 32) {
    insights.push({
      id: createId("health-insight"),
      title: "Recovery signal is low",
      summary: `HRV at ${Math.round(hrv.value)} ms suggests stress or incomplete recovery.`,
      detail: "Favor aerobic base work, hydration, and rest until the trend stabilizes.",
      severity: "watch",
      sourceIds: [hrv.sourceId],
      metricKeys: ["hrv"],
      createdAt: now(),
    });
  }

  if (a1c && a1c.value >= 5.7) {
    insights.push({
      id: createId("health-insight"),
      title: "A1C is trending into the prediabetes range",
      summary: `A1C of ${a1c.value.toFixed(1)}% should be reviewed with your clinician.`,
      detail:
        "Use labs, diet, and symptom tracking together rather than interpreting this in isolation.",
      severity: "action",
      sourceIds: [a1c.sourceId],
      metricKeys: ["a1c"],
      createdAt: now(),
    });
  }

  if (glucose && glucose.value >= 110) {
    insights.push({
      id: createId("health-insight"),
      title: "Glucose is above optimal fasting range",
      summary: `Glucose at ${Math.round(glucose.value)} mg/dL may merit follow-up.`,
      detail:
        "Look for correlation with meal timing, sleep disruption, and activity before making changes.",
      severity: "watch",
      sourceIds: [glucose.sourceId],
      metricKeys: ["glucose"],
      createdAt: now(),
    });
  }

  if (symptom && symptom.value >= 6) {
    insights.push({
      id: createId("health-insight"),
      title: "Symptom burden is elevated",
      summary: `Symptom score ${Math.round(symptom.value)}/10 is worth carrying into your next visit.`,
      detail:
        "Use the visit-prep workflow to summarize patterns, triggers, and questions for your clinician.",
      severity: "action",
      sourceIds: [symptom.sourceId],
      metricKeys: ["symptom_score"],
      createdAt: now(),
    });
  }

  if (insights.length === 0 && state.records.length > 0) {
    const latestRecord = state.records[0];
    insights.push({
      id: createId("health-insight"),
      title: "New health data is ready",
      summary: `Imported ${state.records.length} record(s) from ${latestRecord.sourceLabel}.`,
      detail: "Connect a wearable or import more lab/record data to get trend-based guidance.",
      severity: "info",
      sourceIds: [latestRecord.sourceId],
      metricKeys: [],
      createdAt: now(),
    });
  }

  return insights.slice(0, 6);
}

function toDashboard(state: HealthState, isDemo: boolean): HealthDashboard {
  return {
    generatedAt: now(),
    isDemo,
    stats: {
      sourceCount: state.sources.length,
      connectedCount: state.sources.filter(
        (source) => source.enabled && source.status === "connected",
      ).length,
      syncingCount: state.sources.filter((source) => source.status === "syncing").length,
      recordsCount: state.records.length,
      metricsCount: state.metrics.length,
      insightsCount: state.insights.length,
      workflowsCount: state.workflows.length,
    },
    sources: [...state.sources].sort((a, b) => b.updatedAt - a.updatedAt),
    metrics: [...state.metrics].sort((a, b) => b.recordedAt - a.recordedAt),
    records: [...state.records].sort((a, b) => b.recordedAt - a.recordedAt),
    insights: [...state.insights].sort((a, b) => b.createdAt - a.createdAt),
    workflows: [...state.workflows].sort((a, b) => b.createdAt - a.createdAt),
  };
}

function createDemoState(): HealthState {
  const source = {
    id: "demo-oura",
    provider: "oura" as HealthSourceProvider,
    kind: "wearable" as HealthSourceKind,
    name: "Oura Ring",
    description: "Sleep, readiness, and recovery demo data.",
    status: "connected" as HealthSourceStatus,
    enabled: true,
    accountLabel: "Sample Athlete",
    provenance: "Demo dataset",
    connectedAt: now() - 86_400_000,
    lastSyncedAt: now() - 5 * 60 * 1000,
    lastSyncStatus: "success" as const,
    createdAt: now() - 86_400_000,
    updatedAt: now(),
  };
  const labSource = {
    id: "demo-labs",
    provider: "lab-results" as HealthSourceProvider,
    kind: "lab" as HealthSourceKind,
    name: "Lab Results",
    description: "Recent labs demo data.",
    status: "connected" as HealthSourceStatus,
    enabled: true,
    accountLabel: "Annual Checkup",
    provenance: "Demo dataset",
    connectedAt: now() - 86_400_000,
    lastSyncedAt: now() - 4 * 60 * 1000,
    lastSyncStatus: "success" as const,
    createdAt: now() - 86_400_000,
    updatedAt: now(),
  };
  const state: HealthState = {
    version: STATE_VERSION,
    sources: [source, labSource],
    metrics: [
      makeMetric(source, "steps", 8840, now() - 3 * 60 * 60 * 1000),
      makeMetric(source, "sleep_minutes", 392, now() - 3 * 60 * 60 * 1000),
      makeMetric(source, "resting_hr", 58, now() - 3 * 60 * 60 * 1000),
      makeMetric(source, "hrv", 36, now() - 3 * 60 * 60 * 1000),
      makeMetric(labSource, "a1c", 5.6, now() - 24 * 60 * 60 * 1000),
      makeMetric(labSource, "glucose", 104, now() - 24 * 60 * 60 * 1000),
      makeMetric(labSource, "ldl", 112, now() - 24 * 60 * 60 * 1000),
    ],
    records: [
      makeRecord(
        source,
        "Sleep and recovery snapshot",
        "Recovery was moderate with a short sleep window and average HRV.",
        ["sleep", "recovery"],
      ),
      makeRecord(
        labSource,
        "Annual lab summary",
        "A1C is near the upper end of normal; LDL is slightly elevated.",
        ["labs", "metabolic"],
      ),
    ],
    insights: [],
    workflows: [
      {
        id: createId("health-workflow"),
        workflowType: "trend-analysis",
        title: "What changed this week",
        summary:
          "Sleep dipped, steps held steady, and labs are available for a clinician-ready review.",
        sections: [
          {
            title: "Highlights",
            items: [
              "Sleep fell below target on two nights.",
              "Resting HR stayed stable.",
              "Lab data is ready to review.",
            ],
          },
          {
            title: "Next best actions",
            items: [
              "Protect tonight's sleep window.",
              "Keep the next session easy if recovery stays low.",
              "Bring the lab summary to your visit.",
            ],
          },
        ],
        sourceIds: [source.id, labSource.id],
        disclaimer: "Informational only. Not medical advice.",
        createdAt: now() - 30 * 60 * 1000,
      },
    ],
    lastUpdatedAt: now(),
  };
  state.insights = deriveInsights(state);
  return state;
}

function loadState(): HealthState {
  if (!isHealthyRepoAvailable()) {
    return defaultState();
  }

  try {
    const repo = SecureSettingsRepository.getInstance();
    const stored = repo.load<HealthState>(SETTINGS_CATEGORY);
    if (!stored) return defaultState();
    return {
      ...defaultState(),
      ...stored,
      version: STATE_VERSION,
      sources: (stored.sources || []).map((source) => ({
        ...source,
        connectionMode:
          source.connectionMode ||
          (source.provider === "apple-health"
            ? sourceModeForAppleHealth(source)
            : source.connectionMode),
        permissionState:
          source.permissionState ||
          (source.provider === "apple-health"
            ? AppleHealthBridge.isAvailable()
              ? "not-determined"
              : "import-only"
            : undefined),
        readableTypes: source.readableTypes || [],
        writableTypes: source.writableTypes || [],
        syncHistory: source.syncHistory || [],
        bridgeStatus:
          source.bridgeStatus || (source.provider === "apple-health" ? "unavailable" : undefined),
      })),
      metrics: stored.metrics || [],
      records: stored.records || [],
      insights: stored.insights || [],
      workflows: stored.workflows || [],
    };
  } catch {
    return defaultState();
  }
}

function saveState(state: HealthState): void {
  if (!isHealthyRepoAvailable()) return;
  SecureSettingsRepository.getInstance().save(SETTINGS_CATEGORY, state);
}

function updateState(mutator: (state: HealthState) => HealthState): HealthState {
  const next = mutator(loadState());
  next.lastUpdatedAt = now();
  next.version = STATE_VERSION;
  saveState(next);
  return next;
}

function sourceSeed(provider: HealthSourceProvider): {
  kind: HealthSourceKind;
  name: string;
  description: string;
} {
  return (
    HEALTH_SOURCE_TEMPLATES.find((template) => template.provider === provider) || {
      kind:
        provider === "lab-results" ? "lab" : provider === "medical-records" ? "record" : "manual",
      name: titleCase(provider),
      description: "Custom health source",
    }
  );
}

function metricKeyForWritebackType(type: HealthWritebackType): HealthMetricKey {
  switch (type) {
    case "steps":
      return "steps";
    case "sleep":
      return "sleep_minutes";
    case "heart_rate":
      return "resting_hr";
    case "hrv":
      return "hrv";
    case "weight":
      return "weight";
    case "glucose":
      return "glucose";
    case "workout":
      return "training_load";
    case "labs":
      return "a1c";
    case "nutrition":
    case "custom":
    default:
      return "symptom_score";
  }
}

function sourceModeForAppleHealth(source: HealthSource): HealthSourceConnectionMode {
  return source.connectionMode || (AppleHealthBridge.isAvailable() ? "native" : "import");
}

function buildAppleHealthSourcePatch(
  source: HealthSource,
  status: Awaited<ReturnType<typeof AppleHealthBridge.getStatus>>,
): Partial<HealthSource> {
  return {
    connectionMode: status.sourceMode,
    permissionState: status.authorizationStatus,
    readableTypes: status.readableTypes,
    writableTypes: status.writableTypes,
    bridgeStatus: status.available ? "available" : "unavailable",
    lastSyncedAt: status.lastSyncedAt ?? source.lastSyncedAt,
    lastError: status.lastError,
  };
}

function buildHealthSyncHistoryEvent(
  sourceId: string,
  action: HealthSyncEvent["action"],
  status: HealthSyncEvent["status"],
  message?: string,
): HealthSyncEvent {
  return {
    id: createId("health-sync-event"),
    sourceId,
    action,
    status,
    message,
    createdAt: now(),
  };
}

function buildAppleHealthPreview(
  source: HealthSource,
  items: HealthWritebackItem[],
  bridgeStatus?: Awaited<ReturnType<typeof AppleHealthBridge.getStatus>>,
): HealthWritebackPreview {
  return {
    sourceId: source.id,
    sourceLabel: sourceLabel(source),
    connectionMode: sourceModeForAppleHealth(source),
    items,
    warnings: [
      ...(bridgeStatus?.available ? [] : ["Apple Health bridge is unavailable on this device."]),
      ...(source.permissionState === "denied"
        ? ["HealthKit permission is denied for this source."]
        : []),
      ...(source.permissionState === "restricted"
        ? ["HealthKit access is restricted by device policy."]
        : []),
    ],
  };
}

function pickMetricTrend(
  previous?: HealthMetric,
  current?: HealthMetric,
): "up" | "down" | "stable" {
  if (!previous) return "stable";
  if (!current) return "stable";
  if (
    current.key === "resting_hr" ||
    current.key === "a1c" ||
    current.key === "glucose" ||
    current.key === "ldl" ||
    current.key === "triglycerides"
  ) {
    if (current.value > previous.value) return "up";
    if (current.value < previous.value) return "down";
    return "stable";
  }
  if (current.value > previous.value) return "up";
  if (current.value < previous.value) return "down";
  return "stable";
}

function generateWearableSnapshot(source: HealthSource): {
  metrics: HealthMetric[];
  records: HealthRecord[];
} {
  const seed = hashString(`${source.id}:${source.name}:${now()}`);
  const steps = 5200 + (seed % 5600);
  const sleep = 330 + (seed % 180);
  const restingHr = 54 + (seed % 14);
  const hrv = 24 + (seed % 34);
  const trainingLoad = 18 + (seed % 42);
  const recordedAt = now();
  const metrics = [
    makeMetric(source, "steps", steps, recordedAt),
    makeMetric(source, "sleep_minutes", sleep, recordedAt),
    makeMetric(source, "resting_hr", restingHr, recordedAt),
    makeMetric(source, "hrv", hrv, recordedAt),
    makeMetric(source, "training_load", trainingLoad, recordedAt),
  ];
  const records = [
    makeRecord(
      source,
      "Wearable daily summary",
      `Steps ${steps.toLocaleString()}, sleep ${Math.floor(sleep / 60)}h ${sleep % 60}m, resting HR ${restingHr} bpm.`,
      ["wearable", "daily"],
      recordedAt,
    ),
    makeRecord(
      source,
      "Recovery trend note",
      trainingLoad > 42
        ? "Training load is elevated; recovery should stay the priority."
        : "Training load is within a moderate range.",
      ["wearable", "recovery"],
      recordedAt,
    ),
  ];
  return { metrics, records };
}

function generateLabSnapshot(source: HealthSource): {
  metrics: HealthMetric[];
  records: HealthRecord[];
} {
  const seed = hashString(`${source.id}:${source.accountLabel || source.name}`);
  const a1c = Number((5.2 + (seed % 9) / 10).toFixed(1));
  const glucose = 92 + (seed % 22);
  const ldl = 88 + (seed % 48);
  const hdl = 42 + (seed % 18);
  const triglycerides = 78 + (seed % 96);
  const recordedAt = now();
  const metrics = [
    makeMetric(source, "a1c", a1c, recordedAt),
    makeMetric(source, "glucose", glucose, recordedAt),
    makeMetric(source, "ldl", ldl, recordedAt),
    makeMetric(source, "hdl", hdl, recordedAt),
    makeMetric(source, "triglycerides", triglycerides, recordedAt),
  ];
  const records = [
    makeRecord(
      source,
      "Lab panel summary",
      `A1C ${a1c.toFixed(1)}%, glucose ${glucose} mg/dL, LDL ${ldl} mg/dL, HDL ${hdl} mg/dL, triglycerides ${triglycerides} mg/dL.`,
      ["labs", "panel"],
      recordedAt,
    ),
  ];
  return { metrics, records };
}

function generateRecordSnapshot(source: HealthSource): {
  metrics: HealthMetric[];
  records: HealthRecord[];
} {
  const seed = hashString(`${source.id}:${source.notes || source.name}`);
  const symptomScore = clamp(3 + (seed % 8), 0, 10);
  const recordedAt = now();
  const metrics = [makeMetric(source, "symptom_score", symptomScore, recordedAt)];
  const records = [
    makeRecord(
      source,
      "Medical record summary",
      `Imported record snapshot with symptom score ${symptomScore}/10 and clinician notes stored locally.`,
      ["record", "summary"],
      recordedAt,
    ),
  ];
  return { metrics, records };
}

function buildSourceSnapshot(source: HealthSource): {
  metrics: HealthMetric[];
  records: HealthRecord[];
} {
  switch (source.kind) {
    case "wearable":
      return generateWearableSnapshot(source);
    case "lab":
      return generateLabSnapshot(source);
    case "record":
      return generateRecordSnapshot(source);
    case "manual":
    default:
      return {
        metrics: [],
        records: [
          makeRecord(
            source,
            "Manual health note",
            source.notes || "Manual source connected for custom tracking.",
            ["manual"],
          ),
        ],
      };
  }
}

function withSourceUpdate(
  sourceId: string,
  updater: (source: HealthSource) => HealthSource,
): HealthState {
  return updateState((state) => {
    const sources = state.sources.map((source) =>
      source.id === sourceId ? updater(source) : source,
    );
    return { ...state, sources };
  });
}

function parseImportedFile(
  filePath: string,
): Promise<{ metrics: HealthMetric[]; records: HealthRecord[] }> {
  return fs.readFile(filePath, "utf-8").then((raw) => {
    const ext = path.extname(filePath).toLowerCase();
    let text = raw;
    if (ext === ".json") {
      try {
        const parsed = JSON.parse(raw) as unknown;
        text = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
      } catch {
        text = raw;
      }
    }

    const parsed = parseImportedText(text);
    return {
      metrics: parsed.metrics.map((entry) => {
        const key = entry.key;
        const meta = metricLabelForKey(key);
        return {
          id: createId("health-metric"),
          key,
          label: meta.label,
          value: entry.value,
          unit: meta.unit,
          recordedAt: now(),
          sourceId: "imported",
          sourceLabel: path.basename(filePath),
        };
      }),
      records: [
        {
          id: createId("health-record"),
          sourceId: "imported",
          sourceLabel: path.basename(filePath),
          kind: "manual",
          title: path.basename(filePath),
          summary: parsed.summary,
          recordedAt: now(),
          provenance: "Imported file",
          tags: ["imported", ext.replace(/^\./, "") || "file"],
          attachments: [path.basename(filePath)],
        },
      ],
    };
  });
}

async function generateWorkflowFromLLM(
  dashboard: HealthDashboard,
  request: HealthWorkflowRequest,
): Promise<HealthWorkflow | null> {
  let providerType = "";
  let modelId = "";
  try {
    const provider = LLMProviderFactory.createProvider();
    providerType = provider.type;
    const relevantSources = request.sourceIds?.length
      ? dashboard.sources.filter((source) => request.sourceIds?.includes(source.id))
      : dashboard.sources;
    const relevantMetrics = dashboard.metrics.filter((metric) =>
      relevantSources.some((source) => source.id === metric.sourceId),
    );
    const relevantRecords = dashboard.records.filter((record) =>
      relevantSources.some((source) => source.id === record.sourceId),
    );
    const relevantInsights = dashboard.insights.filter((insight) =>
      insight.sourceIds.some((sourceId) =>
        relevantSources.some((source) => source.id === sourceId),
      ),
    );

    const system = [
      "You generate compact, non-diagnostic health coaching workflows.",
      "Do not mention diagnosis, treatment, medication changes, or emergency care.",
      "Respond with strict JSON only using this shape:",
      '{ "title": string, "summary": string, "sections": [{ "title": string, "items": string[] }], "disclaimer": string }',
    ].join(" ");

    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                workflowType: request.workflowType,
                sources: relevantSources.map((source) => ({
                  name: source.name,
                  kind: source.kind,
                  provider: source.provider,
                  lastSyncedAt: source.lastSyncedAt,
                })),
                metrics: relevantMetrics.slice(0, 12).map((metric) => ({
                  label: metric.label,
                  value: metric.value,
                  unit: metric.unit,
                  source: metric.sourceLabel,
                })),
                records: relevantRecords.slice(0, 6).map((record) => ({
                  title: record.title,
                  summary: record.summary,
                  source: record.sourceLabel,
                })),
                insights: relevantInsights.slice(0, 6).map((insight) => ({
                  title: insight.title,
                  summary: insight.summary,
                  severity: insight.severity,
                })),
              },
              null,
              2,
            ),
          },
        ],
      },
    ];

    modelId = LLMProviderFactory.loadSettings().modelKey || "sonnet-4-5";
    const response = await provider.createMessage({
      model: modelId,
      maxTokens: 800,
      system,
      messages,
    });
    recordLlmCallSuccess(
      {
        sourceKind: "health_workflow",
        sourceId: request.workflowType,
        providerType,
        modelKey: modelId,
        modelId,
      },
      response.usage,
    );
    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    const jsonText = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    if (!jsonText.startsWith("{")) {
      console.warn(
        "[HealthManager] LLM workflow response missing JSON object:",
        text.slice(0, 200),
      );
      return null;
    }
    let parsed: {
      title?: string;
      summary?: string;
      sections?: HealthWorkflowSection[];
      disclaimer?: string;
    };
    try {
      parsed = JSON.parse(jsonText) as typeof parsed;
    } catch (parseErr) {
      console.warn(
        "[HealthManager] LLM workflow JSON parse failed:",
        parseErr,
        "raw:",
        jsonText.slice(0, 300),
      );
      return null;
    }
    if (!parsed.title || !Array.isArray(parsed.sections)) {
      console.warn("[HealthManager] LLM workflow missing title or sections:", {
        title: parsed.title,
        hasSections: Array.isArray(parsed.sections),
      });
      return null;
    }
    return {
      id: createId("health-workflow"),
      workflowType: request.workflowType,
      title: parsed.title,
      summary: parsed.summary || "",
      sections: parsed.sections.map((section) => ({
        title: section.title,
        items: Array.isArray(section.items) ? section.items.map((item) => String(item)) : [],
      })),
      sourceIds: relevantSources.map((source) => source.id),
      disclaimer: parsed.disclaimer || "Informational only. Not medical advice.",
      createdAt: now(),
    };
  } catch (err) {
    recordLlmCallError(
      {
        sourceKind: "health_workflow",
        sourceId: request.workflowType,
        providerType,
        modelKey: modelId,
        modelId,
      },
      err,
    );
    console.warn("[HealthManager] LLM workflow generation failed:", err);
    return null;
  }
}

function buildWorkflowFallback(
  dashboard: HealthDashboard,
  request: HealthWorkflowRequest,
): HealthWorkflow {
  const relevantSources = request.sourceIds?.length
    ? dashboard.sources.filter((source) => request.sourceIds?.includes(source.id))
    : dashboard.sources;
  const relevantMetrics = dashboard.metrics.filter((metric) =>
    relevantSources.some((source) => source.id === metric.sourceId),
  );
  const byKey = new Map<string, HealthMetric[]>();
  for (const metric of relevantMetrics) {
    const list = byKey.get(metric.key) || [];
    list.push(metric);
    byKey.set(metric.key, list);
  }
  const topStep = byKey.get("steps")?.[0];
  const topSleep = byKey.get("sleep_minutes")?.[0];
  const topA1c = byKey.get("a1c")?.[0];
  const topGlucose = byKey.get("glucose")?.[0];
  const topSymptom = byKey.get("symptom_score")?.[0];

  switch (request.workflowType) {
    case "marathon-training":
      return {
        id: createId("health-workflow"),
        workflowType: request.workflowType,
        title: "Marathon training protocol",
        summary: "Use the current recovery and activity signals to shape the next training block.",
        sections: [
          {
            title: "What to do this week",
            items: [
              topSleep && topSleep.value < 420
                ? "Keep the next long run easy and extend the sleep window."
                : "Keep one quality workout and one long aerobic session.",
              topStep
                ? `Current steps baseline is ${Math.round(topStep.value)}; hold easy movement on recovery days.`
                : "Track daily movement and keep recovery days light.",
              "Use resting HR and HRV to decide whether to push intensity or hold steady.",
            ],
          },
          {
            title: "Signals to watch",
            items: [
              "Sleep consistency",
              "Resting HR trend",
              "Any rise in symptom burden or unusual fatigue",
            ],
          },
        ],
        sourceIds: relevantSources.map((source) => source.id),
        disclaimer: "Informational only. Not medical advice.",
        createdAt: now(),
      };
    case "visit-prep":
      return {
        id: createId("health-workflow"),
        workflowType: request.workflowType,
        title: "Doctor visit prep summary",
        summary: "Summarize the latest health data into a concise pre-visit brief.",
        sections: [
          {
            title: "Bring to the visit",
            items: [
              topA1c ? `A1C: ${topA1c.value.toFixed(1)}%` : "Latest labs",
              topGlucose
                ? `Glucose: ${Math.round(topGlucose.value)} mg/dL`
                : "Recent glucose trends",
              topSymptom
                ? `Symptoms: ${Math.round(topSymptom.value)}/10`
                : "Symptom log and pattern notes",
            ],
          },
          {
            title: "Questions to ask",
            items: [
              "What changed since the last visit?",
              "Which data points matter most to monitor next?",
              "What would make the current pattern more concerning?",
            ],
          },
        ],
        sourceIds: relevantSources.map((source) => source.id),
        disclaimer: "Informational only. Not medical advice.",
        createdAt: now(),
      };
    case "nutrition-plan":
      return {
        id: createId("health-workflow"),
        workflowType: request.workflowType,
        title: "Personalized nutrition plan",
        summary: "Use activity, recovery, and lab signals to guide the next set of food choices.",
        sections: [
          {
            title: "Focus areas",
            items: [
              "Anchor each day with a high-protein breakfast.",
              "Pair training days with higher carbohydrate intake.",
              topGlucose && topGlucose.value >= 110
                ? "Favor fiber-forward meals and limit late heavy meals."
                : "Keep hydration steady and avoid large glucose swings.",
            ],
          },
          {
            title: "Weekly targets",
            items: [
              "Maintain consistent meal timing.",
              "Track how sleep affects hunger and recovery.",
              "Log the meals that best support training and symptom control.",
            ],
          },
        ],
        sourceIds: relevantSources.map((source) => source.id),
        disclaimer: "Informational only. Not medical advice.",
        createdAt: now(),
      };
    case "trend-analysis":
    default:
      return {
        id: createId("health-workflow"),
        workflowType: request.workflowType,
        title: "What changed recently",
        summary: "Compare the most recent signal mix and call out the biggest shifts.",
        sections: [
          {
            title: "Movement and recovery",
            items: [
              topStep ? `Steps baseline: ${Math.round(topStep.value)} steps` : "No step data yet.",
              topSleep
                ? `Sleep: ${Math.floor(topSleep.value / 60)}h ${Math.round(topSleep.value % 60)}m`
                : "No sleep data yet.",
            ],
          },
          {
            title: "Clinical context",
            items: [
              topA1c ? `A1C: ${topA1c.value.toFixed(1)}%` : "No lab data yet.",
              topGlucose
                ? `Glucose: ${Math.round(topGlucose.value)} mg/dL`
                : "No glucose data yet.",
            ],
          },
        ],
        sourceIds: relevantSources.map((source) => source.id),
        disclaimer: "Informational only. Not medical advice.",
        createdAt: now(),
      };
  }
}

export class HealthManager {
  static getDashboard(): HealthDashboard {
    const state = loadState();
    if (state.sources.length === 0 && state.records.length === 0 && state.metrics.length === 0) {
      return toDashboard(createDemoState(), true);
    }
    if (state.insights.length === 0) {
      state.insights = deriveInsights(state);
      saveState(state);
    }
    return toDashboard(state, false);
  }

  static listSources(): HealthSource[] {
    return [...loadState().sources].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  static upsertSource(input: HealthSourceInput): HealthSource {
    const next = updateState((state) => {
      const existing = state.sources.find(
        (source) =>
          source.provider === input.provider &&
          source.name.toLowerCase() === input.name.trim().toLowerCase(),
      );
      const source = normalizeSourceInput(input, existing);
      const sources = existing
        ? state.sources.map((item) => (item.id === existing.id ? source : item))
        : [source, ...state.sources];
      const nextState = { ...state, sources };
      nextState.insights = deriveInsights(nextState);
      return nextState;
    });
    return (
      next.sources.find(
        (source) =>
          source.provider === input.provider &&
          source.name.toLowerCase() === input.name.trim().toLowerCase(),
      ) || normalizeSourceInput(input)
    );
  }

  static removeSource(sourceId: string): { success: boolean } {
    updateState((state) => ({
      ...state,
      sources: state.sources.map((source) =>
        source.id === sourceId
          ? {
              ...source,
              enabled: false,
              status: "disabled",
              syncHistory: [
                ...(source.syncHistory || []),
                buildHealthSyncHistoryEvent(
                  source.id,
                  "disconnect",
                  "success",
                  "Source disabled by user.",
                ),
              ].slice(-20),
              updatedAt: now(),
            }
          : source,
      ),
    }));
    return { success: true };
  }

  static async getAppleHealthStatus(sourceId?: string): Promise<{
    available: boolean;
    authorizationStatus: string;
    readableTypes: string[];
    writableTypes: string[];
    sourceMode: HealthSourceConnectionMode;
    lastSyncedAt?: number;
    lastError?: string;
  }> {
    const state = loadState();
    const source = sourceId
      ? state.sources.find((entry) => entry.id === sourceId)
      : state.sources.find((entry) => entry.provider === "apple-health");
    const mode = source
      ? sourceModeForAppleHealth(source)
      : AppleHealthBridge.isAvailable()
        ? "native"
        : "import";
    if (mode === "import") {
      return {
        available: false,
        authorizationStatus: "import-only",
        readableTypes: [],
        writableTypes: [],
        sourceMode: "import",
        lastSyncedAt: source?.lastSyncedAt,
        lastError: source?.lastError,
      };
    }

    const bridgeStatus = await AppleHealthBridge.getStatus(mode);
    if (source) {
      updateState((current) => ({
        ...current,
        sources: current.sources.map((entry) =>
          entry.id === source.id
            ? {
                ...entry,
                ...buildAppleHealthSourcePatch(entry, bridgeStatus),
                updatedAt: now(),
              }
            : entry,
        ),
      }));
    }
    return bridgeStatus;
  }

  static async connectAppleHealth(payload: {
    sourceId?: string;
    connectionMode?: HealthSourceConnectionMode;
  }): Promise<{ success: boolean; source?: HealthSource; error?: string }> {
    const desiredMode =
      payload.connectionMode || (AppleHealthBridge.isAvailable() ? "native" : "import");
    const template = sourceSeed("apple-health");
    const existing = payload.sourceId
      ? loadState().sources.find(
          (entry) => entry.id === payload.sourceId && entry.provider === "apple-health",
        )
      : undefined;
    const source =
      existing ||
      this.upsertSource({
        provider: "apple-health",
        kind: template.kind,
        name: template.name,
        description: template.description,
        connectionMode: desiredMode,
      });

    if (desiredMode === "import") {
      const nextState = updateState((current) => ({
        ...current,
        sources: current.sources.map((entry) =>
          entry.id === source.id
            ? {
                ...entry,
                connectionMode: "import",
                permissionState: "import-only",
                bridgeStatus: "unavailable",
                status: "connected",
                enabled: true,
                lastError: undefined,
                updatedAt: now(),
              }
            : entry,
        ),
      }));
      const updated = nextState.sources.find((entry) => entry.id === source.id) || source;
      return { success: true, source: updated };
    }

    const status = await AppleHealthBridge.getStatus("native");
    if (!status.available) {
      const nextState = updateState((current) => ({
        ...current,
        sources: current.sources.map((entry) =>
          entry.id === source.id
            ? {
                ...entry,
                connectionMode: "native",
                permissionState: "unavailable",
                bridgeStatus: "unavailable",
                status: "needs-auth",
                enabled: true,
                lastError: status.lastError || "Apple Health bridge is unavailable.",
                updatedAt: now(),
              }
            : entry,
        ),
      }));
      const updated = nextState.sources.find((entry) => entry.id === source.id) || source;
      return {
        success: false,
        source: updated,
        error: status.lastError || "Apple Health bridge is unavailable.",
      };
    }

    const authorization = await AppleHealthBridge.authorize(
      "native",
      sourceReadTypes(source),
      sourceWriteTypes(source),
    );
    const nextState = updateState((current) => ({
      ...current,
      sources: current.sources.map((entry) =>
        entry.id === source.id
          ? {
              ...entry,
              connectionMode: "native",
              permissionState: authorization.authorizationStatus,
              readableTypes: authorization.readableTypes,
              writableTypes: authorization.writableTypes,
              bridgeStatus: "available",
              status: authorization.granted ? "connected" : "needs-auth",
              enabled: true,
              lastError: authorization.granted
                ? undefined
                : "HealthKit authorization was not granted.",
              connectedAt: authorization.granted ? entry.connectedAt || now() : entry.connectedAt,
              updatedAt: now(),
              syncHistory: [
                ...(entry.syncHistory || []),
                buildHealthSyncHistoryEvent(
                  entry.id,
                  "authorize",
                  authorization.granted ? "success" : "error",
                  authorization.granted
                    ? "HealthKit permissions granted."
                    : "HealthKit permissions denied.",
                ),
              ].slice(-20),
            }
          : entry,
      ),
    }));

    const updatedSource = nextState.sources.find((entry) => entry.id === source.id) || source;
    if (!authorization.granted) {
      return {
        success: false,
        source: updatedSource,
        error: "HealthKit authorization was not granted.",
      };
    }

    const syncResult = await this.syncSource(source.id);
    return {
      success: true,
      source: syncResult.source || updatedSource,
    };
  }

  static disconnectAppleHealth(sourceId: string): { success: boolean } {
    updateState((state) => ({
      ...state,
      sources: state.sources.map((source) =>
        source.id === sourceId
          ? {
              ...source,
              status: "disabled",
              enabled: false,
              permissionState:
                source.provider === "apple-health" ? "import-only" : source.permissionState,
              lastError: undefined,
              bridgeStatus:
                source.provider === "apple-health" ? "unavailable" : source.bridgeStatus,
              syncHistory: [
                ...(source.syncHistory || []),
                buildHealthSyncHistoryEvent(
                  source.id,
                  "disconnect",
                  "success",
                  "Apple Health disconnected.",
                ),
              ].slice(-20),
              updatedAt: now(),
            }
          : source,
      ),
    }));
    return { success: true };
  }

  static resetAppleHealth(sourceId?: string): { success: boolean; removedCount: number } {
    const state = loadState();
    const appleSourceIds = state.sources
      .filter(
        (source) => source.provider === "apple-health" && (!sourceId || source.id === sourceId),
      )
      .map((source) => source.id);
    if (appleSourceIds.length === 0) {
      return { success: true, removedCount: 0 };
    }

    updateState((current) => {
      const remainingSources = current.sources.filter(
        (source) => !(source.provider === "apple-health" && appleSourceIds.includes(source.id)),
      );
      const remainingMetrics = current.metrics.filter(
        (metric) => !appleSourceIds.includes(metric.sourceId),
      );
      const remainingRecords = current.records.filter(
        (record) => !appleSourceIds.includes(record.sourceId),
      );
      const remainingInsights = current.insights.filter(
        (insight) => !insight.sourceIds.some((candidate) => appleSourceIds.includes(candidate)),
      );
      const remainingWorkflows = current.workflows.filter(
        (workflow) => !workflow.sourceIds.some((candidate) => appleSourceIds.includes(candidate)),
      );
      return {
        ...current,
        sources: remainingSources,
        metrics: remainingMetrics,
        records: remainingRecords,
        insights: remainingInsights,
        workflows: remainingWorkflows,
      };
    });

    return { success: true, removedCount: appleSourceIds.length };
  }

  static async syncSource(sourceId: string): Promise<HealthSyncResult> {
    const state = loadState();
    const source = state.sources.find((entry) => entry.id === sourceId);
    if (!source) {
      return { ok: false, error: "Health source not found." };
    }
    if (!source.enabled || source.status === "disabled") {
      return { ok: false, error: "Health source is disabled." };
    }

    if (source.provider === "apple-health") {
      const mode = sourceModeForAppleHealth(source);
      if (mode === "import") {
        return {
          ok: false,
          error:
            "Apple Health on this platform is import-only. Import an Apple Health export file instead.",
        };
      }

      const status = await AppleHealthBridge.getStatus("native");
      if (!status.available) {
        updateState((current) => ({
          ...current,
          sources: current.sources.map((entry) =>
            entry.id === sourceId
              ? {
                  ...entry,
                  bridgeStatus: "unavailable",
                  permissionState: "unavailable",
                  lastSyncStatus: "error",
                  lastError: status.lastError || "Apple Health bridge is unavailable.",
                  syncHistory: [
                    ...(entry.syncHistory || []),
                    buildHealthSyncHistoryEvent(
                      entry.id,
                      "sync",
                      "error",
                      status.lastError || "Apple Health bridge is unavailable.",
                    ),
                  ].slice(-20),
                  updatedAt: now(),
                }
              : entry,
          ),
        }));
        return { ok: false, error: status.lastError || "Apple Health bridge is unavailable." };
      }

      const result = await AppleHealthBridge.sync(
        source.id,
        "native",
        sourceReadTypes(source),
        sourceWriteTypes(source),
        source.lastSyncedAt,
      );
      if (!result) {
        updateState((current) => ({
          ...current,
          sources: current.sources.map((entry) =>
            entry.id === sourceId
              ? {
                  ...entry,
                  bridgeStatus: "error",
                  lastSyncStatus: "error",
                  lastError: "Apple Health sync failed.",
                  syncHistory: [
                    ...(entry.syncHistory || []),
                    buildHealthSyncHistoryEvent(
                      entry.id,
                      "sync",
                      "error",
                      "Apple Health sync failed.",
                    ),
                  ].slice(-20),
                  updatedAt: now(),
                }
              : entry,
          ),
        }));
        return { ok: false, error: "Apple Health sync failed." };
      }

      const metrics = result.metrics.map((metric) =>
        makeMetric(source, metricKeyForWritebackType(metric.key), metric.value, metric.recordedAt),
      );
      const records = result.records.map((record) =>
        makeRecord(source, record.title, record.summary, record.tags, record.recordedAt),
      );

      const nextState = updateState((current) => {
        const sources: HealthSource[] = current.sources.map((entry) =>
          entry.id === sourceId
            ? {
                ...entry,
                status: "connected" as const,
                enabled: true,
                connectionMode: "native" as HealthSourceConnectionMode,
                permissionState: result.permissions.write ? "authorized" : "not-determined",
                readableTypes: result.readableTypes,
                writableTypes: result.writableTypes,
                bridgeStatus: "available",
                connectedAt: entry.connectedAt || now(),
                lastSyncedAt: result.lastSyncedAt,
                lastSyncStatus: "success" as const,
                lastError: undefined,
                updatedAt: now(),
                syncHistory: [
                  ...(entry.syncHistory || []),
                  buildHealthSyncHistoryEvent(
                    entry.id,
                    "sync",
                    "success",
                    "HealthKit data synced.",
                  ),
                ].slice(-20),
              }
            : entry,
        );
        const enrichedRecords = records.map((record) => ({
          ...record,
          sourceId: source.id,
          sourceLabel: sourceLabel(source),
        }));
        const enrichedMetrics = metrics.map((metric) => ({
          ...metric,
          sourceId: source.id,
          sourceLabel: sourceLabel(source),
        }));
        const nextState: HealthState = {
          ...current,
          sources,
          records: [...enrichedRecords, ...current.records].slice(0, 200),
          metrics: mergeMetrics(current.metrics, enrichedMetrics),
          insights: [] as HealthInsight[],
          workflows: current.workflows,
        };
        nextState.insights = deriveInsights(nextState);
        return nextState;
      });

      return {
        ok: true,
        source: nextState.sources.find((entry) => entry.id === sourceId),
        metrics: metrics.map((metric) => ({
          ...metric,
          sourceId: source.id,
          sourceLabel: sourceLabel(source),
        })),
        records,
        insights: nextState.insights.filter((insight) => insight.sourceIds.includes(sourceId)),
        workflow: null,
        events: [
          buildHealthSyncHistoryEvent(source.id, "sync", "success", "HealthKit data synced."),
        ],
      };
    }

    const syncing = withSourceUpdate(sourceId, (entry) => ({
      ...entry,
      status: "syncing",
      updatedAt: now(),
    }));

    const snapshot = buildSourceSnapshot(source);
    const metrics = snapshot.metrics.map((metric, index) => {
      const previous = syncing.metrics.filter(
        (item) => item.key === metric.key && item.sourceId === metric.sourceId,
      )[index];
      return {
        ...metric,
        trend: pickMetricTrend(previous, metric),
      };
    });

    const nextState = updateState((current) => {
      const updatedSource = {
        ...source,
        status: "connected" as const,
        enabled: true,
        connectedAt: source.connectedAt || now(),
        lastSyncedAt: now(),
        lastSyncStatus: "success" as const,
        lastError: undefined,
        updatedAt: now(),
      };
      const sources = current.sources.map((entry) =>
        entry.id === sourceId ? updatedSource : entry,
      );
      const records = [...snapshot.records, ...current.records].slice(0, 200);
      const mergedMetrics = mergeMetrics(current.metrics, metrics);
      const nextState = {
        ...current,
        sources,
        records,
        metrics: mergedMetrics,
        insights: [] as HealthInsight[],
        workflows: current.workflows,
      };
      nextState.insights = deriveInsights(nextState);
      return nextState;
    });

    const insightSlice = nextState.insights.filter((insight) =>
      insight.sourceIds.includes(sourceId),
    );
    return {
      ok: true,
      source: nextState.sources.find((entry) => entry.id === sourceId),
      metrics,
      records: snapshot.records,
      insights: insightSlice,
      workflow: null,
      events: [
        buildHealthSyncHistoryEvent(source.id, "sync", "success", "Source synced successfully."),
      ],
    };
  }

  static async importFiles(sourceId: string, filePaths: string[]): Promise<HealthSyncResult> {
    const state = loadState();
    const source = state.sources.find((entry) => entry.id === sourceId);
    if (!source) {
      return { ok: false, error: "Health source not found." };
    }
    if (!source.enabled || source.status === "disabled") {
      return { ok: false, error: "Health source is disabled." };
    }

    const results = await Promise.allSettled(
      filePaths.map((filePath) => parseImportedFile(filePath)),
    );
    const imports: Array<{ metrics: HealthMetric[]; records: HealthRecord[] }> = [];
    const failedFiles: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        imports.push(result.value);
      } else {
        failedFiles.push(filePaths[i] ?? `file ${i}`);
      }
    }
    if (imports.length === 0) {
      const firstRejection = results.find((r) => r.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      const errMsg =
        firstRejection?.reason instanceof Error
          ? firstRejection.reason.message
          : String(firstRejection?.reason ?? "Unknown error");
      return {
        ok: false,
        error: `Failed to import all files: ${failedFiles.join(", ")}. ${errMsg}`,
      };
    }
    const records = imports.flatMap((entry) => entry.records);
    const metrics = imports
      .flatMap((entry) => entry.metrics)
      .map((metric) => ({
        ...metric,
        sourceId,
        sourceLabel: sourceLabel(source),
        recordedAt: now(),
      }));

    const nextState = updateState((current) => {
      const sources = current.sources.map((entry) =>
        entry.id === sourceId
          ? {
              ...entry,
              status: "connected" as const,
              enabled: true,
              lastSyncedAt: now(),
              lastSyncStatus: "success" as const,
              syncHistory: [
                ...(entry.syncHistory || []),
                buildHealthSyncHistoryEvent(
                  entry.id,
                  "import",
                  "success",
                  "Imported health files.",
                ),
              ].slice(-20),
              updatedAt: now(),
            }
          : entry,
      );
      const enrichedRecords = records.map((record) => ({
        ...record,
        sourceId,
        sourceLabel: sourceLabel(source),
        provenance: source.provenance,
      }));
      const enrichedMetrics = metrics.map((metric) => ({
        ...metric,
        sourceId,
        sourceLabel: sourceLabel(source),
      }));
      const nextState = {
        ...current,
        sources,
        records: [...enrichedRecords, ...current.records].slice(0, 200),
        metrics: mergeMetrics(current.metrics, enrichedMetrics),
        insights: [] as HealthInsight[],
        workflows: current.workflows,
      };
      nextState.insights = deriveInsights(nextState);
      return nextState;
    });

    const events: HealthSyncEvent[] = [
      buildHealthSyncHistoryEvent(
        source.id,
        "import",
        failedFiles.length > 0 ? "partial" : "success",
        failedFiles.length > 0
          ? `Imported ${imports.length} file(s). Failed: ${failedFiles.join(", ")}.`
          : "Imported health files.",
      ),
    ];
    return {
      ok: true,
      source: nextState.sources.find((entry) => entry.id === sourceId),
      metrics,
      records,
      insights: nextState.insights.filter((insight) => insight.sourceIds.includes(sourceId)),
      workflow: null,
      events,
    };
  }

  static async previewAppleHealthWriteback(request: HealthWritebackRequest): Promise<{
    success: boolean;
    preview?: HealthWritebackPreview;
    error?: string;
  }> {
    const state = loadState();
    const source = state.sources.find((entry) => entry.id === request.sourceId);
    if (!source) {
      return { success: false, error: "Health source not found." };
    }
    if (source.provider !== "apple-health") {
      return {
        success: false,
        error: "Writeback preview is only available for Apple Health sources.",
      };
    }

    const status =
      sourceModeForAppleHealth(source) === "native"
        ? await AppleHealthBridge.getStatus("native")
        : undefined;
    const preview = buildAppleHealthPreview(source, request.items, status);
    return { success: true, preview };
  }

  static async applyAppleHealthWriteback(request: HealthWritebackRequest): Promise<{
    success: boolean;
    writtenCount?: number;
    warnings?: string[];
    error?: string;
  }> {
    const state = loadState();
    const source = state.sources.find((entry) => entry.id === request.sourceId);
    if (!source) {
      return { success: false, error: "Health source not found." };
    }
    if (source.provider !== "apple-health") {
      return { success: false, error: "Writeback is only available for Apple Health sources." };
    }
    if (sourceModeForAppleHealth(source) !== "native") {
      return {
        success: false,
        error: "Apple Health writeback requires a native macOS connection.",
      };
    }

    const result = await AppleHealthBridge.write(source.id, "native", request.items);
    if (!result) {
      updateState((current) => ({
        ...current,
        sources: current.sources.map((entry) =>
          entry.id === source.id
            ? {
                ...entry,
                lastSyncStatus: "error",
                lastError: "Apple Health writeback failed.",
                syncHistory: [
                  ...(entry.syncHistory || []),
                  buildHealthSyncHistoryEvent(
                    entry.id,
                    "write",
                    "error",
                    "Apple Health writeback failed.",
                  ),
                ].slice(-20),
                updatedAt: now(),
              }
            : entry,
        ),
      }));
      return { success: false, error: "Apple Health writeback failed." };
    }

    updateState((current) => ({
      ...current,
      sources: current.sources.map((entry) =>
        entry.id === source.id
          ? {
              ...entry,
              lastSyncStatus: "success",
              lastError: undefined,
              syncHistory: [
                ...(entry.syncHistory || []),
                buildHealthSyncHistoryEvent(
                  entry.id,
                  "write",
                  "success",
                  `Wrote ${result.writtenCount} item(s) to Apple Health.`,
                ),
              ].slice(-20),
              updatedAt: now(),
            }
          : entry,
      ),
    }));

    return {
      success: true,
      writtenCount: result.writtenCount,
      warnings: result.warnings,
    };
  }

  static async generateWorkflow(
    request: HealthWorkflowRequest,
  ): Promise<{ success: boolean; workflow?: HealthWorkflow; error?: string }> {
    const dashboard = this.getDashboard();
    const llmWorkflow = await generateWorkflowFromLLM(dashboard, request).catch(() => null);
    const workflow = llmWorkflow || buildWorkflowFallback(dashboard, request);
    updateState((state) => ({
      ...state,
      workflows: [workflow, ...state.workflows].slice(0, 20),
    }));
    return { success: true, workflow };
  }
}
