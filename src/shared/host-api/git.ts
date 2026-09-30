import type { WebErrorCode } from "./contracts";

export interface BrowserGitFileStatus {
  /** The destination or current path, relative to the authorized workspace. */
  path: string;
  /** The source path for a rename, also relative to the authorized workspace. */
  oldPath?: string;
  /** Git's two-character porcelain status, for example " M" or "A ". */
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface BrowserGitStatusSummary {
  workspaceId: string;
  isRepository: boolean;
  branch: string | null;
  revision: string | null;
  clean: boolean;
  changedFiles: number;
  stagedChanges: number;
  unstagedChanges: number;
  untrackedFiles: number;
  conflictedFiles: number;
  files: BrowserGitFileStatus[];
  filesTruncated: boolean;
  truncated: boolean;
}

export interface BrowserGitDiffSummary {
  workspaceId: string;
  isRepository: boolean;
  staged: boolean;
  relativePath: string | null;
  diff: string;
  truncated: boolean;
}

export type BrowserGitAction = "stage" | "unstage" | "commit";

export interface BrowserGitMutationInput {
  workspaceId: string;
  expectedRevision: string;
  relativePaths?: string[];
  message?: string;
}

/** Persisted intent used to reconcile Git mutations after a lost reply or host restart. */
export interface BrowserGitMutationIntent extends BrowserGitMutationInput {
  action: BrowserGitAction;
  expectedHead: string | null;
  expectedTree: string;
}

export interface BrowserGitMutationResult {
  workspaceId: string;
  action: BrowserGitAction;
  outcome: "applied" | "reconciled";
  revision: string;
  branch: string | null;
  changedFiles: number;
  stagedChanges: number;
  commitSha?: string;
  filesChanged?: number;
}

export interface BrowserGitMutationReceipt {
  fingerprint: string;
  intent: BrowserGitMutationIntent;
  state: "pending" | "completed";
  result?: BrowserGitMutationResult;
}

export interface BrowserGitApi {
  status(workspaceId: string): Promise<BrowserGitStatusSummary>;
  diff(request: {
    workspaceId: string;
    staged?: boolean;
    relativePath?: string | null;
  }): Promise<BrowserGitDiffSummary>;
  stage(request: BrowserGitMutationInput): Promise<BrowserGitMutationResult>;
  unstage(request: BrowserGitMutationInput): Promise<BrowserGitMutationResult>;
  commit(request: BrowserGitMutationInput): Promise<BrowserGitMutationResult>;
}

export interface BrowserGitMutationReceipts {
  reserve(
    scopedKey: string,
    fingerprint: string,
    intent: BrowserGitMutationIntent,
  ): Promise<{ created: boolean; receipt: BrowserGitMutationReceipt }>;
  complete(scopedKey: string, result: BrowserGitMutationResult): Promise<void>;
  get(scopedKey: string): Promise<BrowserGitMutationReceipt | null>;
}

export interface BrowserGitStoredMutationError {
  code: WebErrorCode;
  message: string;
  retryable: boolean;
}
