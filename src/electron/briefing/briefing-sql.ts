import type Database from "better-sqlite3";
import type { Briefing, BriefingConfig } from "./types";

/**
 * Daily briefing persistence (async SQLite migration plan, DB6): generated briefings and
 * per-workspace config. As services-domain units these run in the database worker when the
 * domain is routed there; schema setup stays in `DailyBriefingService` on the host.
 */
export class BriefingStore {
  constructor(private readonly db: Database.Database) {}

  saveBriefing(briefing: Briefing): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO briefings (id, workspace_id, generated_at, sections, delivered)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        briefing.id,
        briefing.workspaceId,
        briefing.generatedAt,
        JSON.stringify(briefing.sections),
        briefing.delivered ? 1 : 0,
      );
  }

  latestBriefing(workspaceId: string): Briefing | undefined {
    const row = this.db
      .prepare("SELECT * FROM briefings WHERE workspace_id = ? ORDER BY generated_at DESC LIMIT 1")
      // oxlint-disable-next-line typescript/no-explicit-any -- row shape is mapped below
      .get(workspaceId) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      generatedAt: row.generated_at,
      sections: JSON.parse(row.sections || "[]"),
      delivered: !!row.delivered,
    };
  }

  saveConfig(workspaceId: string, config: BriefingConfig, now: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO briefing_config
       (workspace_id, schedule_time, enabled_sections, delivery_channel_type, delivery_channel_id, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspaceId,
        config.scheduleTime,
        JSON.stringify(config.enabledSections),
        config.deliveryChannelType || null,
        config.deliveryChannelId || null,
        config.enabled ? 1 : 0,
        now,
      );
  }

  configuredWorkspaceIds(): string[] {
    return (
      this.db.prepare("SELECT workspace_id FROM briefing_config").all() as Array<{
        workspace_id: string;
      }>
    ).map((row) => row.workspace_id);
  }

  config(workspaceId: string): BriefingConfig | null {
    const row = this.db
      .prepare("SELECT * FROM briefing_config WHERE workspace_id = ?")
      // oxlint-disable-next-line typescript/no-explicit-any -- row shape is mapped below
      .get(workspaceId) as any;
    if (!row) return null;
    return {
      scheduleTime: row.schedule_time || "08:00",
      enabledSections: JSON.parse(row.enabled_sections || "{}"),
      deliveryChannelType: row.delivery_channel_type || undefined,
      deliveryChannelId: row.delivery_channel_id || undefined,
      enabled: !!row.enabled,
    };
  }
}
