export type LocalPreviewTemplateId = "npm-dev" | "pnpm-dev" | "yarn-dev" | "bun-dev";

export interface LocalPreviewCommandTemplate {
  id: LocalPreviewTemplateId;
  label: string;
  executable: string;
  args: string[];
  description: string;
}

export interface LocalPreviewStartRequest {
  taskId: string;
  workspaceId: string;
  templateId: LocalPreviewTemplateId;
  workingDirectory?: string;
  port?: number;
  healthPath?: string;
}

export type LocalPreviewProcessStatus = "starting" | "ready" | "stopped" | "failed";

export interface LocalPreviewProcessInfo {
  id: string;
  taskId: string;
  workspaceId: string;
  workspacePath: string;
  workingDirectory: string;
  templateId: LocalPreviewTemplateId;
  command: string;
  host: "127.0.0.1";
  port: number;
  url: string;
  healthUrl: string;
  status: LocalPreviewProcessStatus;
  pid?: number;
  exitCode?: number | null;
  lastError?: string;
  startedAt: number;
  updatedAt: number;
  logs: string[];
}

export interface LocalPreviewHealthResult {
  previewId: string;
  url: string;
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  error?: string;
  checkedAt: number;
}

export interface LocalPreviewLogEvent {
  previewId: string;
  stream: "stdout" | "stderr";
  output: string;
  timestamp: number;
}
