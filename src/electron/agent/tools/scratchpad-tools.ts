import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { LLMTool } from "../llm/types";
import type { Workspace } from "../../../shared/types";
import { evaluateWorkspaceFilesystemAccess } from "../../security/access-profile-paths";

/**
 * ScratchpadTools provides session-scoped note-taking for agents during long-running tasks.
 *
 * Unlike memory_save (which persists to the workspace database for long-term recall),
 * scratchpad is primarily ephemeral and lives for the duration of the task execution.
 * When a workspace path is provided, notes are checkpointed to disk so they can
 * survive crashes and be restored on task resume.
 *
 * Agents use it to track progress, record discovered issues, note approach decisions,
 * and maintain context during deep work sessions.
 */
export class ScratchpadTools {
  private scratchpad: Map<string, { content: string; timestamp: number }> = new Map();
  private checkpointPath?: string;
  private checkpointWorkspace?: Pick<Workspace, "path" | "permissions">;
  private dirty = false;

  constructor(
    private taskId: string,
    workspacePathOrWorkspace?: string | Pick<Workspace, "path" | "permissions">,
  ) {
    const workspacePath =
      typeof workspacePathOrWorkspace === "string"
        ? workspacePathOrWorkspace
        : workspacePathOrWorkspace?.path;
    if (typeof workspacePathOrWorkspace === "object" && workspacePathOrWorkspace) {
      this.checkpointWorkspace = workspacePathOrWorkspace;
    }
    if (workspacePath) {
      this.checkpointPath = this.getCheckpointPath(workspacePath);
      this.restoreFromDisk();
    }
  }

  /** Refresh the checkpoint boundary when a task changes workspace or profile. */
  setWorkspace(workspace: Pick<Workspace, "path" | "permissions">): void {
    const nextCheckpointPath = this.getCheckpointPath(workspace.path);
    const checkpointChanged = this.checkpointPath !== nextCheckpointPath;
    this.checkpointWorkspace = workspace;
    this.checkpointPath = nextCheckpointPath;

    // Never carry notes from one workspace into another. If the active
    // profile can no longer read the checkpoint, also discard the in-memory
    // copy so a revoked profile cannot continue to observe stale notes.
    if (checkpointChanged || !this.canAccessCheckpoint("read")) {
      this.scratchpad.clear();
      this.dirty = false;
    }
    if (checkpointChanged) this.restoreFromDisk();
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "scratchpad_write",
        description:
          "Write a note to your session scratchpad. Use this to record progress, " +
          "discovered issues, approach decisions, or interim findings during task execution. " +
          "Notes are checkpointed to disk so they survive interruptions. " +
          "Each note has a key for easy retrieval and update. " +
          "Writing to an existing key overwrites the previous content.",
        input_schema: {
          type: "object" as const,
          properties: {
            key: {
              type: "string",
              description:
                'A short key for this note (e.g., "progress", "issue-ssh", "approach", "blockers")',
            },
            content: {
              type: "string",
              description: "The note content. Be concise but include enough detail to be useful.",
            },
          },
          required: ["key", "content"],
        },
      },
      {
        name: "scratchpad_read",
        description:
          "Read notes from your session scratchpad. Returns all notes if no key specified, " +
          "or a specific note by key. Use this to review your progress and context.",
        input_schema: {
          type: "object" as const,
          properties: {
            key: {
              type: "string",
              description: "Optional key to read a specific note. Omit to read all notes.",
            },
          },
        },
      },
    ];
  }

  write(input: { key: string; content: string }): {
    success: boolean;
    key: string;
    noteCount: number;
  } {
    const key = String(input.key || "")
      .trim()
      .slice(0, 100);
    if (!key) {
      return { success: false, key: "", noteCount: this.scratchpad.size };
    }
    this.scratchpad.set(key, {
      content: String(input.content || "").slice(0, 10000),
      timestamp: Date.now(),
    });
    this.dirty = true;
    this.flushToDisk();
    return { success: true, key, noteCount: this.scratchpad.size };
  }

  read(input: { key?: string }): {
    notes: Array<{ key: string; content: string; timestamp: number }>;
    totalNotes: number;
  } {
    if (input.key) {
      const note = this.scratchpad.get(input.key);
      return {
        notes: note ? [{ key: input.key, ...note }] : [],
        totalNotes: this.scratchpad.size,
      };
    }
    return {
      notes: Array.from(this.scratchpad.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp)
        .map(([key, val]) => ({ key, ...val })),
      totalNotes: this.scratchpad.size,
    };
  }

  /** Get all scratchpad notes (for report generation and journal entries) */
  getAll(): Map<string, { content: string; timestamp: number }> {
    return new Map(this.scratchpad);
  }

  /** Persist current scratchpad state to disk (best-effort) */
  private flushToDisk(): void {
    if (!this.checkpointPath || !this.dirty) return;
    if (!this.canAccessCheckpoint("write")) return;
    try {
      const dir = path.dirname(this.checkpointPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, { content: string; timestamp: number }> = {};
      for (const [k, v] of this.scratchpad) {
        data[k] = v;
      }
      fs.writeFileSync(this.checkpointPath, JSON.stringify(data), "utf-8");
      this.dirty = false;
    } catch {
      // Best-effort — don't break the agent if disk write fails
    }
  }

  /** Restore scratchpad from a previous checkpoint on disk */
  private restoreFromDisk(): void {
    if (!this.checkpointPath) return;
    if (!this.canAccessCheckpoint("read")) return;
    try {
      if (!fs.existsSync(this.checkpointPath)) return;
      const raw = fs.readFileSync(this.checkpointPath, "utf-8");
      const data = JSON.parse(raw) as Record<string, { content: string; timestamp: number }>;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v.content === "string" && typeof v.timestamp === "number") {
          this.scratchpad.set(k, v);
        }
      }
    } catch {
      // Corrupted checkpoint — start fresh
    }
  }

  private canAccessCheckpoint(operation: "read" | "write"): boolean {
    // The string constructor is retained for older internal callers and tests
    // that predate workspace permission metadata. Registry-created instances
    // always pass the authoritative workspace view below.
    if (!this.checkpointWorkspace || !this.checkpointPath) return true;
    return (
      evaluateWorkspaceFilesystemAccess(this.checkpointWorkspace, this.checkpointPath, operation)
        .decision === "allow"
    );
  }

  private getCheckpointPath(workspacePath: string): string {
    const safeTaskPart = /^[A-Za-z0-9_-]{1,64}$/.test(this.taskId)
      ? this.taskId.slice(0, 12)
      : createHash("sha256").update(this.taskId).digest("hex").slice(0, 24);
    return path.join(workspacePath, ".cowork", `scratchpad-${safeTaskPart}.json`);
  }
}
