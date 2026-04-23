export type ChronicleMode = "hybrid";
export type ChronicleCaptureScope = "frontmost_display" | "all_displays";

export interface ChronicleSourceReference {
  kind: "url" | "file" | "app";
  value: string;
  label?: string;
}

export interface ChronicleSettings {
  enabled: boolean;
  mode: ChronicleMode;
  paused: boolean;
  captureIntervalSeconds: number;
  retentionMinutes: number;
  maxFrames: number;
  captureScope: ChronicleCaptureScope;
  backgroundGenerationEnabled: boolean;
  respectWorkspaceMemory: boolean;
  consentAcceptedAt?: number | null;
}

export interface ChronicleCaptureStatus {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  mode: ChronicleMode;
  paused: boolean;
  captureIntervalSeconds: number;
  retentionMinutes: number;
  maxFrames: number;
  captureScope: ChronicleCaptureScope;
  frameCount: number;
  bufferBytes: number;
  lastCaptureAt: number | null;
  lastGeneratedAt: number | null;
  consentRequired: boolean;
  accessibilityTrusted: boolean;
  ocrAvailable: boolean;
  screenCaptureStatus: "granted" | "denied" | "not-determined" | "unknown";
  reason?: string;
}

export interface ChronicleBufferedFrame {
  id: string;
  capturedAt: number;
  displayId: string;
  appName: string;
  windowTitle: string;
  imagePath: string;
  localTextSnippet?: string;
  sourceRef?: ChronicleSourceReference | null;
  width: number;
  height: number;
}

export interface ChronicleResolvedContext {
  observationId: string;
  capturedAt: number;
  displayId: string;
  appName: string;
  windowTitle: string;
  imagePath: string;
  localTextSnippet: string;
  confidence: number;
  usedFallback: boolean;
  provenance: "untrusted_screen_text";
  sourceRef?: ChronicleSourceReference | null;
  width: number;
  height: number;
}

export interface ChronicleQueryOptions {
  query: string;
  limit?: number;
  useFallback?: boolean;
}

export interface ChroniclePersistedObservation extends ChronicleResolvedContext {
  id: string;
  promotedAt: number;
  workspaceId: string;
  taskId: string;
  query: string;
  destinationHints: string[];
  memoryId?: string;
  memoryGeneratedAt?: number;
}
