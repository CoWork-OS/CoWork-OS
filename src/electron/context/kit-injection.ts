import path from "path";
import {
  type KitContract,
  type KitScope,
  ROLE_KIT_FILES,
  WORKSPACE_KIT_CONTRACTS,
  WORKSPACE_PROMPT_ORDER,
} from "./kit-contracts";
import { type ParsedKitDoc, parseKitDocument } from "./kit-parser";

export interface InjectionContext {
  workspacePath: string;
  scopes: KitScope[];
  roleDir?: string;
  includeWarnings?: boolean;
  onboardingIncomplete?: boolean;
  readGuard?: (candidatePath: string) => boolean;
}

export interface RenderedKitSection {
  file: string;
  title: string;
  relPath: string;
  rendered: string;
  parsed: ParsedKitDoc;
  contract: KitContract;
}

export interface HeartbeatTask {
  check: string;
  cadence?: string;
  ifTriggered?: string;
  action?: "summarize" | "flag" | "propose";
}

function hasScope(target: KitScope[], active: KitScope[]): boolean {
  return target.some((scope) => active.includes(scope));
}

function shouldIncludeContract(contract: KitContract, ctx: InjectionContext): boolean {
  if (!hasScope(contract.scope, ctx.scopes)) return false;
  if (contract.specialHandling === "bootstrap" && !ctx.onboardingIncomplete) return false;
  return true;
}

function renderSection(
  parsed: ParsedKitDoc,
  contract: KitContract,
  relPath: string,
  includeWarnings = false,
): string {
  const heading = `### ${contract.title} (${relPath.replace(/\\/g, "/")})`;
  const warningText =
    includeWarnings && parsed.warnings.length > 0
      ? `\nWarnings:\n- ${parsed.warnings.join("\n- ")}`
      : "";
  return `${heading}\n${parsed.body}${warningText}`.trim();
}

export function buildWorkspaceKitSections(ctx: InjectionContext): RenderedKitSection[] {
  const sections: RenderedKitSection[] = [];

  for (const file of WORKSPACE_PROMPT_ORDER) {
    const contract = WORKSPACE_KIT_CONTRACTS[file];
    if (!contract) continue;
    if (!shouldIncludeContract(contract, ctx)) continue;

    const relPath = path.join(".cowork", contract.file).replace(/\\/g, "/");
    const absPath = path.join(ctx.workspacePath, ".cowork", contract.file);
    if (ctx.readGuard) {
      try {
        if (!ctx.readGuard(absPath)) continue;
      } catch {
        continue;
      }
    }
    const parsed = parseKitDocument(absPath, contract, relPath);
    if (!parsed) continue;

    sections.push({
      file: contract.file,
      title: contract.title,
      relPath,
      rendered: renderSection(parsed, contract, relPath, ctx.includeWarnings),
      parsed,
      contract,
    });
  }

  return sections;
}

export function buildOrderedKitPrompt(ctx: InjectionContext): string {
  return buildWorkspaceKitSections(ctx)
    .map((section) => section.rendered)
    .join("\n\n")
    .trim();
}

export function buildRoleKitSection(
  workspacePath: string,
  roleDir: string,
  file: (typeof ROLE_KIT_FILES)[number],
): RenderedKitSection | null {
  const contract = WORKSPACE_KIT_CONTRACTS[file];
  if (!contract) return null;

  const relPath = path.join(".cowork", "agents", roleDir, file).replace(/\\/g, "/");
  const absPath = path.join(workspacePath, ".cowork", "agents", roleDir, file);
  const parsed = parseKitDocument(absPath, contract, relPath);
  if (!parsed) return null;

  return {
    file,
    title: contract.title,
    relPath,
    rendered: renderSection(parsed, contract, relPath, false),
    parsed,
    contract,
  };
}

export function parseHeartbeatChecklist(body: string): HeartbeatTask[] {
  const tasks: HeartbeatTask[] = [];
  let currentCadence: string | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^##+\s+(.+)$/);
    if (heading) {
      currentCadence = heading[1].trim();
      continue;
    }

    const checkbox = line.match(/^-\s*\[(?: |x)?\]\s*(.+)$/i);
    const bullet = line.match(/^-\s+(.+)$/);
    const check = (checkbox?.[1] || bullet?.[1] || "").trim();
    if (!check) continue;

    tasks.push({
      check,
      cadence: currentCadence,
      action: "propose",
    });
  }

  return tasks;
}

export function renderHeartbeatPrompt(tasks: HeartbeatTask[]): string {
  if (!tasks.length) return "HEARTBEAT: no proactive checks configured.";

  return [
    "HEARTBEAT CHECKLIST",
    ...tasks.map((task, index) => {
      const cadence = task.cadence ? ` [${task.cadence}]` : "";
      return `${index + 1}. ${task.check}${cadence} -> default action: ${task.action || "propose"}`;
    }),
    "",
    "Do not take irreversible or external actions unless separately allowed.",
  ].join("\n");
}
