import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";
import { fileDiscoveryService } from "./file-discovery-client";
import type { GlobResult } from "./glob-discovery";

/**
 * GlobTools provides fast pattern-based file search
 * Similar to Claude Code's Glob tool for finding files by pattern
 */
export class GlobTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  /**
   * Update the workspace for this tool
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * Get tool definitions for Glob tools
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "glob",
        description:
          'Fast file pattern matching tool. Use glob patterns like "**/*.ts" or "src/**/*.tsx" to find files. ' +
          "Returns matching file paths sorted by modification time (newest first). " +
          "PREFERRED over search_files when you know the file pattern you want.",
        input_schema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description:
                'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.test.ts", "*.{js,jsx,ts,tsx}")',
            },
            path: {
              type: "string",
              description:
                "Directory to search in (relative to workspace unless absolute path is allowed). Defaults to workspace root if not specified.",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results to return (default: 100)",
            },
          },
          required: ["pattern"],
        },
      },
    ];
  }

  async glob(input: { pattern: string; path?: string; maxResults?: number }): Promise<GlobResult> {
    return (await this.globMany({ ...input, patterns: [input.pattern] }))[0];
  }

  /** All patterns share one worker traversal; results retain their individual limits. */
  async globMany(input: {
    patterns: string[];
    path?: string;
    maxResults?: number;
  }): Promise<GlobResult[]> {
    for (const pattern of input.patterns) {
      this.daemon.logEvent(this.taskId, "log", {
        message: `Glob search: ${pattern}${input.path ? ` in ${input.path}` : ""}`,
      });
    }
    let results: GlobResult[];
    try {
      results = await fileDiscoveryService.discoverGlob(this.workspace, input);
    } catch (error) {
      results = input.patterns.map((pattern) => ({
        success: false,
        pattern,
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    for (const result of results) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "glob",
        ...(result.success
          ? {
              result: {
                pattern: result.pattern,
                matchCount: result.matches.length,
                totalMatches: result.totalMatches,
                truncated: result.truncated,
                scanTruncated: result.scanTruncated === true,
              },
            }
          : { error: result.error }),
      });
    }
    return results;
  }
}
