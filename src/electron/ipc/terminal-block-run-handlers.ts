import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  IPC_CHANNELS,
  type TerminalBlockOutputEvent,
  type TerminalBlockRunResult,
} from "../../shared/types";
import type { AgentDaemon } from "../agent/daemon";
import { GuardrailManager } from "../guardrails/guardrail-manager";
import { TerminalBlockRunner } from "../terminal/TerminalBlockRunner";
import { getTerminalShellIntegration, TerminalPtyManager } from "../terminal/TerminalPtyManager";
import { assertTerminalShellAllowed } from "../terminal/terminal-shell-policy";
import { rateLimiter, RATE_LIMIT_CONFIGS } from "../utils/rate-limiter";
import {
  TerminalBlockRunRequestSchema,
  TerminalBlockStopRequestSchema,
  validateInput,
} from "../utils/validation";

/** How often streamed output is sent to the window, so a flood of output stays one event. */
const OUTPUT_FLUSH_MS = 60;
/** Command text kept in the session audit record. */
const AUDIT_COMMAND_LIMIT = 500;

let runner: TerminalBlockRunner | null = null;

function getRunner(): TerminalBlockRunner {
  runner ??= new TerminalBlockRunner(TerminalPtyManager.getInstance(), {
    shellIntegration: getTerminalShellIntegration(),
  });
  return runner;
}

export type TerminalBlockRunHandlerDeps = {
  agentDaemon: AgentDaemon;
  /**
   * Checks that the sender may run commands in the task's conversation and records the
   * run in the session audit log; throws when the sender is not allowed.
   */
  authorizeAndRecordRun: (
    event: IpcMainInvokeEvent,
    taskId: string,
    metadata: { runId: string; command: string },
  ) => Promise<void>;
};

/**
 * Register the handlers behind the Run button on shell code blocks in an answer.
 *
 * A run is the user's own action: they press Run on a command shown in full, and it is
 * typed into their terminal tab as if they had typed it (the same unsandboxed login shell
 * as the terminal dock, not the agent's command sandbox). So it gets the checks terminal
 * input gets (workspace shell policy) plus the conversation's membership check, the
 * dangerous-command guardrail and an audit record, and no agent approval prompt. The
 * agent cannot start a run: only this IPC call from the window can.
 */
export function setupTerminalBlockRunHandlers(deps: TerminalBlockRunHandlerDeps): void {
  const { agentDaemon } = deps;
  rateLimiter.configure(IPC_CHANNELS.TERMINAL_BLOCK_RUN, RATE_LIMIT_CONFIGS.standard);

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_BLOCK_RUN,
    async (event, data: unknown): Promise<TerminalBlockRunResult> => {
      if (!rateLimiter.check(IPC_CHANNELS.TERMINAL_BLOCK_RUN)) {
        throw new Error("Too many code block runs. Try again in a minute.");
      }
      const request = validateInput(TerminalBlockRunRequestSchema, data, "code block run");
      const workspace = agentDaemon.getWorkspaceById(request.workspaceId);
      if (!workspace) throw new Error("Workspace not found.");
      const task = await agentDaemon.getTaskById(request.taskId);
      if (!task || task.workspaceId !== workspace.id) {
        throw new Error("The conversation does not belong to this workspace.");
      }
      assertTerminalShellAllowed(workspace, task);
      const blockCheck = GuardrailManager.isCommandBlocked(request.command);
      if (blockCheck.blocked) {
        throw new Error(`Command blocked by guardrails (matched pattern: ${blockCheck.pattern}).`);
      }
      await deps.authorizeAndRecordRun(event, task.id, {
        runId: request.runId,
        command: request.command.slice(0, AUDIT_COMMAND_LIMIT),
      });

      const sender = event.sender;
      let pending = "";
      let pendingTabId = "";
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        flushTimer = null;
        if (!pending || sender.isDestroyed()) return;
        const outputEvent: TerminalBlockOutputEvent = {
          runId: request.runId,
          tabId: pendingTabId,
          output: pending,
        };
        pending = "";
        sender.send(IPC_CHANNELS.TERMINAL_BLOCK_OUTPUT, outputEvent);
      };

      try {
        return await getRunner().run({
          runId: request.runId,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          taskId: task.id,
          command: request.command,
          ownerId: String(sender.id),
          onOutput: (output, tabId) => {
            pending += output;
            pendingTabId = tabId;
            flushTimer ??= setTimeout(flush, OUTPUT_FLUSH_MS);
          },
        });
      } finally {
        if (flushTimer) clearTimeout(flushTimer);
        flush();
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.TERMINAL_BLOCK_STOP, async (event, data: unknown) => {
    const request = validateInput(TerminalBlockStopRequestSchema, data, "code block stop");
    return { stopped: getRunner().stop(request.runId, String(event.sender.id)) };
  });
}
