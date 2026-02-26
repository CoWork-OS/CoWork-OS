import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import {
  loadPolicies,
  savePolicies,
  validatePolicies,
  isPackAllowed,
  isPackRequired,
} from "../admin/policies";
import type { AdminPolicies } from "../admin/policies";

/**
 * Set up Admin Policy IPC handlers
 */
export function setupAdminPolicyHandlers(): void {
  // Get current admin policies
  ipcMain.handle(IPC_CHANNELS.ADMIN_POLICIES_GET, async () => {
    return loadPolicies();
  });

  // Update admin policies (partial merge)
  ipcMain.handle(IPC_CHANNELS.ADMIN_POLICIES_UPDATE, async (_, updates: Partial<AdminPolicies>) => {
    const current = loadPolicies();

    // Deep merge updates
    const merged: AdminPolicies = {
      ...current,
      ...updates,
      packs: {
        ...current.packs,
        ...updates.packs,
      },
      connectors: {
        ...current.connectors,
        ...updates.connectors,
      },
      agents: {
        ...current.agents,
        ...updates.agents,
      },
      general: {
        ...current.general,
        ...updates.general,
      },
    };

    const validationError = validatePolicies(merged);
    if (validationError) {
      throw new Error(`Invalid policies: ${validationError}`);
    }

    savePolicies(merged);
    return merged;
  });

  // Check if a specific pack is allowed/required
  ipcMain.handle(IPC_CHANNELS.ADMIN_POLICIES_CHECK_PACK, async (_, packId: string) => {
    if (!packId || typeof packId !== "string") {
      throw new Error("Pack ID is required");
    }
    const policies = loadPolicies();
    return {
      packId,
      allowed: isPackAllowed(packId, policies),
      required: isPackRequired(packId, policies),
    };
  });
}
