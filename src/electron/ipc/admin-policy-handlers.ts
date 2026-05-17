import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import {
  loadPolicies,
  loadPoliciesStrict,
  savePolicies,
  watchPolicies,
  validatePolicies,
  isPackAllowed,
  isPackRequired,
} from "../admin/policies";
import type { AdminPolicies } from "../admin/policies";

let policyWatcherCleanup: (() => void) | null = null;
let policyReconcileQueue: Promise<void> = Promise.resolve();

function reconcilePluginPackPolicies(): Promise<void> {
  policyReconcileQueue = policyReconcileQueue.then(
    async () => {
      const { getPluginRegistry } = await import("../extensions/registry");
      await getPluginRegistry().reconcilePackRuntimeState();
    },
    async () => {
      const { getPluginRegistry } = await import("../extensions/registry");
      await getPluginRegistry().reconcilePackRuntimeState();
    },
  );
  return policyReconcileQueue;
}

/**
 * Set up Admin Policy IPC handlers
 */
export function setupAdminPolicyHandlers(): void {
  if (!policyWatcherCleanup) {
    policyWatcherCleanup = watchPolicies(() => {
      void reconcilePluginPackPolicies().catch((error) => {
        console.warn("[AdminPolicies] Failed to reconcile plugin pack policy file change:", error);
      });
    });
  }

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
      everydayAgent: {
        ...current.everydayAgent,
        ...updates.everydayAgent,
        activeHours: {
          ...current.everydayAgent.activeHours,
          ...updates.everydayAgent?.activeHours,
        },
      },
      runtime: {
        ...current.runtime,
        ...updates.runtime,
        network: {
          ...current.runtime.network,
          ...updates.runtime?.network,
        },
        autoReview: {
          ...current.runtime.autoReview,
          ...updates.runtime?.autoReview,
        },
        telemetry: {
          ...current.runtime.telemetry,
          ...updates.runtime?.telemetry,
        },
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
    try {
      await reconcilePluginPackPolicies();
    } catch (error) {
      console.warn("[AdminPolicies] Failed to reconcile plugin pack runtime state:", error);
      try {
        savePolicies(current);
        await reconcilePluginPackPolicies();
      } catch (rollbackError) {
        console.warn("[AdminPolicies] Failed to roll back plugin pack policy update:", rollbackError);
      }
      throw error;
    }
    return merged;
  });

  // Check if a specific pack is allowed/required
  ipcMain.handle(IPC_CHANNELS.ADMIN_POLICIES_CHECK_PACK, async (_, packId: string) => {
    if (!packId || typeof packId !== "string") {
      throw new Error("Pack ID is required");
    }
    const policies = loadPoliciesStrict();
    if (!policies) {
      return {
        packId,
        allowed: false,
        required: false,
      };
    }
    return {
      packId,
      allowed: isPackAllowed(packId, policies),
      required: isPackRequired(packId, policies),
    };
  });
}
