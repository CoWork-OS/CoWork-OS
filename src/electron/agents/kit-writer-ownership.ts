import type { AgentDaemon } from "../agent/daemon";
import type { MemoryStatementPort } from "../memory/memory-statement-port";
import type { KitWriterLeaseResult, KitWriterRuntime } from "../memory/kit-writer-lease-sql";
import { maintenanceClaimOwner } from "../memory/maintenance-claim-sql";
import { createLogger } from "../utils/logger";

/**
 * Runs the workspace kit writers (CrossSignal, Feedback, Lore) only while this process owns
 * the profile's kit-writer lease (`kit-writer-lease-sql.ts`), so a desktop app and a node
 * daemon on one profile never both rewrite `.cowork/*.md`.
 *
 * - On `start`, and then every `renewMs`, the process asks for the lease.
 * - Gaining it creates and starts the writers. Their startup rebuild reads the shared
 *   database, so files catch up with tasks the previous owner (or a non-owner) ran.
 * - Losing it (a desktop asked for a hand-off, or the lease expired while this process was
 *   stalled and someone else took it) stops the writers, which flushes what they hold.
 * - `stop` stops the writers and releases the lease, so the other process can take over on
 *   its next heartbeat instead of waiting for the lease to expire. A release after a
 *   hand-off request passes the lease straight to the requesting desktop.
 */

const logger = createLogger("KitWriterOwnership");

/** A process that crashed stops owning the kit writers after this long. */
export const KIT_WRITER_LEASE_MS = 60_000;
/** Heartbeat: renew (owner) or retry (non-owner). Well inside the lease. */
export const KIT_WRITER_RENEW_MS = 15_000;

export interface KitWriter {
  start(agentDaemon: AgentDaemon): Promise<void>;
  stop(): Promise<void>;
}

export interface KitWriterFactory {
  name: string;
  create: () => KitWriter;
}

export interface KitWriterOwnershipOptions {
  port: Pick<MemoryStatementPort, "unit">;
  agentDaemon: AgentDaemon;
  runtime: KitWriterRuntime;
  writers: KitWriterFactory[];
  owner?: string;
  leaseMs?: number;
  renewMs?: number;
  now?: () => number;
}

export class KitWriterOwnership {
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly now: () => number;
  private running: KitWriter[] = [];
  private owned = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Serializes heartbeats, start and stop. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: KitWriterOwnershipOptions) {
    this.owner = options.owner ?? maintenanceClaimOwner();
    this.leaseMs = options.leaseMs ?? KIT_WRITER_LEASE_MS;
    this.renewMs = options.renewMs ?? KIT_WRITER_RENEW_MS;
    this.now = options.now ?? Date.now;
  }

  isOwner(): boolean {
    return this.owned;
  }

  /** Ask for the lease now and keep asking on the heartbeat. Resolves with ownership. */
  async start(): Promise<boolean> {
    this.stopped = false;
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.heartbeat();
      }, this.renewMs);
      this.timer.unref?.();
    }
    await this.heartbeat();
    return this.owned;
  }

  /** One acquire/renew round; exposed for tests. */
  heartbeat(): Promise<void> {
    return this.enqueue(() => this.runHeartbeat());
  }

  /** Stop the writers (flushing them) and release the lease. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.enqueue(async () => {
      const wasOwner = this.owned;
      await this.stopWriters();
      if (wasOwner) await this.release();
    });
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(step).catch((error) => {
      logger.warn("Kit-writer ownership step failed:", error);
    });
    return this.chain;
  }

  private async runHeartbeat(): Promise<void> {
    if (this.stopped) return;
    let result: KitWriterLeaseResult;
    try {
      result = await this.options.port.unit("kitWriterLease_acquire", {
        owner: this.owner,
        runtime: this.options.runtime,
        now: Math.floor(this.now()),
        leaseMs: this.leaseMs,
      });
    } catch (error) {
      // Keep the current state; an owner whose renewals keep failing loses the lease when
      // it expires, and the next successful heartbeat reports that.
      logger.warn("Kit-writer lease heartbeat failed:", error);
      return;
    }
    if (this.stopped) return;
    if (result.owned) {
      if (!this.owned) await this.startWriters();
      return;
    }
    if (this.owned) {
      logger.info(
        result.reason === "yield"
          ? `Handing the kit writers to ${result.holder}`
          : `Kit-writer lease taken over by ${result.holder}`,
      );
      await this.stopWriters();
      if (result.reason === "yield") await this.release();
    } else if (result.reason === "handoff_requested") {
      logger.info(`Asked ${result.holder} to hand over the kit writers`);
    }
  }

  private async startWriters(): Promise<void> {
    this.owned = true;
    logger.info(`Kit writers owned by this process (${this.options.runtime})`);
    for (const factory of this.options.writers) {
      try {
        const writer = factory.create();
        await writer.start(this.options.agentDaemon);
        this.running.push(writer);
        logger.info(`${factory.name} started`);
      } catch (error) {
        logger.error(`Failed to start ${factory.name}:`, error);
      }
    }
  }

  private async stopWriters(): Promise<void> {
    const writers = this.running.splice(0);
    this.owned = false;
    for (const writer of writers.reverse()) {
      try {
        await writer.stop();
      } catch (error) {
        logger.warn("Failed to stop a kit writer:", error);
      }
    }
  }

  private async release(): Promise<void> {
    try {
      await this.options.port.unit("kitWriterLease_release", {
        owner: this.owner,
        now: Math.floor(this.now()),
        leaseMs: this.leaseMs,
      });
    } catch (error) {
      // The lease expires on its own.
      logger.warn("Could not release the kit-writer lease:", error);
    }
  }
}
