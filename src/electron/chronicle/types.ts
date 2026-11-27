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
  /**
   * Apps Chronicle never captures: while one of them is in front, the capture is skipped.
   * Password managers by default.
   */
  excludedApps: ChronicleExcludedApp[];
}

export interface ChronicleExcludedApp {
  /** macOS bundle identifier, such as `com.1password.1password`. */
  bundleId: string;
  name: string;
}

/** One frame of the recent-screen buffer, as the timeline in Settings shows it. */
export interface ChronicleTimelineFrame {
  id: string;
  capturedAt: number;
  appName: string;
  bundleId?: string;
  windowTitle: string;
  /** A small JPEG of the frame, or null when it could not be read. */
  thumbnailDataUrl: string | null;
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
  /** The last time a capture was skipped because an excluded app was in front. */
  lastExclusionSkipAt?: number | null;
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
  /** The app in front when the frame was taken; absent on frames from before it was kept. */
  bundleId?: string;
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
