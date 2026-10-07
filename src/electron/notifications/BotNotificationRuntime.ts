import type Database from "better-sqlite3";
import { serviceStatements } from "../database/service-statements";
import type { AutomationRuntime } from "../automation/AutomationRuntime";
import type { NotificationService } from "./service";
const RECEIPT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Owned durable observer; never sends a model prompt or external channel message. */
export class BotNotificationRuntime {
  private sql;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweep: Promise<void> | null = null;
  private lastPrunedAt = 0;
  constructor(
    db: Database.Database,
    private runtime: AutomationRuntime,
    private delivery: () => NotificationService | null,
    private desktopAvailable: boolean,
  ) {
    this.sql = serviceStatements(db);
  }
  private tick(): Promise<void> {
    if (this.sweep) return this.sweep;
    const operation = this.run().finally(() => {
      if (this.sweep === operation) this.sweep = null;
    });
    this.sweep = operation;
    return operation;
  }
  private async run() {
    await this.runtime.assertOwnership();
    const fence = this.runtime.captureFence();
    const service = this.delivery();
    if (service) {
      const interrupted = await this.sql.unit("botNotification_recover", [fence]);
      for (const receipt of interrupted) {
        const stored = receipt.notificationId
          ? await service.containsDeliveryIdentity(receipt.notificationId)
          : false;
        await this.sql.unit("botNotification_settle", [
          [receipt.id],
          stored,
          receipt.destination === "desktop" ? "unavailable" : "not_requested",
          fence,
        ]);
      }
    }
    await this.sql.unit("botNotification_discover", [Date.now(), fence]);
    if (Date.now() - this.lastPrunedAt >= RECEIPT_PRUNE_INTERVAL_MS) {
      // Settled receipt history is bounded; a failed prune retries on the next interval.
      this.lastPrunedAt = Date.now();
      await this.sql.unit("botReceipts_prune", [Date.now(), fence]).catch(() => {});
    }
    if (!service) return;
    for (let count = 0; count < 8; count++) {
      await this.runtime.assertOwnership();
      const receipts = await this.sql.unit("botNotification_claim", [Date.now(), fence]);
      if (!receipts.length) break;
      const first = receipts[0];
      const desktop =
        first.destination === "desktop"
          ? this.desktopAvailable
            ? "requested"
            : "unavailable"
          : "not_requested";
      try {
        await this.runtime.assertOwnership();
        const ack = await service.addBotDelivery(
          {
            beforePublish: async () => {
              await this.runtime.assertOwnership();
              await this.sql.unit("botNotification_assertDelivery", [
                receipts.map((r) => r.id),
                fence,
              ]);
            },
            id: first.notificationId,
            type:
              first.kind === "decision"
                ? "input_required"
                : first.kind === "failure"
                  ? "task_failed"
                  : "info",
            title:
              receipts.length > 1
                ? `${receipts.length} bot work updates`
                : first.kind === "decision"
                  ? "Bot needs your decision"
                  : first.kind === "failure"
                    ? "Bot work failed"
                    : "Bot result is ready",
            message:
              receipts.length > 1
                ? "Open this bot’s Work view to inspect the results and failures."
                : "Open the work item to inspect its current state and evidence.",
            taskId: receipts.length === 1 ? first.taskId : undefined,
            workspaceId: first.scope.workspaceId,
            agentRoleId: first.scope.agentRoleId,
            desktopAlert: desktop === "requested",
          },
          { ids: receipts.map((r) => r.id), fence },
        );
        await this.sql.unit("botNotification_settle", [
          receipts.map((r) => r.id),
          ack.notification.id === first.notificationId,
          desktop === "requested" ? (ack.desktopRequested ? "requested" : "unavailable") : desktop,
          fence,
        ]);
      } catch {
        const stored = first.notificationId
          ? await service.containsDeliveryIdentity(first.notificationId).catch(() => false)
          : false;
        await this.sql
          .unit("botNotification_settle", [
            receipts.map((r) => r.id),
            stored,
            first.destination === "desktop" ? "unavailable" : "not_requested",
            fence,
          ])
          .catch(() => {});
      }
    }
  }
  async start() {
    await this.tick();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick().catch(() => {});
      }, 5000);
      this.timer.unref?.();
    }
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.sweep?.catch(() => {});
  }
}
