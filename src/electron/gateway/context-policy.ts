/**
 * Context Policy Manager
 *
 * Manages per-context (DM vs group) security policies for channels.
 * Allows different security modes for direct messages vs group chats.
 *
 * Default policies:
 * - DM: pairing mode, no tool restrictions
 * - Group: pairing mode, deny memory tools (clipboard)
 */

import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import { ContextType, SecurityMode, ContextPolicy } from "../../shared/types";

/**
 * Database row representation of a context policy
 */
interface ContextPolicyRow {
  id: string;
  channel_id: string;
  context_type: string;
  security_mode: string;
  tool_restrictions: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Options for creating a new context policy
 */
export interface CreateContextPolicyOptions {
  channelId: string;
  contextType: ContextType;
  securityMode?: SecurityMode;
  toolRestrictions?: string[];
}

/**
 * Options for updating a context policy
 */
export interface UpdateContextPolicyOptions {
  securityMode?: SecurityMode;
  toolRestrictions?: string[];
}

/**
 * Result of a context policy access check
 */
export interface ContextAccessResult {
  allowed: boolean;
  policy: ContextPolicy;
  deniedTools?: string[];
}

/**
 * Default tool restrictions for group contexts
 * Prevents clipboard access in shared contexts for security
 */
export const DEFAULT_GROUP_TOOL_RESTRICTIONS = ["group:memory"];

/**
 * Per-channel, per-context (DM or group) security policies (async SQLite migration plan,
 * DB6). As services-domain units these run in the database worker when the domain is
 * routed there; callers use the async ContextPolicyManager facade in context-policy-
 * repository-facades.ts. Reading a context's policy creates its default policy on first
 * use, so policy checks are write units: a check and the default it creates share one
 * transaction.
 */
export class ContextPolicyStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Get the effective policy for a channel context
   * Returns the policy if it exists, or creates a default one
   */
  getPolicy(channelId: string, contextType: ContextType): ContextPolicy {
    const existing = this.findPolicy(channelId, contextType);
    if (existing) {
      return existing;
    }

    // Create default policy for this context
    return this.createDefaultPolicy(channelId, contextType);
  }

  /**
   * Get the effective policy based on chat characteristics
   * Determines if a chat is a group or DM based on the isGroup flag
   */
  getPolicyForChat(channelId: string, _chatId: string, isGroup: boolean): ContextPolicy {
    const contextType: ContextType = isGroup ? "group" : "dm";
    return this.getPolicy(channelId, contextType);
  }

  /**
   * Find an existing policy
   */
  findPolicy(channelId: string, contextType: ContextType): ContextPolicy | null {
    const row = this.db
      .prepare(`SELECT * FROM context_policies WHERE channel_id = ? AND context_type = ?`)
      .get(channelId, contextType) as ContextPolicyRow | undefined;

    if (!row) {
      return null;
    }

    return this.rowToPolicy(row);
  }

  /**
   * Get all policies for a channel
   */
  getPoliciesForChannel(channelId: string): ContextPolicy[] {
    const rows = this.db
      .prepare(`SELECT * FROM context_policies WHERE channel_id = ?`)
      .all(channelId) as ContextPolicyRow[];

    return rows.map((row) => this.rowToPolicy(row));
  }

  /**
   * Create a new context policy
   * Uses INSERT OR IGNORE to handle race conditions gracefully
   */
  create(options: CreateContextPolicyOptions): ContextPolicy {
    const now = Date.now();
    const id = uuidv4();

    const securityMode = options.securityMode || "pairing";
    const toolRestrictions =
      options.toolRestrictions ||
      (options.contextType === "group" ? DEFAULT_GROUP_TOOL_RESTRICTIONS : []);

    // Use INSERT OR IGNORE to handle concurrent insertions
    // If another thread already inserted, we'll fetch that one
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO context_policies (id, channel_id, context_type, security_mode, tool_restrictions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        options.channelId,
        options.contextType,
        securityMode,
        JSON.stringify(toolRestrictions),
        now,
        now,
      );

    // If insert was ignored (duplicate), fetch the existing one
    if (result.changes === 0) {
      const existing = this.findPolicy(options.channelId, options.contextType);
      if (existing) {
        return existing;
      }
      // Shouldn't happen, but fallback to what we tried to insert
    }

    return {
      id,
      channelId: options.channelId,
      contextType: options.contextType,
      securityMode,
      toolRestrictions,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Update an existing context policy
   */
  update(id: string, options: UpdateContextPolicyOptions): ContextPolicy | null {
    const existing = this.findById(id);
    if (!existing) {
      return null;
    }

    const now = Date.now();
    const securityMode = options.securityMode ?? existing.securityMode;
    const toolRestrictions = options.toolRestrictions ?? existing.toolRestrictions;

    this.db
      .prepare(
        `UPDATE context_policies
         SET security_mode = ?, tool_restrictions = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(securityMode, JSON.stringify(toolRestrictions), now, id);

    return {
      ...existing,
      securityMode,
      toolRestrictions,
      updatedAt: now,
    };
  }

  /**
   * Update policy by channel and context type
   */
  updateByContext(
    channelId: string,
    contextType: ContextType,
    options: UpdateContextPolicyOptions,
  ): ContextPolicy {
    let policy = this.findPolicy(channelId, contextType);

    if (!policy) {
      // Create new policy with the updates
      return this.create({
        channelId,
        contextType,
        securityMode: options.securityMode,
        toolRestrictions: options.toolRestrictions,
      });
    }

    // Update existing policy
    const updated = this.update(policy.id, options);
    return updated || policy;
  }

  /**
   * Delete a context policy
   */
  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM context_policies WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /**
   * Delete all policies for a channel
   */
  deleteByChannel(channelId: string): number {
    const result = this.db
      .prepare(`DELETE FROM context_policies WHERE channel_id = ?`)
      .run(channelId);
    return result.changes;
  }

  /**
   * Check if a tool is allowed in a given context
   */
  isToolAllowed(
    channelId: string,
    contextType: ContextType,
    toolName: string,
    toolGroups: string[],
  ): boolean {
    const policy = this.getPolicy(channelId, contextType);
    const restrictions = policy.toolRestrictions || [];

    // SECURITY: Check for deny-all marker (set when JSON parsing fails)
    // This ensures corrupted data defaults to most restrictive behavior
    if (restrictions.includes("*")) {
      return false;
    }

    // Check if tool is directly restricted
    if (restrictions.includes(toolName)) {
      return false;
    }

    // Check if any of the tool's groups are restricted
    for (const group of toolGroups) {
      if (restrictions.includes(group)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get list of denied tools for a context
   */
  getDeniedTools(channelId: string, contextType: ContextType): string[] {
    const policy = this.getPolicy(channelId, contextType);
    return policy.toolRestrictions || [];
  }

  /**
   * Create default policies for a new channel
   */
  createDefaultPolicies(channelId: string): void {
    // Create DM policy (no restrictions)
    this.createDefaultPolicy(channelId, "dm");
    // Create Group policy (with memory restrictions)
    this.createDefaultPolicy(channelId, "group");
  }

  /**
   * Create a default policy for a context if it doesn't exist
   */
  private createDefaultPolicy(channelId: string, contextType: ContextType): ContextPolicy {
    // Check if already exists
    const existing = this.findPolicy(channelId, contextType);
    if (existing) {
      return existing;
    }

    // Default: pairing mode
    // Groups get memory tool restrictions by default
    const toolRestrictions = contextType === "group" ? DEFAULT_GROUP_TOOL_RESTRICTIONS : [];

    return this.create({
      channelId,
      contextType,
      securityMode: "pairing",
      toolRestrictions,
    });
  }

  /**
   * Find policy by ID
   */
  private findById(id: string): ContextPolicy | null {
    const row = this.db.prepare(`SELECT * FROM context_policies WHERE id = ?`).get(id) as
      | ContextPolicyRow
      | undefined;

    if (!row) {
      return null;
    }

    return this.rowToPolicy(row);
  }

  /**
   * Convert database row to ContextPolicy
   * SECURITY: On JSON parse errors, defaults to DENY-ALL (most restrictive)
   * to prevent bypassing security through database corruption
   */
  private rowToPolicy(row: ContextPolicyRow): ContextPolicy {
    let toolRestrictions: string[] = [];
    if (row.tool_restrictions) {
      try {
        const parsed = JSON.parse(row.tool_restrictions);
        // Validate it's actually an array of strings
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
          toolRestrictions = parsed;
        } else {
          throw new Error("Invalid tool_restrictions format - not an array of strings");
        }
      } catch (error) {
        // SECURITY: Default to DENY-ALL on parse error
        // This prevents bypassing restrictions through database corruption
        console.error(
          `[ContextPolicyManager] SECURITY: Corrupted tool_restrictions for policy ${row.id}, defaulting to DENY-ALL:`,
          error,
        );
        // Block all tool groups - most restrictive default
        toolRestrictions = ["*"]; // Special marker meaning "deny all"
      }
    }

    return {
      id: row.id,
      channelId: row.channel_id,
      contextType: row.context_type as ContextType,
      securityMode: row.security_mode as SecurityMode,
      toolRestrictions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
