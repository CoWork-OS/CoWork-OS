import { z } from "zod";
import type {
  OutcomeContractRequirement,
  OutcomeContractStatus,
  ArtifactRevisionStatus,
  TaskStatus,
  Workspace,
  AgentConfig,
  Task,
} from "./types";
const id = z.string().trim().min(1).max(128);
export const botWorkResultRequestSchema = z
  .object({ workspaceId: id, agentRoleId: id, taskId: id })
  .strict();
export type BotWorkResultRequest = z.infer<typeof botWorkResultRequestSchema>;
export interface BotWorkResult {
  request: BotWorkResultRequest;
  title: string;
  status: TaskStatus;
  checkedAt: number;
  recordedVerification: "passed" | "failed" | "partial" | "unverified";
  delivery: "unknown";
  contract: null | {
    id: string;
    version: number;
    objective: string;
    status: OutcomeContractStatus;
    requirements: Array<
      Pick<
        OutcomeContractRequirement,
        "id" | "kind" | "description" | "required" | "status" | "verifier"
      > & { currentEvidence: "matches" | "failed" | "unconfirmed" | "waived" }
    >;
  };
  outputs: Array<{
    id: string;
    artifactId?: string;
    path: string;
    revision: number;
    sha256: string;
    status: ArtifactRevisionStatus;
    check: "matches" | "changed" | "missing" | "unavailable" | "not_current";
    reason?: string;
  }>;
  evidence: Array<{
    id: string;
    claim: string;
    sourceType: string;
    capturedAt: number;
    status: string;
  }>;
  truncated: boolean;
  issues: string[];
}
/** Internal storage snapshot; task policy and workspace fields never cross the public API. */
export interface BotWorkResultManifest {
  request: BotWorkResultRequest;
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    source?: Task["source"];
    agentConfig?: AgentConfig;
    policyValid: boolean;
    recordedVerification: BotWorkResult["recordedVerification"];
  };
  workspace: Workspace;
  contract: null | {
    id: string;
    version: number;
    objective: string;
    status: OutcomeContractStatus;
    requirements: OutcomeContractRequirement[];
  };
  artifacts: Array<{
    id: string;
    artifactId?: string;
    path: string;
    revision: number;
    sha256: string;
    size: number;
    status: ArtifactRevisionStatus;
  }>;
  evidence: Array<{
    id: string;
    claim: string;
    sourceType: string;
    capturedAt: number;
    expiresAt?: number;
    status: string;
    artifactRevisionId?: string;
  }>;
  truncated: boolean;
  issues: string[];
  checksum: string;
}
