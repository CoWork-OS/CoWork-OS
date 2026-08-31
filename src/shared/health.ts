export type HealthSourceKind = "wearable" | "lab" | "record" | "manual";
export type HealthSourceConnectionMode = "native" | "import";
export type HealthKitPermissionState =
  | "not-determined"
  | "authorized"
  | "denied"
  | "restricted"
  | "import-only"
  | "unavailable";
export type HealthWritebackType =
  | "steps"
  | "sleep"
  | "heart_rate"
  | "hrv"
  | "weight"
  | "workout"
  | "labs"
  | "glucose"
  | "nutrition"
  | "custom";

export type HealthSourceProvider =
  | "apple-health"
  | "fitbit"
  | "oura"
  | "garmin"
  | "whoop"
  | "lab-results"
  | "medical-records"
  | "custom";

export type HealthSourceStatus = "connected" | "syncing" | "needs-auth" | "disabled" | "error";

export type HealthWorkflowType =
  | "marathon-training"
  | "visit-prep"
  | "nutrition-plan"
  | "trend-analysis";

export type HealthInsightSeverity = "info" | "watch" | "action";

export type HealthMetricKey =
  | "steps"
  | "sleep_minutes"
  | "resting_hr"
  | "hrv"
  | "training_load"
  | "weight"
  | "glucose"
  | "a1c"
  | "ldl"
  | "hdl"
  | "triglycerides"
  | "symptom_score";

export interface HealthSourceTemplate {
  provider: HealthSourceProvider;
  kind: HealthSourceKind;
  name: string;
  description: string;
  connectionModes?: HealthSourceConnectionMode[];
}

export interface HealthSource {
  id: string;
  provider: HealthSourceProvider;
  kind: HealthSourceKind;
  name: string;
  description: string;
  status: HealthSourceStatus;
  enabled: boolean;
  accountLabel?: string;
  notes?: string;
  provenance: string;
  connectionMode?: HealthSourceConnectionMode;
  permissionState?: HealthKitPermissionState;
  readableTypes?: HealthWritebackType[];
  writableTypes?: HealthWritebackType[];
  syncHistory?: HealthSyncEvent[];
  bridgeStatus?: "available" | "unavailable" | "error";
  connectedAt?: number;
  lastSyncedAt?: number;
  lastSyncStatus?: "success" | "partial" | "error";
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HealthMetric {
  id: string;
  key: HealthMetricKey;
  label: string;
  value: number;
  unit: string;
  recordedAt: number;
  sourceId: string;
  sourceLabel: string;
  trend?: "up" | "down" | "stable";
}

export interface HealthRecord {
  id: string;
  sourceId: string;
  sourceLabel: string;
  kind: HealthSourceKind;
  title: string;
  summary: string;
  recordedAt: number;
  provenance: string;
  tags: string[];
  attachments?: string[];
}

export interface HealthSyncEvent {
  id: string;
  sourceId: string;
  action: "authorize" | "sync" | "import" | "write" | "disconnect";
  status: "success" | "partial" | "error";
  message?: string;
  createdAt: number;
}

export interface HealthInsight {
  id: string;
  title: string;
  summary: string;
  detail: string;
  severity: HealthInsightSeverity;
  sourceIds: string[];
  metricKeys: HealthMetricKey[];
  createdAt: number;
}

export interface HealthWorkflowSection {
  title: string;
  items: string[];
}

export interface HealthWorkflow {
  id: string;
  workflowType: HealthWorkflowType;
  title: string;
  summary: string;
  sections: HealthWorkflowSection[];
  sourceIds: string[];
  disclaimer: string;
  createdAt: number;
}

export interface HealthState {
  version: 1;
  sources: HealthSource[];
  metrics: HealthMetric[];
  records: HealthRecord[];
  insights: HealthInsight[];
  workflows: HealthWorkflow[];
  lastUpdatedAt: number;
}

export interface HealthDashboard {
  generatedAt: number;
  isDemo: boolean;
  stats: {
    sourceCount: number;
    connectedCount: number;
    syncingCount: number;
    recordsCount: number;
    metricsCount: number;
    insightsCount: number;
    workflowsCount: number;
  };
  sources: HealthSource[];
  metrics: HealthMetric[];
  records: HealthRecord[];
  insights: HealthInsight[];
  workflows: HealthWorkflow[];
}

export interface HealthSourceInput {
  provider: HealthSourceProvider;
  kind: HealthSourceKind;
  name: string;
  description?: string;
  accountLabel?: string;
  notes?: string;
  connectionMode?: HealthSourceConnectionMode;
}

export interface HealthSyncResult {
  ok: boolean;
  source?: HealthSource;
  metrics?: HealthMetric[];
  records?: HealthRecord[];
  insights?: HealthInsight[];
  workflow?: HealthWorkflow | null;
  events?: HealthSyncEvent[];
  error?: string;
}

export interface HealthWorkflowRequest {
  workflowType: HealthWorkflowType;
  sourceIds?: string[];
}

export interface HealthWritebackItem {
  id: string;
  type: HealthWritebackType;
  label: string;
  value: string;
  unit?: string;
  startDate?: number;
  endDate?: number;
  sourceId?: string;
}

export interface HealthWritebackPreview {
  sourceId: string;
  sourceLabel: string;
  connectionMode: HealthSourceConnectionMode;
  items: HealthWritebackItem[];
  warnings: string[];
}

export interface HealthWritebackRequest {
  sourceId: string;
  items: HealthWritebackItem[];
}

export const HEALTH_SOURCE_TEMPLATES: HealthSourceTemplate[] = [
  {
    provider: "apple-health",
    kind: "wearable",
    name: "Apple Health",
    description:
      "Steps, sleep, heart rate, and activity from Apple Health on macOS; export imports elsewhere.",
    connectionModes: ["native", "import"],
  },
  {
    provider: "fitbit",
    kind: "wearable",
    name: "Fitbit",
    description: "Wearable activity, recovery, and sleep trends.",
    connectionModes: ["native", "import"],
  },
  {
    provider: "oura",
    kind: "wearable",
    name: "Oura",
    description: "Sleep, readiness, recovery, and body signals.",
    connectionModes: ["native", "import"],
  },
  {
    provider: "garmin",
    kind: "wearable",
    name: "Garmin",
    description: "Training load, activity, and recovery from Garmin.",
    connectionModes: ["native", "import"],
  },
  {
    provider: "whoop",
    kind: "wearable",
    name: "WHOOP",
    description: "Strain, recovery, sleep, and performance markers.",
    connectionModes: ["native", "import"],
  },
  {
    provider: "lab-results",
    kind: "lab",
    name: "Lab Results",
    description: "Lab imports from PDFs, text exports, or structured JSON.",
    connectionModes: ["import"],
  },
  {
    provider: "medical-records",
    kind: "record",
    name: "Medical Records",
    description: "Clinic notes, visit summaries, and record exports.",
    connectionModes: ["import"],
  },
];
