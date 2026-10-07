import type Database from "better-sqlite3";
import { serviceStatements } from "../database/service-statements";
import {
  botNotificationRetrySchema,
  botNotificationScopeSchema,
  botNotificationUpdateSchema,
} from "../../shared/bot-notification";
export class BotNotificationService {
  private sql;
  constructor(db: Database.Database) {
    this.sql = serviceStatements(db);
  }
  retry(request: unknown) {
    return this.sql.unit("botNotification_retry", [
      botNotificationRetrySchema.parse(request),
      Date.now(),
    ]);
  }
  get(scope: unknown) {
    return this.sql.unit("botNotification_get", [botNotificationScopeSchema.parse(scope)]);
  }
  update(request: unknown) {
    return this.sql.unit("botNotification_update", [
      botNotificationUpdateSchema.parse(request),
      Date.now(),
    ]);
  }
  list(scope: unknown) {
    return this.sql.unit("botNotification_list", [botNotificationScopeSchema.parse(scope)]);
  }
}
