/**
 * Types for the Playwright automated QA system.
 *
 * The QA pipeline runs after code builds to automatically test
 * the app using Playwright — navigating like a real user,
 * identifying bugs, and feeding issues back to the agent for fixing.
 */

export type QARunStatus =
  | "idle"
  | "starting_server"
  | "launching_browser"
  | "navigating"
  | "testing"
  | "analyzing"
  | "fixing"
  | "retesting"
  | "completed"
  | "failed";

export type QASeverity = "critical" | "major" | "minor" | "info";

export type QACheckType =
  | "visual_snapshot"
  | "console_errors"
  | "network_errors"
  | "interaction_test"
  | "responsive_check"
  | "accessibility_check"
  | "performance_check";

export interface QAIssue {
  id: string;
  type: QACheckType;
  severity: QASeverity;
  title: string;
  description: string;
  /** Screenshot path showing the issue */
  screenshotPath?: string;
  /** CSS selector or element description */
  element?: string;
  /** URL where the issue was found */
  url: string;
  /** Console error message if applicable */
  consoleMessage?: string;
  /** Network request details if applicable */
  networkDetails?: {
    url: string;
    status: number;
    method: string;
  };
  /** Whether this issue was auto-fixed */
  fixed: boolean;
  /** The fix description if auto-fixed */
  fixDescription?: string;
  /** Timestamp */
  timestamp: number;
}

export interface QACheck {
  type: QACheckType;
  label: string;
  description: string;
  /** Whether this check passed */
  passed: boolean;
  /** Issues found during this check */
  issues: QAIssue[];
  /** Screenshot taken during/after the check */
  screenshotPath?: string;
  /** Duration in ms */
  durationMs: number;
}

export interface QAInteractionStep {
  action: "navigate" | "click" | "fill" | "hover" | "scroll" | "wait" | "screenshot" | "assert";
  selector?: string;
  value?: string;
  url?: string;
  description: string;
  /** Screenshot after this step */
  screenshotPath?: string;
  /** Whether the step succeeded */
  success: boolean;
  error?: string;
  durationMs: number;
}

export interface QARunConfig {
  /** URL to test (e.g., http://localhost:3000) */
  targetUrl: string;
  /** Dev server command to start (e.g., "npm run dev") */
  serverCommand?: string;
  /** Working directory for the server command */
  serverCwd?: string;
  /** Port to wait for before starting tests */
  serverPort?: number;
  /** Max time to wait for server startup (ms) */
  serverStartupTimeout?: number;
  /** Viewport sizes to test */
  viewports?: Array<{ width: number; height: number; label: string }>;
  /** Whether to run in headless mode */
  headless?: boolean;
  /** Custom interaction steps to run */
  interactionSteps?: QAInteractionStep[];
  /** Which check types to run */
  enabledChecks?: QACheckType[];
  /** Max time for entire QA run (ms) */
  timeout?: number;
  /** Whether to auto-fix discovered issues */
  autoFix?: boolean;
  /** Max auto-fix attempts before giving up */
  maxFixAttempts?: number;
}

export interface QARun {
  id: string;
  taskId: string;
  status: QARunStatus;
  config: QARunConfig;
  checks: QACheck[];
  interactionLog: QAInteractionStep[];
  issues: QAIssue[];
  /** Summary screenshot of the final state */
  finalScreenshotPath?: string;
  /** Number of fix attempts made */
  fixAttempts: number;
  /** Total duration in ms */
  durationMs: number;
  startedAt: number;
  completedAt?: number;
  /** Human-readable summary */
  summary?: string;
}

export interface QAEvent {
  type: "qa:status" | "qa:check" | "qa:issue" | "qa:step" | "qa:screenshot" | "qa:complete";
  runId: string;
  taskId: string;
  data: Partial<QARun> & {
    check?: QACheck;
    issue?: QAIssue;
    step?: QAInteractionStep;
    screenshotPath?: string;
  };
  timestamp: number;
}

/** Default viewports for responsive testing */
export const DEFAULT_VIEWPORTS = [
  { width: 1280, height: 720, label: "Desktop" },
  { width: 768, height: 1024, label: "Tablet" },
  { width: 375, height: 812, label: "Mobile" },
] as const;

/** Default checks to run */
export const DEFAULT_ENABLED_CHECKS: QACheckType[] = [
  "visual_snapshot",
  "console_errors",
  "network_errors",
  "interaction_test",
];

/** Default QA run configuration */
export const DEFAULT_QA_CONFIG: Partial<QARunConfig> = {
  headless: true,
  viewports: [...DEFAULT_VIEWPORTS],
  enabledChecks: DEFAULT_ENABLED_CHECKS,
  timeout: 120_000,
  serverStartupTimeout: 30_000,
  autoFix: true,
  maxFixAttempts: 3,
};
