/**
 * Agent import IPC (agentImport:*, docs/migrating-from-hermes.md): find Hermes and OpenClaw
 * homes, preview what an import brings over, and apply it.
 *
 * The renderer names only the source, the credentials opt-in, a workspace id and the items
 * to leave out; the home folder is always resolved here in main, so the renderer can never
 * point the importer at another path. Previews never carry credential values.
 */
import { ipcMain } from "electron";
import { z } from "zod";
import {
  AGENT_IMPORT_SOURCES,
  IPC_CHANNELS,
  type AgentImportDetection,
  type AgentImportPreview,
  type AgentImportResult,
} from "../../shared/types";
import type Database from "better-sqlite3";
import {
  createDefaultImportTargets,
  detectAgentImports,
  previewAgentImport,
  runAgentImport,
  type ImportWorkspace,
} from "../agent-import";
import type { CronService } from "../cron";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { validateInput } from "../utils/validation";

const AgentImportPreviewSchema = z
  .object({
    source: z.enum(AGENT_IMPORT_SOURCES),
    withSecrets: z.boolean().optional(),
  })
  .strict();

const AgentImportApplySchema = z
  .object({
    source: z.enum(AGENT_IMPORT_SOURCES),
    withSecrets: z.boolean().optional(),
    workspaceId: z.string().trim().min(1).max(200).optional(),
    excludeItemIds: z.array(z.string().max(500)).max(2000).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export interface AgentImportHandlerDeps {
  db: Database.Database;
  findWorkspace: (workspaceId: string) => Promise<ImportWorkspace | null>;
  getCronService: () => CronService | null;
  /** Reload skills after an import installed some. */
  onSkillsInstalled: () => Promise<void>;
}

function limit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    throw new Error("Too many requests. Please wait a moment.");
  }
}

export function setupAgentImportHandlers(deps: AgentImportHandlerDeps): void {
  rateLimiter.configure(IPC_CHANNELS.AGENT_IMPORT_DETECT, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.AGENT_IMPORT_PREVIEW, RATE_LIMIT_CONFIGS.standard);
  // Writes settings, memory and skills; the Import button is the only caller.
  rateLimiter.configure(IPC_CHANNELS.AGENT_IMPORT_APPLY, RATE_LIMIT_CONFIGS.limited);

  ipcMain.handle(IPC_CHANNELS.AGENT_IMPORT_DETECT, async (): Promise<AgentImportDetection[]> => {
    limit(IPC_CHANNELS.AGENT_IMPORT_DETECT);
    return detectAgentImports();
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_IMPORT_PREVIEW,
    async (_event, raw: unknown): Promise<AgentImportPreview> => {
      limit(IPC_CHANNELS.AGENT_IMPORT_PREVIEW);
      const request = validateInput(AgentImportPreviewSchema, raw, "agent import preview");
      return previewAgentImport(request.source, { withSecrets: request.withSecrets === true });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_IMPORT_APPLY,
    async (_event, raw: unknown): Promise<AgentImportResult> => {
      limit(IPC_CHANNELS.AGENT_IMPORT_APPLY);
      const request = validateInput(AgentImportApplySchema, raw, "agent import");
      const workspace = request.workspaceId ? await deps.findWorkspace(request.workspaceId) : null;
      if (request.workspaceId && !workspace) throw new Error("Workspace not found.");
      const cronService = deps.getCronService();
      const targets = createDefaultImportTargets({
        db: deps.db,
        workspace,
        cron: cronService ? { kind: "service", service: cronService } : null,
      });
      const result = await runAgentImport(request.source, targets, {
        withSecrets: request.withSecrets === true,
        dryRun: request.dryRun === true,
        excludeItemIds: request.excludeItemIds,
      });
      if (result.items.some((item) => item.category === "skill" && item.status === "imported")) {
        await deps.onSkillsInstalled();
      }
      return result;
    },
  );
}
