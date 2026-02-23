/**
 * Build Mode Orchestrator
 *
 * Manages the "idea → working prototype" workflow on top of the Canvas system.
 * Tracks build phases and named checkpoints so users can revert to any phase.
 */

import { CanvasManager } from "./canvas-manager";
import type { CanvasCheckpoint } from "../../shared/types";

export type BuildPhase = "concept" | "plan" | "scaffold" | "iterate" | "complete";

export interface BuildSession {
  sessionId: string;
  taskId: string;
  workspaceId: string;
  idea: string;
  tech: string;
  currentPhase: BuildPhase;
  phaseCheckpoints: Partial<Record<BuildPhase, string>>; // phase → checkpoint ID
  createdAt: number;
}

const PHASE_ORDER: BuildPhase[] = ["concept", "plan", "scaffold", "iterate", "complete"];

const PHASE_LABELS: Record<BuildPhase, string> = {
  concept: "Phase 1 — Concept",
  plan: "Phase 2 — Plan",
  scaffold: "Phase 3 — Scaffold",
  iterate: "Phase 4 — Iterate",
  complete: "Phase 4 — Complete",
};

export class BuildModeOrchestrator {
  private sessions = new Map<string, BuildSession>();

  constructor(private canvasManager: CanvasManager) {}

  /**
   * Start a new build mode session tied to a task and canvas session.
   */
  start(
    sessionId: string,
    taskId: string,
    workspaceId: string,
    idea: string,
    tech = "vanilla HTML/CSS/JS",
  ): BuildSession {
    const session: BuildSession = {
      sessionId,
      taskId,
      workspaceId,
      idea,
      tech,
      currentPhase: "concept",
      phaseCheckpoints: {},
      createdAt: Date.now(),
    };
    this.sessions.set(taskId, session);
    return session;
  }

  /**
   * Save a named checkpoint for the current phase and advance to the next.
   */
  async completePhase(taskId: string): Promise<CanvasCheckpoint | null> {
    const session = this.sessions.get(taskId);
    if (!session) return null;

    const label = PHASE_LABELS[session.currentPhase];
    const checkpoint = await this.canvasManager.saveCheckpoint(session.sessionId, label);

    // Map the checkpoint to the phase
    session.phaseCheckpoints[session.currentPhase] = checkpoint.id;

    // Advance to the next phase
    const currentIndex = PHASE_ORDER.indexOf(session.currentPhase);
    if (currentIndex < PHASE_ORDER.length - 1) {
      session.currentPhase = PHASE_ORDER[currentIndex + 1];
    }

    return checkpoint;
  }

  /**
   * Revert to a specific build phase's checkpoint.
   */
  async revertToPhase(taskId: string, phase: BuildPhase): Promise<CanvasCheckpoint | null> {
    const session = this.sessions.get(taskId);
    if (!session) return null;

    const checkpointId = session.phaseCheckpoints[phase];
    if (!checkpointId) return null;

    const checkpoint = await this.canvasManager.restoreCheckpoint(session.sessionId, checkpointId);

    // Reset current phase to the reverted phase
    session.currentPhase = phase;

    // Clear checkpoints for phases after the reverted one
    const phaseIndex = PHASE_ORDER.indexOf(phase);
    for (let i = phaseIndex + 1; i < PHASE_ORDER.length; i++) {
      delete session.phaseCheckpoints[PHASE_ORDER[i]];
    }

    return checkpoint;
  }

  /**
   * Get the build session for a task.
   */
  getSession(taskId: string): BuildSession | undefined {
    return this.sessions.get(taskId);
  }

  /**
   * Get a list of completed phase checkpoints for display.
   */
  getPhaseTimeline(
    taskId: string,
  ): Array<{ phase: BuildPhase; label: string; checkpointId?: string; isCurrent: boolean }> {
    const session = this.sessions.get(taskId);
    if (!session) return [];

    return PHASE_ORDER.filter((p) => p !== "complete").map((phase) => ({
      phase,
      label: PHASE_LABELS[phase],
      checkpointId: session.phaseCheckpoints[phase],
      isCurrent: session.currentPhase === phase,
    }));
  }

  /**
   * Compare two phase checkpoints (returns file-level diff summary).
   */
  diffPhases(
    taskId: string,
    fromPhase: BuildPhase,
    toPhase: BuildPhase,
  ): { added: string[]; removed: string[]; modified: string[] } | null {
    const session = this.sessions.get(taskId);
    if (!session) return null;

    const fromId = session.phaseCheckpoints[fromPhase];
    const toId = session.phaseCheckpoints[toPhase];
    if (!fromId || !toId) return null;

    return this.canvasManager.diffCheckpoints(session.sessionId, fromId, toId);
  }

  /**
   * Remove a build session (cleanup on task completion).
   */
  remove(taskId: string): void {
    this.sessions.delete(taskId);
  }
}
