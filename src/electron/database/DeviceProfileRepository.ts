import type Database from "better-sqlite3";

export interface DeviceProfile {
  deviceId: string;
  customName: string | null;
  platform: string | null;
  modelIdentifier: string | null;
  lastSeenAt: number | null;
  settingsJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export class DeviceProfileStore {
  constructor(private db: Database.Database) {}

  upsert(deviceId: string, data: Partial<Omit<DeviceProfile, "deviceId" | "createdAt">>): void {
    const now = Date.now();
    const existing = this.get(deviceId);

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE device_profiles SET
          custom_name = COALESCE(?, custom_name),
          platform = COALESCE(?, platform),
          model_identifier = COALESCE(?, model_identifier),
          last_seen_at = COALESCE(?, last_seen_at),
          settings_json = COALESCE(?, settings_json),
          updated_at = ?
        WHERE device_id = ?
      `);
      stmt.run(
        data.customName ?? null,
        data.platform ?? null,
        data.modelIdentifier ?? null,
        data.lastSeenAt ?? null,
        data.settingsJson ?? null,
        now,
        deviceId,
      );
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO device_profiles (device_id, custom_name, platform, model_identifier, last_seen_at, settings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        deviceId,
        data.customName ?? null,
        data.platform ?? null,
        data.modelIdentifier ?? null,
        data.lastSeenAt ?? now,
        data.settingsJson ?? null,
        now,
        now,
      );
    }
  }

  get(deviceId: string): DeviceProfile | null {
    const row = this.db
      .prepare("SELECT * FROM device_profiles WHERE device_id = ?")
      .get(deviceId) as any;
    if (!row) return null;
    return this.mapRow(row);
  }

  list(): DeviceProfile[] {
    const rows = this.db
      .prepare("SELECT * FROM device_profiles ORDER BY last_seen_at DESC")
      .all() as any[];
    return rows.map(this.mapRow);
  }

  updateCustomName(deviceId: string, name: string): void {
    this.db
      .prepare("UPDATE device_profiles SET custom_name = ?, updated_at = ? WHERE device_id = ?")
      .run(name, Date.now(), deviceId);
  }

  updateLastSeen(deviceId: string, timestamp: number): void {
    this.db
      .prepare("UPDATE device_profiles SET last_seen_at = ?, updated_at = ? WHERE device_id = ?")
      .run(timestamp, Date.now(), deviceId);
  }

  private mapRow(row: any): DeviceProfile {
    return {
      deviceId: row.device_id,
      customName: row.custom_name,
      platform: row.platform,
      modelIdentifier: row.model_identifier,
      lastSeenAt: row.last_seen_at,
      settingsJson: row.settings_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
