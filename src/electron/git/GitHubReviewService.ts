import { execFile } from "child_process";
import { GitService } from "./GitService";
import type {
  GithubPullRequestReviewSummary,
  GithubPullRequestReviewThread,
  GithubReviewThreadState,
} from "../../shared/types";

type GhPrView = {
  number?: number;
  url?: string;
  headRefName?: string;
  baseRefName?: string;
};

type GhReviewThread = {
  id?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: {
    nodes?: GhReviewComment[];
  };
};

type GhReviewComment = {
  id?: string;
  author?: { login?: string };
  body?: string;
  path?: string;
  line?: number | null;
  originalLine?: number | null;
  diffHunk?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
};

type GhReviewThreadsResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: GhReviewThread[];
          pageInfo?: {
            hasNextPage?: boolean;
            endCursor?: string | null;
          };
        };
      };
    };
  };
  errors?: Array<{ message?: string }>;
};

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 100) {
            nodes {
              id
              author {
                login
              }
              body
              path
              line
              originalLine
              diffHunk
              url
              createdAt
              updatedAt
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

export class GitHubReviewService {
  static async getReviewSummary(workspacePath: string): Promise<GithubPullRequestReviewSummary> {
    const repoRoot = await GitService.getRepoRoot(workspacePath);
    const branch = await GitService.getCurrentBranch(repoRoot);
    const repository = await this.resolveRepository(repoRoot);
    const pr = await this.getPrView(repoRoot);
    const prNumber = typeof pr.number === "number" ? pr.number : undefined;
    const prUrl = typeof pr.url === "string" ? pr.url : undefined;

    const threads = prNumber ? await this.getReviewThreads(repoRoot, repository, prNumber) : [];

    return {
      repository,
      repoRoot,
      branch,
      prNumber,
      prUrl,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      threads: this.normalizeThreads({
        repository,
        prNumber,
        prUrl,
        threads,
      }),
    };
  }

  static buildAddressPrompt(summary: GithubPullRequestReviewSummary, threadIds: string[]): string {
    const selected = summary.threads.filter((thread) => threadIds.includes(thread.id));
    const targetThreads =
      selected.length > 0 ? selected : summary.threads.filter((thread) => thread.state === "open");
    const lines = [
      `Address GitHub PR review comments for ${summary.repository}${summary.prNumber ? `#${summary.prNumber}` : ""}.`,
      summary.prUrl ? `PR URL: ${summary.prUrl}` : "",
      `Current branch: ${summary.branch}`,
      summary.baseRefName ? `Base branch: ${summary.baseRefName}` : "",
      "",
      "For each selected review comment:",
      "- inspect the referenced file and nearby code",
      "- make the smallest appropriate code change",
      "- run focused tests or explain why they were not run",
      "- report each comment as fixed, explained/no-code-change, blocked, or obsolete/outdated",
      "- do not reply to or resolve comments on GitHub unless I explicitly ask",
      "",
      "Selected review comments:",
    ].filter(Boolean);

    targetThreads.forEach((thread, index) => {
      lines.push("");
      lines.push(
        `${index + 1}. ${thread.path || "General PR comment"}${thread.line ? `:${thread.line}` : ""}`,
      );
      lines.push(`   Author: ${thread.author}`);
      lines.push(`   State: ${thread.state}`);
      lines.push(`   URL: ${thread.url}`);
      if (thread.diffHunk) {
        lines.push("   Diff hunk:");
        lines.push(indentBlock(thread.diffHunk, "   "));
      }
      lines.push("   Thread comments:");
      for (const comment of thread.comments.length > 0
        ? thread.comments
        : [{ author: thread.author, body: thread.body }]) {
        lines.push(`   - ${comment.author}:`);
        lines.push(indentBlock(comment.body, "     "));
      }
    });

    return lines.join("\n");
  }

  private static async resolveRepository(repoRoot: string): Promise<string> {
    const remotes = await GitService.getRemotes(repoRoot);
    const origin = remotes.find((remote) => remote.name === "origin") || remotes[0];
    const normalized = origin ? GitService.normalizeGithubRepoIdentity(origin.url) : null;
    return normalized || "unknown/repository";
  }

  private static async getPrView(repoRoot: string): Promise<GhPrView> {
    const fields = ["number", "url", "headRefName", "baseRefName"].join(",");
    const { stdout } = await execGh(["pr", "view", "--json", fields], repoRoot);
    return JSON.parse(stdout || "{}") as GhPrView;
  }

  private static async getReviewThreads(
    repoRoot: string,
    repository: string,
    prNumber: number,
  ): Promise<GhReviewThread[]> {
    const [owner, name] = repository.split("/");
    if (!owner || !name || owner === "unknown") {
      throw new Error("Could not resolve GitHub repository owner/name from git remote.");
    }
    const threads: GhReviewThread[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const args = [
        "api",
        "graphql",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${prNumber}`,
        "-f",
        `query=${REVIEW_THREADS_QUERY}`,
      ];
      if (after) {
        args.push("-f", `after=${after}`);
      }
      const { stdout } = await execGh(args, repoRoot);
      const parsed = JSON.parse(stdout || "{}") as GhReviewThreadsResponse;
      if (parsed.errors?.length) {
        throw new Error(
          parsed.errors
            .map((error) => error.message)
            .filter(Boolean)
            .join("; "),
        );
      }
      const pageData = parsed.data?.repository?.pullRequest?.reviewThreads;
      threads.push(...(pageData?.nodes || []));
      if (!pageData?.pageInfo?.hasNextPage || !pageData.pageInfo.endCursor) {
        break;
      }
      after = pageData.pageInfo.endCursor;
    }
    return threads;
  }

  private static normalizeThreads(input: {
    repository: string;
    prNumber?: number;
    prUrl?: string;
    threads: GhReviewThread[];
  }): GithubPullRequestReviewThread[] {
    const out: GithubPullRequestReviewThread[] = [];
    for (const thread of input.threads) {
      const comments = thread.comments?.nodes || [];
      const latest = comments[comments.length - 1];
      if (!latest) continue;
      const state = normalizeThreadState(thread);
      const normalizedComments = comments.map((comment, commentIndex) => ({
        id: comment.id || `${thread.id || latest.id || "comment"}:${commentIndex}`,
        author: comment.author?.login || "unknown",
        body: comment.body || "",
        url: comment.url || input.prUrl || "",
        createdAt: parseTimestamp(comment.createdAt),
        updatedAt: comment.updatedAt ? parseTimestamp(comment.updatedAt) : undefined,
      }));
      out.push({
        id:
          thread.id || latest.id || `${latest.path || "comment"}:${latest.createdAt || out.length}`,
        prNumber: input.prNumber || 0,
        repository: input.repository,
        url: latest.url || input.prUrl || "",
        path: latest.path || undefined,
        line: typeof latest.line === "number" ? latest.line : undefined,
        originalLine: typeof latest.originalLine === "number" ? latest.originalLine : undefined,
        diffHunk: latest.diffHunk || undefined,
        author: latest.author?.login || "unknown",
        body: latest.body || "",
        comments: normalizedComments,
        state,
        createdAt: parseTimestamp(latest.createdAt),
        updatedAt: latest.updatedAt ? parseTimestamp(latest.updatedAt) : undefined,
      });
    }
    return out.sort((a, b) => {
      if (a.state !== b.state) return a.state === "open" ? -1 : 1;
      return (a.path || "").localeCompare(b.path || "") || (a.line || 0) - (b.line || 0);
    });
  }
}

function normalizeThreadState(thread: GhReviewThread): GithubReviewThreadState {
  if (thread.isResolved === true) return "resolved";
  if (thread.isOutdated === true) return "outdated";
  if (thread.isResolved === false) return "open";
  return "unknown";
}

function parseTimestamp(value?: string): number {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function indentBlock(value: string, prefix: string): string {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function execGh(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message || "gh command failed"));
        } else {
          resolve({ stdout: stdout || "", stderr: stderr || "" });
        }
      },
    );
  });
}
