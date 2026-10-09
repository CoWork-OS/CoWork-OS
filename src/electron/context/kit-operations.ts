import { ensureWorkspaceDirectory } from "../utils/workspace-directory";
import { promises as fs } from "node:fs";
import path from "node:path";
import { WORKSPACE_KIT_CONTRACTS } from "./kit-contracts";
import { buildDefaultDesignSystemMarkdown } from "./design-system-template";
import { writeKitFileWithSnapshot, type KitRevisionPathGuard } from "./kit-revisions";
import { getCronService, type CronJobCreate } from "../cron";
import { BUILTIN_ACCESS_PROFILE_IDS } from "../../shared/access-profiles";
import { isTempWorkspaceId } from "../../shared/types";
import { createLogger } from "../utils/logger";
const logger = createLogger("WorkspaceKit");
const kitDirName = ".cowork";

export const getLocalDateStamp = (now: Date): string => {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const buildKitFrontmatter = (fileName: string, updated: string): string => {
  const contract = WORKSPACE_KIT_CONTRACTS[fileName];
  if (!contract) return "";

  return [
    "---",
    `file: ${fileName}`,
    `updated: ${updated}`,
    `scope: ${contract.scope.join(", ")}`,
    `mutability: ${contract.mutability}`,
    "---",
    "",
  ].join("\n");
};

export const withKitFrontmatter = (relPath: string, content: string, updated: string): string => {
  if (!relPath.toLowerCase().endsWith(".md")) {
    return content.endsWith("\n") ? content : `${content}\n`;
  }

  const fileName = path.basename(relPath);
  const contract = WORKSPACE_KIT_CONTRACTS[fileName];
  if (contract?.parser === "design-system") {
    return content.endsWith("\n") ? content : `${content}\n`;
  }
  const frontmatter = buildKitFrontmatter(fileName, updated);
  const normalized = content.trimEnd() + "\n";
  if (!frontmatter) {
    return normalized;
  }

  return `${frontmatter}${normalized}`;
};

export const templatesForInit = (
  now: Date,
  preset: "default" | "venture_operator" = "default",
): Array<{ relPath: string; content: string }> => {
  const stamp = getLocalDateStamp(now);
  const isVenturePreset = preset === "venture_operator";
  const templates = [
    {
      relPath: path.join(kitDirName, "AGENTS.md"),
      content:
        `# Workspace Rules\n\n` +
        `## Coordination\n` +
        `- Keep durable context in .cowork/MEMORY.md\n` +
        `- For project work, log in .cowork/projects/<project>/CONTEXT.md\n` +
        `- Prefer small, well-scoped changes and leave clear notes\n\n` +
        `## Quality Bar\n` +
        `- Be explicit about assumptions and constraints\n` +
        `- Avoid duplicate work: check existing files and recent tasks first\n`,
    },
    {
      relPath: path.join(kitDirName, "USER.md"),
      content:
        `# User Profile\n\n` +
        `- Name:\n` +
        `- Preferences:\n` +
        `- Timezone:\n` +
        `- Communication style:\n`,
    },
    {
      relPath: path.join(kitDirName, "COMPANY.md"),
      content: isVenturePreset
        ? `# Company Operating Profile\n\n` +
          `## Mission\n` +
          `- What are we trying to achieve?\n\n` +
          `## Business Model\n` +
          `- ICP:\n` +
          `- Offer:\n` +
          `- Pricing:\n` +
          `- Growth loop:\n\n` +
          `## Guardrails\n` +
          `- Never do without founder approval:\n` +
          `- Allowed to do autonomously:\n` +
          `- Budget / risk thresholds:\n\n` +
          `## Current Quarter\n` +
          `- Primary company goal:\n` +
          `- Main constraints:\n`
        : `# Company Operating Profile\n\n` +
          `## Mission\n` +
          `- \n\n` +
          `## Operating Guardrails\n` +
          `- \n\n` +
          `## Current Focus\n` +
          `- \n`,
    },
    {
      relPath: path.join(kitDirName, "OPERATIONS.md"),
      content: isVenturePreset
        ? `# Operating System\n\n` +
          `## Work Loops\n` +
          `- Product discovery:\n` +
          `- Build / ship:\n` +
          `- Customer support:\n` +
          `- Growth / distribution:\n` +
          `- Finance / admin:\n\n` +
          `## Escalation Rules\n` +
          `- When to wake the founder:\n` +
          `- When to create a blocker issue:\n` +
          `- When to pause outbound actions:\n\n` +
          `## Definitions Of Done\n` +
          `- Shipping:\n` +
          `- Customer reply:\n` +
          `- Experiment review:\n`
        : `# Operating System\n\n` +
          `## Recurring Loops\n` +
          `- \n\n` +
          `## Escalations\n` +
          `- \n`,
    },
    {
      relPath: path.join(kitDirName, "KPIS.md"),
      content: isVenturePreset
        ? `# KPIs\n\n` +
          `## North Star\n` +
          `- Metric:\n` +
          `- Current:\n` +
          `- Target:\n\n` +
          `## Weekly Dashboard\n` +
          `- Revenue:\n` +
          `- New customers:\n` +
          `- Churn / refunds:\n` +
          `- Activation / conversion:\n` +
          `- Support backlog:\n` +
          `- Ship velocity:\n\n` +
          `## Notes\n` +
          `- \n`
        : `# KPIs\n\n` + `## Core Metrics\n` + `- \n\n` + `## Notes\n` + `- \n`,
    },
    {
      relPath: path.join(kitDirName, "DESIGN.md"),
      content: buildDefaultDesignSystemMarkdown(),
    },
    {
      relPath: path.join(kitDirName, "SOUL.md"),
      content:
        `# SOUL.md\n\n` +
        `## Role\n` +
        `You are the workspace operator and thought partner. You do not just answer; you help turn intent into shipped work.\n\n` +
        `## Private Voice\n` +
        `- Direct, candid, and concise.\n` +
        `- Skip preamble and choose a recommendation when the tradeoff is clear.\n` +
        `- Match the user's pace. Do not perform enthusiasm.\n\n` +
        `## Public Voice\n` +
        `- Treat public-facing output as a separate job from private chat.\n` +
        `- Keep it sharp, audience-safe, and specific to the product/customer/context.\n` +
        `- Do not leak private shorthand, internal jokes, or workspace-only assumptions.\n\n` +
        `## Pushback Contract\n` +
        `- Push back when the request is vague, wasteful, risky, misprioritized, or likely to produce weak output.\n` +
        `- Earn disagreement with evidence: concrete reasoning, examples, data, code, logs, or a better alternative.\n` +
        `- Do not be contrarian for sport. If the user's direction is sound, execute it cleanly.\n\n` +
        `## Accountability Loop\n` +
        `- Notice repeated asks, ignored outputs, stale priorities, and open loops.\n` +
        `- If good work is not being used, say what is stuck and propose the next concrete action.\n` +
        `- If your output is not useful enough to act on, improve it instead of producing more of the same.\n\n` +
        `## Autonomy Defaults\n` +
        `- Act on low-stakes implementation details without asking.\n` +
        `- State assumptions when they matter, then keep moving.\n` +
        `- Treat .cowork/RULES.md and .cowork/OPERATIONS.md as authoritative for approvals, permissions, and escalation boundaries.\n\n` +
        `## Quality Bar\n` +
        `- Working software beats documentation polish.\n` +
        `- Concrete next steps beat abstract strategy.\n` +
        `- If there are options, pick the best one and explain why briefly.\n`,
    },
    {
      relPath: path.join(kitDirName, "IDENTITY.md"),
      content:
        `# Assistant Identity\n\n` + `- Role:\n` + `- Operating assumptions:\n` + `- Boundaries:\n`,
    },
    {
      relPath: path.join(kitDirName, "RULES.md"),
      content:
        `# Operational Rules\n\n` +
        `- [ ] Requires approval for irreversible actions, external spend, and production-impacting changes\n` +
        `- [ ] Confirm ambiguous destructive actions before proceeding\n` +
        `- [ ] Record durable decisions in .cowork/MEMORY.md or project CONTEXT.md\n` +
        `- [ ] Surface blockers, assumptions, and risks explicitly\n`,
    },
    {
      relPath: path.join(kitDirName, "TOOLS.md"),
      content:
        `# Local Setup Notes\n\n` +
        `## Environment\n` +
        `- Node version:\n` +
        `- Package manager:\n` +
        `- Common commands:\n\n` +
        `## Secrets\n` +
        `- Store secrets in env vars; do not commit them\n`,
    },
    {
      relPath: path.join(kitDirName, "VIBES.md"),
      content:
        `# Vibes\n\n` +
        `Current energy and mode for this workspace. Updated by the agent based on cues.\n\n` +
        `## Current\n` +
        `<!-- cowork:auto:vibes:start -->\n` +
        `- Mode: default\n` +
        `- Energy: balanced\n` +
        `- Notes: Ready to work\n` +
        `<!-- cowork:auto:vibes:end -->\n\n` +
        `## User Preferences\n` +
        `- \n`,
    },
    {
      relPath: path.join(kitDirName, "LORE.md"),
      content:
        `# Shared Lore\n\n` +
        `This file is workspace-local and can be auto-updated by the system.\n` +
        `It captures shared history between the human and the assistant.\n\n` +
        `## Milestones\n` +
        `- \n\n` +
        `## Notes\n` +
        `- \n`,
    },
    {
      relPath: path.join(kitDirName, "BOOTSTRAP.md"),
      content:
        `# First-Run Guide\n\n` +
        `1. Fill in \`.cowork/USER.md\` (who you are, preferences).\n` +
        `2. Fill in \`.cowork/IDENTITY.md\` and \`.cowork/SOUL.md\` (how the assistant should act).\n` +
        `3. Add durable rules/constraints to \`.cowork/MEMORY.md\`.\n` +
        `4. Fill in \`.cowork/COMPANY.md\`, \`.cowork/OPERATIONS.md\`, and \`.cowork/KPIS.md\`.\n` +
        `5. Add recurring checks to \`.cowork/HEARTBEAT.md\`.\n` +
        `6. Review \`.cowork/VIBES.md\` and \`.cowork/LORE.md\` over time.\n\n` +
        (isVenturePreset
          ? `Suggested next step for venture mode: activate a founder-office or operator twin and link each active project to a workspace.\n\n`
          : ``) +
        `When onboarding is complete, you can delete this file.\n`,
    },
    {
      relPath: path.join(kitDirName, "transforms", "README.md"),
      content:
        `# Monty Transforms\n\n` +
        `Drop \`.monty\` scripts in this folder to create deterministic, reusable transforms.\n\n` +
        `Tools:\n` +
        `- monty_list_transforms: list available transforms\n` +
        `- monty_run_transform: run a transform with an input object\n` +
        `- monty_transform_file: apply a transform to a file and write output without returning full file contents to the LLM\n\n` +
        `Conventions:\n` +
        `- Your input object is available as \`input\` (a dict)\n` +
        `- The value of the last expression is returned\n\n` +
        `Example:\n` +
        `\`\`\`\n` +
        `# name: Uppercase\n` +
        `# description: Convert input['text'] to uppercase\n` +
        `input['text'].upper()\n` +
        `\`\`\`\n`,
    },
    {
      relPath: path.join(kitDirName, "transforms", "uppercase.monty"),
      content:
        `# name: Uppercase\n` +
        `# description: Convert input['text'] to uppercase\n\n` +
        `text = input.get('text') or ''\n` +
        `text.upper()\n`,
    },
    {
      relPath: path.join(kitDirName, "router", "README.md"),
      content:
        `# Gateway Router Rules (Optional)\n\n` +
        `You can add a workspace-local message triage script at:\n` +
        `- \`.cowork/router/rules.monty\`\n\n` +
        `This runs before a message is forwarded to the agent (regular messages only, not slash commands).\n` +
        `It can be used to:\n` +
        `- ignore low-signal messages ("ok", "thanks")\n` +
        `- auto-reply with deterministic responses\n` +
        `- rewrite/normalize messages before creating a task\n` +
        `- switch workspace for a session\n\n` +
        `Return a dict as the last expression:\n` +
        `- {"action": "pass"}\n` +
        `- {"action": "ignore"}\n` +
        `- {"action": "reply", "text": "..."}\n` +
        `- {"action": "rewrite", "text": "..."}\n` +
        `- {"action": "set_workspace", "workspaceId": "...", "text": "optional rewrite"}\n`,
    },
    {
      relPath: path.join(kitDirName, "router", "rules.monty"),
      content:
        `# Workspace-local gateway router rules\n` +
        `# Input is available as \`input\`.\n` +
        `# Return a dict as the last expression.\n\n` +
        `# Default: do nothing\n` +
        `{"action": "pass"}\n`,
    },
    {
      relPath: path.join(kitDirName, "policy", "README.md"),
      content:
        `# Tool Policy Hook (Optional)\n\n` +
        `You can add a workspace-local tool policy script at:\n` +
        `- \`.cowork/policy/tools.monty\`\n\n` +
        `This runs before each tool call.\n\n` +
        `Input is available as \`input\` and includes:\n` +
        `- input['tool'] (tool name)\n` +
        `- input['params'] (tool input object)\n` +
        `- input['workspace'] (id/name/path/permissions)\n` +
        `- input['gatewayContext'] ("private" | "group" | "public" | null)\n\n` +
        `Return a dict as the last expression:\n` +
        `- {"decision": "pass"}\n` +
        `- {"decision": "deny", "reason": "..."}\n` +
        `- {"decision": "require_approval", "reason": "..."}\n`,
    },
    {
      relPath: path.join(kitDirName, "policy", "tools.monty"),
      content:
        `# Workspace-local tool policy hook\n` + `# Default: allow.\n` + `{"decision": "pass"}\n`,
    },
    {
      relPath: path.join(kitDirName, "MEMORY.md"),
      content:
        `# Long-Term Memory\n\n` +
        `## Principles\n` +
        `- (add durable rules and lessons here)\n\n` +
        `## Preferences\n` +
        `- (add preferred defaults and conventions here)\n\n` +
        `## Auto Learnings\n` +
        `<!-- cowork:auto:memory:start -->\n` +
        `- (none)\n` +
        `<!-- cowork:auto:memory:end -->\n\n` +
        `## Known Constraints\n` +
        `- (add constraints and guardrails here)\n`,
    },
    {
      relPath: path.join(kitDirName, "HEARTBEAT.md"),
      content:
        `# Recurring Checks\n\n` +
        `Use this file as the proactive maintenance contract for heartbeat runs.\n` +
        `If a check turns up nothing actionable, the assistant stays silent.\n\n` +
        `## Daily\n` +
        (isVenturePreset
          ? `- Review open loops, priority issues, and due customer commitments\n` +
            `- Check KPI deltas and write notable changes into .cowork/KPIS.md\n` +
            `- Summarize key decisions into .cowork/MEMORY.md\n\n`
          : `- Review open loops and next actions\n` +
            `- Summarize key decisions into .cowork/MEMORY.md\n\n`) +
        `## Weekly\n` +
        (isVenturePreset
          ? `- Review team performance and update autonomy levels if needed\n` +
            `- Review experiment outcomes, blocked deals, and operator handoffs\n`
          : `- Review team performance and update autonomy levels if needed\n`),
    },
    {
      relPath: path.join(kitDirName, "PRIORITIES.md"),
      content:
        `# Priorities\n\n` +
        (isVenturePreset
          ? `## Company\n` +
            `1. \n` +
            `2. \n` +
            `3. \n\n` +
            `## Department / Operator\n` +
            `1. \n` +
            `2. \n` +
            `3. \n\n`
          : `## Current\n` + `1. \n` + `2. \n` + `3. \n\n`) +
        `## Notes\n` +
        `- \n\n` +
        `## History\n`,
    },
    {
      relPath: path.join(kitDirName, "CROSS_SIGNALS.md"),
      content:
        `# Cross-Agent Signals\n\n` +
        `This file is workspace-local and can be auto-updated by agents.\n` +
        `Use it to track entities/topics that show up across multiple agents, contradictions, and amplified opportunities.\n\n` +
        `## Signals (Last 24h)\n` +
        `<!-- cowork:auto:signals:start -->\n` +
        `- (none)\n` +
        `<!-- cowork:auto:signals:end -->\n\n` +
        `## Conflicts / Contradictions\n` +
        `- \n\n` +
        `## Notes\n` +
        `- \n`,
    },
    {
      relPath: path.join(kitDirName, "MISTAKES.md"),
      content:
        `# Mistakes / Preferences\n\n` +
        `This file is workspace-local and can be auto-updated by the system.\n` +
        `Use it to capture rejection reasons and durable preference patterns.\n\n` +
        `## Patterns\n` +
        `- \n\n` +
        `## Notes\n` +
        `- \n`,
    },
    {
      relPath: path.join(kitDirName, "projects", "README.md"),
      content:
        `# Project Contexts\n\n` +
        `Each project folder can contain:\n` +
        `- ACCESS.md: access rules (## Allow / ## Deny with agent role ids; deny wins)\n` +
        `- CONTEXT.md: durable working context and decisions\n` +
        `- research/: supporting documents\n`,
    },
    {
      relPath: path.join(kitDirName, "agents", "README.md"),
      content:
        `# Agent Notes\n\n` +
        `Optional workspace-local notes about agent roles, working agreements, and conventions.\n`,
    },
    {
      relPath: path.join(kitDirName, "memory", "hourly", "README.md"),
      content:
        `# Hourly Logs\n\n` +
        `This folder is intended for auto-generated hourly digests to reduce context loss.\n`,
    },
    {
      relPath: path.join(kitDirName, "memory", "weekly", "README.md"),
      content:
        `# Weekly Syntheses\n\n` +
        `This folder is intended for auto-generated weekly syntheses and compounding learnings.\n`,
    },
    {
      relPath: path.join(kitDirName, "memory", `${stamp}.md`),
      content:
        `# Daily Log (${stamp})\n\n` +
        `<!-- cowork:auto:daily:start -->\n` +
        `## Open Loops\n\n` +
        `## Next Actions\n\n` +
        `## Decisions\n\n` +
        `## Summary\n\n` +
        `<!-- cowork:auto:daily:end -->\n\n` +
        `## Notes\n` +
        `- \n`,
    },
  ];

  return templates.map((template) => ({
    ...template,
    content: withKitFrontmatter(template.relPath, template.content, stamp),
  }));
};

export const writeTemplate = async (
  workspacePath: string,
  relPath: string,
  content: string,
  mode: "missing" | "overwrite",
  pathGuard?: KitRevisionPathGuard,
) => {
  const absPath = path.join(workspacePath, relPath);
  pathGuard?.(absPath, "write");
  const dir = path.dirname(absPath);
  pathGuard?.(dir, "write");
  await ensureWorkspaceDirectory(workspacePath, dir);

  if (mode === "missing") {
    try {
      await fs.stat(absPath);
      return;
    } catch {
      // continue
    }
  }

  if (absPath.toLowerCase().endsWith(".md")) {
    writeKitFileWithSnapshot(absPath, content, "system", `kit_init:${mode}`, pathGuard);
    return;
  }

  await fs.writeFile(absPath, content, "utf8");
};

export const ensureDir = async (
  workspacePath: string,
  relPath: string,
  pathGuard?: KitRevisionPathGuard,
) => {
  const absPath = path.join(workspacePath, relPath);
  pathGuard?.(absPath, "write");
  await ensureWorkspaceDirectory(workspacePath, absPath);
};

export const ensureDefaultKitCronJobs = async (
  workspaceId: string,
  kitMode: "missing" | "overwrite",
  strict = false,
): Promise<void> => {
  if (!workspaceId || isTempWorkspaceId(workspaceId)) return;

  const cron = getCronService();
  if (!cron) {
    if (strict) throw new Error("Workspace kit scheduler is unavailable.");
    return;
  }

  const markers = {
    hourly: "cowork:kit:memory:hourly:v1",
    daily: "cowork:kit:memory:daily:v1",
    weekly: "cowork:kit:memory:weekly:v1",
  } as const;

  const buildHourlyPrompt = () =>
    [
      "You are the scheduled hourly memory digest for this workspace.",
      "",
      "Goal: preserve continuity by writing a structured hourly summary to `.cowork/memory/hourly/{{date}}.md`.",
      "",
      "Steps:",
      "1) Call tool `task_events` with:",
      '   - period: "custom"',
      '   - from: "{{prev_run}}"',
      '   - to: "{{now}}"',
      "   - limit: 500",
      `   - workspace_id: "${workspaceId}"`,
      "   - include_payload: true",
      "2) Ignore events where the taskTitle is one of:",
      '   - "Kit: Hourly Memory Digest"',
      '   - "Kit: Daily Context Sync"',
      '   - "Kit: Weekly Synthesis"',
      "3) Produce a concise structured summary ONLY from the tool output (do not hallucinate).",
      "4) Ensure `.cowork/memory/hourly/{{date}}.md` exists. If missing, create it with:",
      "   - `# Hourly Log ({{date}})`",
      "   - a blank line",
      "   - `<!-- cowork:auto:hourly:start -->`",
      "   - `<!-- cowork:auto:hourly:end -->`",
      "5) Insert a new entry immediately before `<!-- cowork:auto:hourly:end -->` (do not modify anything outside the markers).",
      "",
      "Entry format (must match):",
      "### <local timestamp YYYY-MM-DD HH:MM> ({{prev_run}} -> {{now}})",
      "Topics:",
      "- ...",
      "Decisions:",
      "- ...",
      "Action Items:",
      "- ...",
      "Risks/Blockers:",
      "- ...",
      "Signals:",
      "- ...",
      "Feedback:",
      "- ...",
      "Stats: <events> events | <user> user msgs | <assistant> assistant msgs | <toolCalls> tool calls (<toolErrors> errors) | files: +<created> ~<modified> -<deleted>",
      "",
      "Return 1-3 sentences confirming the write (do not paste the entire entry).",
    ].join("\n");

  const buildDailyPrompt = () =>
    [
      "You are the scheduled daily context sync for this workspace.",
      "",
      "Goal: consolidate today's work into `.cowork/memory/{{date}}.md` without destroying manual notes.",
      "",
      "Steps:",
      "1) Call tool `task_events` with:",
      '   - period: "today"',
      "   - limit: 500",
      `   - workspace_id: "${workspaceId}"`,
      "   - include_payload: true",
      "2) Ignore events where the taskTitle is one of:",
      '   - "Kit: Hourly Memory Digest"',
      '   - "Kit: Daily Context Sync"',
      '   - "Kit: Weekly Synthesis"',
      "3) Summarize ONLY from the tool output (do not hallucinate). Focus on: open loops, next actions, decisions, and a short narrative summary.",
      "4) Update `.cowork/memory/{{date}}.md` by upserting an auto section delimited by these markers:",
      "   - `<!-- cowork:auto:daily:start -->`",
      "   - `<!-- cowork:auto:daily:end -->`",
      "   If the file or markers are missing, create/append them; do not remove or rewrite other content.",
      "",
      "Auto section body format (must match):",
      "## Open Loops",
      "- ...",
      "",
      "## Next Actions",
      "- ...",
      "",
      "## Decisions",
      "- ...",
      "",
      "## Summary",
      "- ...",
      "",
      "Return 1-3 sentences confirming the update (do not paste the entire section).",
    ].join("\n");

  const buildWeeklyPrompt = () =>
    [
      "You are the scheduled weekly synthesis for this workspace.",
      "",
      "Goal: distill compounding learnings and next-week focus, then update `.cowork/MEMORY.md` (auto section) and write a weekly report file.",
      "",
      "Steps:",
      "1) Call tool `task_events` with:",
      '   - period: "last_7_days"',
      "   - limit: 500",
      `   - workspace_id: "${workspaceId}"`,
      "   - include_payload: true",
      "2) Ground preference patterns in actual recorded feedback: the corrections in the memory folder (your memory context) and `.cowork/MISTAKES.md`.",
      "3) Write a weekly report to `.cowork/memory/weekly/{{date}}.md` with:",
      "   - Wins (what shipped / moved forward)",
      "   - Misses (what stalled / why)",
      "   - Patterns (approval/rejection themes)",
      "   - Process updates (what to do differently)",
      "   - Next week focus (top 3)",
      "4) Update `.cowork/MEMORY.md` by upserting an auto section delimited by:",
      "   - `<!-- cowork:auto:memory:start -->`",
      "   - `<!-- cowork:auto:memory:end -->`",
      "   Keep it to 5-15 bullets, only durable learnings and preferences (no daily noise).",
      "",
      "Constraints:",
      "- Do not hallucinate; ground everything in tool output, `.cowork/MISTAKES.md` and the memory folder's corrections.",
      '- Ignore events from tasks titled "Kit: Hourly Memory Digest" / "Kit: Daily Context Sync" / "Kit: Weekly Synthesis".',
      "",
      "Return 1-3 sentences confirming the write (do not paste the full report).",
    ].join("\n");

  try {
    const existing = await cron.list({ includeDisabled: true });
    const existingInWorkspace = existing.filter((j) => j.workspaceId === workspaceId);

    const desired: Array<{ marker: string; job: CronJobCreate }> = [
      {
        marker: markers.hourly,
        job: {
          name: "Kit: Hourly Memory Digest",
          description: `Automated hourly memory digest. [${markers.hourly}]`,
          enabled: true,
          accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
          schedule: { kind: "cron", expr: "0 * * * *" },
          workspaceId,
          taskPrompt: buildHourlyPrompt(),
          taskTitle: "Kit: Hourly Memory Digest",
          maxHistoryEntries: 25,
        },
      },
      {
        marker: markers.daily,
        job: {
          name: "Kit: Daily Context Sync",
          description: `Automated daily context sync. [${markers.daily}]`,
          enabled: true,
          accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
          schedule: { kind: "cron", expr: "0 21 * * *" },
          workspaceId,
          taskPrompt: buildDailyPrompt(),
          taskTitle: "Kit: Daily Context Sync",
          maxHistoryEntries: 25,
        },
      },
      {
        marker: markers.weekly,
        job: {
          name: "Kit: Weekly Synthesis",
          description: `Automated weekly synthesis. [${markers.weekly}]`,
          enabled: true,
          accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
          schedule: { kind: "cron", expr: "0 18 * * 0" },
          workspaceId,
          taskPrompt: buildWeeklyPrompt(),
          taskTitle: "Kit: Weekly Synthesis",
          maxHistoryEntries: 25,
        },
      },
    ];

    const findJob = (name: string, marker: string) =>
      existingInWorkspace.find(
        (j) => typeof j.description === "string" && j.description.includes(marker),
      ) ?? existingInWorkspace.find((j) => j.name === name);

    for (const spec of desired) {
      const existingJob = findJob(spec.job.name, spec.marker);
      if (!existingJob) {
        const res = await cron.add(spec.job);
        if (!res.ok) {
          if (strict) throw new Error(res.error || "Failed to add kit scheduled job.");
          logger.warn("[Kit] Failed to add scheduled job:", spec.job.name, res.error);
        }
        continue;
      }

      // Update kit-managed job prompts/description. Preserve schedule/enabled in "missing" mode.
      const patch: Any = {
        name: spec.job.name,
        description: spec.job.description,
        taskPrompt: spec.job.taskPrompt,
        taskTitle: spec.job.taskTitle,
        maxHistoryEntries: spec.job.maxHistoryEntries,
        accessProfileId: spec.job.accessProfileId,
      };

      if (kitMode === "overwrite") {
        patch.enabled = spec.job.enabled;
        patch.schedule = spec.job.schedule;
      }

      const needsUpdate = (() => {
        if (existingJob.name !== patch.name) return true;
        if ((existingJob.description || "") !== (patch.description || "")) return true;
        if (existingJob.taskPrompt !== patch.taskPrompt) return true;
        if ((existingJob.taskTitle || "") !== (patch.taskTitle || "")) return true;
        if ((existingJob.maxHistoryEntries || 0) !== (patch.maxHistoryEntries || 0)) return true;
        if (kitMode === "overwrite") {
          if (existingJob.enabled !== patch.enabled) return true;
          if (JSON.stringify(existingJob.schedule) !== JSON.stringify(patch.schedule)) return true;
        }
        return false;
      })();

      if (!needsUpdate) continue;

      const res = await cron.update(existingJob.id, patch);
      if (!res.ok) {
        if (strict) throw new Error(res.error || "Failed to update kit scheduled job.");
        logger.warn("[Kit] Failed to update scheduled job:", spec.job.name, res.error);
      }
    }
  } catch (error) {
    if (strict) throw error;
    logger.warn("[Kit] Failed to ensure default scheduled jobs:", error);
  }
};

export async function createKitProject(
  workspacePath: string,
  projectId: string,
  guard?: KitRevisionPathGuard,
): Promise<{ success: boolean; projectId: string }> {
  const rawId = projectId.trim();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(rawId) || rawId.includes("..") || rawId === ".")
    throw new Error("Invalid project id");
  const root = path.join(kitDirName, "projects", rawId);
  await ensureDir(workspacePath, root, guard);
  await ensureDir(workspacePath, path.join(root, "research"), guard);
  const stamp = getLocalDateStamp(new Date());
  for (const [name, content] of [
    ["ACCESS.md", "# Access\n\n## Allow\n- all\n\n## Deny\n- \n"],
    [
      "CONTEXT.md",
      "# Context\n\nLast updated by:\n\n## Goals\n\n## Constraints\n\n## Decisions\n\n## Notes\n",
    ],
  ]) {
    const relPath = path.join(root, name);
    guard?.(path.join(workspacePath, relPath), "read");
    await writeTemplate(
      workspacePath,
      relPath,
      withKitFrontmatter(relPath, content, stamp),
      "missing",
      guard,
    );
  }
  return { success: true, projectId: rawId };
}
