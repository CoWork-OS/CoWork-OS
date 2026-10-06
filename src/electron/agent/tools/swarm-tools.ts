/**
 * swarm_note (docs/memory-repo-phase5-design.md §2): a peer note for the other agents working
 * on the same goal, in `swarms/<slug>/` of the memory folder.
 *
 * - Only for swarm members: the executor opens the tool call in a memory-repo access scope
 *   whose swarm prefix is set only when the task's `swarm` layer is on; the swarm is
 *   resolved again here from the task chain and must match. The slug never comes from the
 *   model.
 * - Denied to verifiers (worker role and tool restrictions). Not a memory write tool: it does
 *   not touch facts about the user, so researchers and read-only helpers may use it.
 * - Entries carry `by: agent`, the author's role, `source: cowork://tasks/<id>` and
 *   `tainted: yes` when the task read untrusted content; the text is screened like every
 *   memory write (MemoryRepoService.swarmAppend).
 */
import type { Workspace } from "../../../shared/types";
import { MemoryRepoService } from "../../memory/repo/MemoryRepoService";
import {
  SWARM_NOTE_KINDS,
  resolveSwarm,
  swarmFolderPath,
  swarmResolveDeps,
  type SwarmNoteKind,
} from "../../memory/repo/memory-repo-swarm";
import { getMemoryRepoSwarmReadPrefix } from "../../security/memory-repo-access";
import type { AgentDaemon } from "../daemon";
import type { LLMTool } from "../llm/types";
import { isUntrustedExternalSource } from "../security/export-permission-context";

export const SWARM_NOTE_TOOL = "swarm_note";

const MAX_TEXT_CHARS = 2_000;
const MAX_SOURCES = 5;
const MAX_SOURCE_CHARS = 300;

type SwarmNoteResult = Record<string, unknown> & { success: boolean };

export class SwarmTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: SWARM_NOTE_TOOL,
        description:
          "Share a note with the other agents working on the same goal (the lead task and its sub-agents or team members). " +
          "Use it when you measured or found something others need (finding), ruled an option out (ruled_out, say why), " +
          "need an answer from another agent (question) or answer one (answer). Add sources (files, URLs, commands) when you have them. " +
          "Read the <cowork_swarm> block before each step instead of repeating work. Not for facts about the user (use memory_remember).",
        input_schema: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: [...SWARM_NOTE_KINDS],
              description: "finding | ruled_out | question | answer",
            },
            text: {
              type: "string",
              description: "One self-contained line: what you measured, ruled out, ask or answer.",
            },
            sources: {
              type: "array",
              items: { type: "string" },
              description: "Optional evidence: file paths, URLs or commands (at most 5).",
            },
          },
          required: ["kind", "text"],
        },
      },
    ];
  }

  async note(input: unknown): Promise<SwarmNoteResult> {
    const fail = (error: string, reason?: string): SwarmNoteResult => {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: SWARM_NOTE_TOOL,
        success: false,
        error,
        ...(reason ? { reason } : {}),
      });
      return { success: false, error, ...(reason ? { reason } : {}) };
    };
    const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
    if (!(SWARM_NOTE_KINDS as readonly string[]).includes(kind)) {
      return fail(`kind must be one of: ${SWARM_NOTE_KINDS.join(", ")}.`, "invalid_input");
    }
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text) return fail("text is required.", "invalid_input");
    if (text.length > MAX_TEXT_CHARS) {
      return fail(`text is too long (at most ${MAX_TEXT_CHARS} characters).`, "invalid_input");
    }
    if (raw.sources !== undefined && !Array.isArray(raw.sources)) {
      return fail("sources must be an array of strings.", "invalid_input");
    }
    const sources = (Array.isArray(raw.sources) ? raw.sources : [])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().slice(0, MAX_SOURCE_CHARS))
      .filter(Boolean)
      .slice(0, MAX_SOURCES);

    // Set by the executor only when this task's swarm layer is on.
    const prefix = getMemoryRepoSwarmReadPrefix();
    if (!prefix) {
      return fail(
        "swarm_note is only for agents that share a goal (a task with sub-agents or a team run) while the memory folder is on.",
        "not_in_swarm",
      );
    }
    const task = await this.daemon.getTaskById(this.taskId);
    if (!task) return fail("The task was not found.", "not_in_swarm");
    if (task.workerRole === "verifier") {
      return fail("Verifiers read swarm notes but do not write them.", "verifier");
    }
    const swarm = await resolveSwarm(task, swarmResolveDeps(this.daemon));
    if (!swarm || swarmFolderPath(swarm.slug) !== prefix) {
      return fail("This task is not part of that swarm.", "not_in_swarm");
    }
    const repo = MemoryRepoService.get();
    if (!repo?.isWritable()) return fail("The memory folder is not available.", "unavailable");

    const tainted = (this.daemon.listRecentSensitiveSources?.(this.taskId) ?? []).some((item) =>
      isUntrustedExternalSource(item),
    );
    const author =
      task.assignedAgentRoleId || task.workerRole || (task.id === swarm.rootTaskId ? "lead" : "agent");
    const result = await repo.swarmAppend({
      slug: swarm.slug,
      kind: kind as SwarmNoteKind,
      text,
      author,
      taskId: this.taskId,
      sources,
      tainted,
      goal: swarm.goal,
      rootTaskId: swarm.rootTaskId,
      members: swarm.members,
    });
    if (result.status === "skipped") {
      const error =
        result.reason === "busy"
          ? "The memory folder is busy; try again in a moment."
          : result.reason === "too_large"
            ? "The swarm notes file is full."
            : result.reason === "low_salience" || result.reason === "empty"
              ? "Not saved: the note is too short to be useful."
              : result.reason === "secret_only"
                ? "Not saved: the note is only a secret."
                : `Not saved (${result.reason}).`;
      return fail(error, result.reason);
    }
    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: SWARM_NOTE_TOOL,
      success: true,
      memoryId: result.ref,
      action: result.action,
      kind,
      workspaceId: this.workspace.id,
    });
    return {
      success: true,
      id: result.ref,
      action: result.action,
      kind,
      file: result.path,
      ...(result.redactions > 0 ? { redactions: result.redactions } : {}),
      ...(tainted ? { tainted: true } : {}),
    };
  }
}
