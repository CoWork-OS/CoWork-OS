/**
 * `cowork import --from hermes|openclaw [--dry-run] [--with-secrets] [--workspace-id <id>]`
 * (docs/cli.md, docs/migrating-from-hermes.md). Runs in the direct runner against the
 * profile's own stores; the desktop app does not need to be running.
 */

import type Database from "better-sqlite3";
import {
  AGENT_IMPORT_SOURCES,
  type AgentImportItemResult,
  type AgentImportResult,
  type AgentImportSource,
} from "../shared/types";
import {
  createDefaultImportTargets,
  isDesktopAppRunning,
  runAgentImport,
  type ImportWorkspace,
} from "../electron/agent-import";
import { getCronStorePath } from "../electron/cron/store";
import { startMemoryRepo, stopMemoryRepo } from "../electron/memory/repo/memory-repo-bootstrap";
import { MemoryFeaturesManager } from "../electron/settings/memory-features-manager";
import { getUserDataDir } from "../electron/utils/user-data-dir";

export interface AgentImportCommandArgs {
  source?: string;
  dryRun: boolean;
  withSecrets: boolean;
  workspaceId?: string;
}

export interface AgentImportCommandDeps {
  db: Database.Database;
  findWorkspace: (workspaceId: string) => Promise<ImportWorkspace | null>;
  listWorkspacePaths: () => Promise<string[]>;
  write: (event: Record<string, unknown>, text: string) => void;
}

const SOURCE_LABELS: Record<AgentImportSource, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

const STATUS_MARKS: Record<AgentImportItemResult["status"], string> = {
  imported: "+",
  ready: "+",
  skipped: "-",
  failed: "!",
};

export function parseAgentImportSource(value: string | undefined): AgentImportSource | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (AGENT_IMPORT_SOURCES as readonly string[]).includes(normalized)
    ? (normalized as AgentImportSource)
    : null;
}

export function formatAgentImportResult(result: AgentImportResult, withSecrets: boolean): string {
  const label = SOURCE_LABELS[result.source];
  if (result.items.length === 0) {
    return `No ${label} home found at ${result.home}.`;
  }
  const lines = [`${label} home: ${result.home}${result.dryRun ? " (dry run)" : ""}`, ""];
  for (const item of result.items) {
    const mark = STATUS_MARKS[item.status];
    lines.push(`${mark} ${item.label}${item.reason ? `  (${item.reason})` : ""}`);
  }
  lines.push("");
  lines.push(
    result.dryRun
      ? `${result.ready} ready, ${result.skipped} skipped. Nothing was written; run again without --dry-run to import.`
      : `${result.imported} imported, ${result.skipped} skipped, ${result.failed} failed.`,
  );
  if (
    !withSecrets &&
    result.items.some((item) => item.category === "provider_key" || item.category === "channel")
  ) {
    lines.push("API keys and bot tokens were left out; add --with-secrets to bring them over.");
  }
  return lines.join("\n");
}

export async function runAgentImportCommand(
  args: AgentImportCommandArgs,
  deps: AgentImportCommandDeps,
): Promise<number> {
  const source = parseAgentImportSource(args.source);
  if (!source) {
    throw new Error(
      "Usage: cowork import --from hermes|openclaw [--dry-run] [--with-secrets] [--workspace-id <id>]",
    );
  }
  const workspace = args.workspaceId ? await deps.findWorkspace(args.workspaceId) : null;
  if (args.workspaceId && !workspace) throw new Error(`Workspace not found: ${args.workspaceId}`);

  // The memory folder runs only for the import: no export, no sync timer left behind.
  await startMemoryRepo({
    runtime: "cli",
    readOnly: args.dryRun,
    runExport: false,
    listWorkspacePaths: deps.listWorkspacePaths,
  });
  try {
    const targets = createDefaultImportTargets({
      db: deps.db,
      workspace,
      cron: {
        kind: "store",
        storePath: getCronStorePath(),
        desktopRunning: isDesktopAppRunning(getUserDataDir()),
      },
    });
    if (args.dryRun) {
      // The folder runs read-only for a dry run; whether it is on decides the verdict.
      targets.memory.available = () =>
        MemoryFeaturesManager.loadSettings().memoryRepoEnabled === true;
    }
    const result = await runAgentImport(source, targets, {
      withSecrets: args.withSecrets,
      dryRun: args.dryRun,
    });
    deps.write(
      { type: "agent_import", ...result },
      formatAgentImportResult(result, args.withSecrets),
    );
    return result.failed > 0 ? 1 : 0;
  } finally {
    await stopMemoryRepo();
  }
}
