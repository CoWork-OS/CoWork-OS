import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import type { AutomationRuntime } from "./AutomationRuntime";
import { BotWorkControlService } from "./BotWorkControlService";
/** Owned recovery lifecycle shared by desktop and both headless runtimes. */
export class BotWorkControlRecovery {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweep: Promise<void> | null = null;
  private service: BotWorkControlService;
  constructor(
    db: Database.Database,
    daemon: AgentDaemon,
    runtime: AutomationRuntime,
    private notifications?: { start: () => Promise<void>; stop: () => Promise<void> },
  ) {
    this.service = new BotWorkControlService(db, {
      assertOwnership: () => runtime.assertOwnership(),
      captureFence: () => runtime.captureFence(),
      cancel: (taskId, workspaceId, authority) =>
        daemon.cancelTask(taskId, {
          cascade: false,
          waitForIdle: true,
          strictCleanup: true,
          scopeWorkspaceId: workspaceId,
          controlAuthority: authority,
        }),
      isStopped: (taskId) => daemon.isTaskStopConfirmed(taskId),
      isLocallyStopped: (taskId) => daemon.isLocalWorkStopConfirmed(taskId),
    });
  }
  private recover(): Promise<void> {
    if (this.sweep) return this.sweep;
    const sweep = this.service.recover().finally(() => {
      if (this.sweep === sweep) this.sweep = null;
    });
    this.sweep = sweep;
    return sweep;
  }
  async start(): Promise<void> {
    await this.recover();
    await this.notifications?.start();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.recover().catch(() => {});
      }, 30000);
      this.timer.unref?.();
    }
  }
  async stop(): Promise<void> {
    await this.notifications?.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.sweep?.catch(() => {});
    } finally {
      await this.service.waitForIdle();
    }
  }
}
