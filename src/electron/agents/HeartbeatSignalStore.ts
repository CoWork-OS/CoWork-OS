import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import {
  HeartbeatDeferredState,
  HeartbeatSignal,
  HeartbeatSignalFamily,
  HeartbeatSignalSource,
  HeartbeatSignalUrgency,
  HeartbeatWorkspaceScope,
} from "../../shared/types";
import { getUserDataDir } from "../utils/user-data-dir";

export interface SubmitHeartbeatSignalInput {
  agentRoleId: string;
  workspaceId?: string;
  agentScope?: "agent" | "workspace";
  workspaceScope?: HeartbeatWorkspaceScope;
  signalFamily: HeartbeatSignalFamily;
  source: HeartbeatSignalSource;
  fingerprint?: string;
  urgency?: HeartbeatSignalUrgency;
  confidence?: number;
  expiresAt?: number;
  evidenceRefs?: string[];
  reason?: string;
  payload?: Record<string, unknown>;
}

interface PersistedSignalStoreState {
  version: 1;
  signals: HeartbeatSignal[];
  deferred: Record<string, HeartbeatDeferredState>;
}

const STATE_FILE = "heartbeat-signals-v3.json";
const DEFAULT_STATE: PersistedSignalStoreState = {
  version: 1,
  signals: [],
  deferred: {},
};

const URGENCY_ORDER: Record<HeartbeatSignalUrgency, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const SIGNAL_RETENTION_MS: Record<HeartbeatSignalFamily, number> = {
  urgent_interrupt: 30 * 60 * 1000,
  focus_state: 60 * 60 * 1000,
  open_loop_pressure: 6 * 60 * 60 * 1000,
  correction_learning: 24 * 60 * 60 * 1000,
  memory_drift: 24 * 60 * 60 * 1000,
  cross_workspace_patterns: 12 * 60 * 60 * 1000,
  suggestion_aging: 6 * 60 * 60 * 1000,
  awareness_signal: 2 * 60 * 60 * 1000,
  maintenance: 12 * 60 * 60 * 1000,
  mentions: 2 * 60 * 60 * 1000,
  assigned_tasks: 2 * 60 * 60 * 1000,
};

// TODO: The load/save/prune methods use synchronous fs APIs which block the Electron
// main thread. This is acceptable at current heartbeat cadences but should be migrated
// to fs/promises when the pulse interval is tightened below ~5 minutes.
function stableHash(input: string): string {
  // SHA-256 truncated to 40 hex chars — same length as SHA-1 but future-safe.
  return createHash("sha256").update(input).digest("hex").slice(0, 40);
}

function makeDeferredKey(agentRoleId: string, workspaceId?: string): string {
  return `${agentRoleId}:${workspaceId || "*"}`;
}

export class HeartbeatSignalStore {
  private loaded = false;
  private state: PersistedSignalStoreState = { version: 1, signals: [], deferred: {} };

  private get filePath(): string {
    return path.join(getUserDataDir(), STATE_FILE);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedSignalStoreState>;
      this.state = {
        version: 1,
        signals: Array.isArray(parsed.signals) ? parsed.signals : [],
        deferred: parsed.deferred && typeof parsed.deferred === "object" ? parsed.deferred : {},
      };
    } catch {
      this.state = { ...DEFAULT_STATE };
    }
  }

  private save(): void {
    this.load();
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Best effort only.
    }
  }

  private prune(now = Date.now()): void {
    this.load();
    const nextSignals = this.state.signals.filter((signal) => signal.expiresAt > now);
    if (nextSignals.length !== this.state.signals.length) {
      this.state.signals = nextSignals;
      this.save();
    }
  }

  submit(input: SubmitHeartbeatSignalInput): { signal: HeartbeatSignal; merged: boolean } {
    this.prune();
    const now = Date.now();
    const fingerprint =
      input.fingerprint ||
      stableHash(
        [
          input.agentRoleId,
          input.workspaceId || "*",
          input.signalFamily,
          input.source,
          input.reason || "",
          JSON.stringify(input.payload || {}),
        ].join("|"),
      );
    const retentionMs = SIGNAL_RETENTION_MS[input.signalFamily] || 60 * 60 * 1000;
    const expiresAt = input.expiresAt || now + retentionMs;
    const existing = this.state.signals.find(
      (signal) =>
        signal.agentRoleId === input.agentRoleId &&
        signal.workspaceId === input.workspaceId &&
        signal.fingerprint === fingerprint,
    );

    if (existing) {
      existing.lastSeenAt = now;
      existing.expiresAt = Math.max(existing.expiresAt, expiresAt);
      existing.confidence = Math.max(existing.confidence, input.confidence ?? existing.confidence);
      const nextUrgency = input.urgency || existing.urgency;
      if (URGENCY_ORDER[nextUrgency] > URGENCY_ORDER[existing.urgency]) {
        existing.urgency = nextUrgency;
      }
      existing.evidenceRefs = Array.from(
        new Set([...(existing.evidenceRefs || []), ...(input.evidenceRefs || [])]),
      );
      existing.reason = input.reason || existing.reason;
      existing.payload = { ...existing.payload, ...input.payload };
      existing.mergedCount += 1;
      this.save();
      return { signal: { ...existing }, merged: true };
    }

    const signal: HeartbeatSignal = {
      id: stableHash(`${fingerprint}:${now}`),
      agentRoleId: input.agentRoleId,
      workspaceId: input.workspaceId,
      agentScope: input.agentScope || "agent",
      workspaceScope: input.workspaceScope || (input.workspaceId ? "single" : "all"),
      signalFamily: input.signalFamily,
      source: input.source,
      fingerprint,
      urgency: input.urgency || "low",
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.5)),
      expiresAt,
      evidenceRefs: input.evidenceRefs || [],
      mergedCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      reason: input.reason,
      payload: input.payload,
    };
    this.state.signals.push(signal);
    this.save();
    return { signal, merged: false };
  }

  listAgentSignals(agentRoleId: string, now = Date.now()): HeartbeatSignal[] {
    this.prune(now);
    return this.state.signals
      .filter((signal) => signal.agentRoleId === agentRoleId)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((signal) => ({ ...signal }));
  }

  removeSignals(
    agentRoleId: string,
    signalSnapshots: Array<Pick<HeartbeatSignal, "id" | "lastSeenAt" | "mergedCount">>,
  ): void {
    if (signalSnapshots.length === 0) return;
    this.load();
    const snapshots = new Map(signalSnapshots.map((signal) => [signal.id, signal]));
    this.state.signals = this.state.signals.filter(
      (signal) => {
        if (signal.agentRoleId !== agentRoleId) return true;
        const snapshot = snapshots.get(signal.id);
        if (!snapshot) return true;
        return (
          signal.lastSeenAt > snapshot.lastSeenAt ||
          signal.mergedCount > snapshot.mergedCount
        );
      },
    );
    this.save();
  }

  clearAgent(agentRoleId: string): void {
    this.load();
    this.state.signals = this.state.signals.filter((signal) => signal.agentRoleId !== agentRoleId);
    Object.keys(this.state.deferred)
      .filter((key) => key.startsWith(`${agentRoleId}:`))
      .forEach((key) => {
        delete this.state.deferred[key];
      });
    this.save();
  }

  getDeferredState(agentRoleId: string, workspaceId?: string): HeartbeatDeferredState | undefined {
    this.load();
    return this.state.deferred[makeDeferredKey(agentRoleId, workspaceId)];
  }

  setDeferredState(agentRoleId: string, state: HeartbeatDeferredState, workspaceId?: string): void {
    this.load();
    this.state.deferred[makeDeferredKey(agentRoleId, workspaceId)] = state;
    this.save();
  }

  clearDeferredState(agentRoleId: string, workspaceId?: string): void {
    this.load();
    delete this.state.deferred[makeDeferredKey(agentRoleId, workspaceId)];
    this.save();
  }
}
