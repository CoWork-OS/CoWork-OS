import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import type { OnboardingProfileData } from "../../shared/onboarding";
import type { UserFact } from "../../shared/types";
import {
  buildOnboardingProfileFacts,
  buildOnboardingWorkspaceSummary,
} from "../../shared/onboarding";
import { UserProfileService } from "../memory/UserProfileService";
import { MemoryService } from "../memory/MemoryService";
import { KIT_DIR_NAME, ensureBootstrapLifecycleState } from "../context/kit-status";
import { WORKSPACE_KIT_CONTRACTS } from "../context/kit-contracts";
import { writeKitFileWithSnapshot } from "../context/kit-revisions";

const ONBOARDING_PROFILE_MARKER = "onboarding-profile";
const ONBOARDING_IDENTITY_MARKER = "onboarding-identity";
const ONBOARDING_MEMORY_MARKER = "onboarding-memory";
const ONBOARDING_PRIORITIES_MARKER = "onboarding-priorities";
const ONBOARDING_TOOLS_MARKER = "onboarding-tools";
const ONBOARDING_FACT_TASK_ID = "onboarding-profile";
const EMPTY_ONBOARDING_PRIORITIES_LINE = "- No explicit onboarding priorities recorded yet.";
const EMPTY_ONBOARDING_TOOLS_LINE = "- No core apps or tools recorded yet.";

const ONBOARDING_MANAGED_FACT_PATTERNS = [
  /^Preferred name:\s+/,
  /^Current work context:\s+/,
  /^Main time drains:\s+/,
  /^Main priorities:\s+/,
  /^Core tools:\s+/,
  /^Preferred response style:\s+/,
  /^Onboarding guidance:\s+/,
  /^Memory is enabled for useful recurring context\.$/,
] as const;

function formatUpdatedStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function buildKitFrontmatter(fileName: string, updated: string): string {
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
}

function withKitFrontmatter(relPath: string, content: string, updated: string): string {
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
}

function sectionBlock(marker: string, heading: string, body: string): string {
  return [
    heading,
    `<!-- cowork:auto:${marker}:start -->`,
    body.trim(),
    `<!-- cowork:auto:${marker}:end -->`,
  ].join("\n");
}

function upsertAutoSection(
  existing: string,
  marker: string,
  heading: string,
  body: string,
): string {
  const block = sectionBlock(marker, heading, body);
  const regex = new RegExp(
    `## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n<!-- cowork:auto:${marker}:start -->[\\s\\S]*?<!-- cowork:auto:${marker}:end -->`,
    "m",
  );

  if (regex.test(existing)) {
    return existing.replace(regex, block).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  const trimmed = existing.trimEnd();
  if (!trimmed) {
    return `${block}\n`;
  }

  return `${trimmed}\n\n${block}\n`;
}

function ensureDefaultMarkdown(fileName: string): string {
  switch (fileName) {
    case "USER.md":
      return "# User Profile\n";
    case "IDENTITY.md":
      return "# Assistant Identity\n";
    case "MEMORY.md":
      return "# Long-Term Memory\n";
    case "PRIORITIES.md":
      return "# Priorities\n";
    case "TOOLS.md":
      return "# Local Setup Notes\n";
    default:
      return `# ${fileName.replace(/\.md$/i, "")}\n`;
  }
}

function providerLabel(data: OnboardingProfileData): string {
  if (data.selectedProvider === "ollama" && data.detectedOllamaModel) {
    return `Ollama (${data.detectedOllamaModel})`;
  }
  if (!data.selectedProvider) {
    return "Not configured yet";
  }
  switch (data.selectedProvider) {
    case "openrouter":
      return "OpenRouter";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "groq":
      return "Groq";
    case "xai":
      return "Grok";
    case "kimi":
      return "Kimi";
    case "bedrock":
      return "AWS Bedrock";
    case "ollama":
      return "Ollama";
    default:
      return data.selectedProvider;
  }
}

function isLegacyOnboardingFact(fact: UserFact): boolean {
  if (fact.source !== "manual") return false;

  const value = String(fact.value || "").trim();
  if (!value) return false;
  if (ONBOARDING_MANAGED_FACT_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }

  // Legacy onboarding stored the freeform user context as a pinned manual work fact
  // without a prefix, and additional guidance as a pinned manual preference fact.
  if (
    fact.category === "work" &&
    fact.pinned === true &&
    Math.abs(fact.confidence - 0.95) < 0.001
  ) {
    return true;
  }

  if (
    fact.category === "preference" &&
    fact.pinned === true &&
    Math.abs(fact.confidence - 0.9) < 0.001
  ) {
    return true;
  }

  return false;
}

async function writeManagedKitDoc(
  workspacePath: string,
  relPath: string,
  marker: string,
  heading: string,
  body: string,
  now: Date,
): Promise<void> {
  const absPath = path.join(workspacePath, relPath);
  const updated = formatUpdatedStamp(now);
  await fsp.mkdir(path.dirname(absPath), { recursive: true });

  const existing = fs.existsSync(absPath)
    ? await fsp.readFile(absPath, "utf8")
    : withKitFrontmatter(relPath, ensureDefaultMarkdown(path.basename(relPath)), updated);

  const { body: bodyWithoutFrontmatter } = (() => {
    const normalized = existing.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) return { body: normalized };
    const end = normalized.indexOf("\n---\n", 4);
    if (end === -1) return { body: normalized };
    return { body: normalized.slice(end + 5) };
  })();

  const nextBody = upsertAutoSection(bodyWithoutFrontmatter, marker, heading, body);
  const nextContent = withKitFrontmatter(relPath, nextBody, updated);
  writeKitFileWithSnapshot(absPath, nextContent, "system", "apply onboarding profile");
}

export class OnboardingProfileService {
  static applyGlobalProfile(data: OnboardingProfileData): void {
    const existingFacts = UserProfileService.getProfile().facts;
    for (const fact of existingFacts) {
      if (fact.lastTaskId === ONBOARDING_FACT_TASK_ID || isLegacyOnboardingFact(fact)) {
        UserProfileService.deleteFact(fact.id);
      }
    }

    for (const fact of buildOnboardingProfileFacts(data)) {
      try {
        UserProfileService.addFact({
          ...fact,
          taskId: ONBOARDING_FACT_TASK_ID,
        });
      } catch {
        // Best-effort; duplicate or invalid facts should not block onboarding.
      }
    }
  }

  static async applyWorkspaceProfile(
    workspaceId: string,
    workspacePath: string,
    data: OnboardingProfileData,
  ): Promise<void> {
    const now = new Date();
    const summary = buildOnboardingWorkspaceSummary(data);
    const kitRoot = path.join(workspacePath, KIT_DIR_NAME);
    await fsp.mkdir(kitRoot, { recursive: true });

    await writeManagedKitDoc(
      workspacePath,
      path.join(KIT_DIR_NAME, "USER.md"),
      ONBOARDING_PROFILE_MARKER,
      "Onboarding Profile",
      [
        data.userName.trim() ? `- Name: ${data.userName.trim()}` : "",
        data.userContext.trim() ? `- Current focus: ${data.userContext.trim()}` : "",
        `- Communication style: ${summary.responseStyle}`,
        summary.timeDrains.length > 0
          ? `- Biggest time drains: ${summary.timeDrains.join(", ")}`
          : "",
        summary.priorities.length > 0
          ? `- Top priorities: ${summary.priorities.join(", ")}`
          : "",
        data.workflowTools.trim() ? `- Core tools: ${data.workflowTools.trim()}` : "",
        data.additionalGuidance.trim()
          ? `- Keep in mind: ${data.additionalGuidance.trim()}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      now,
    );

    await writeManagedKitDoc(
      workspacePath,
      path.join(KIT_DIR_NAME, "IDENTITY.md"),
      ONBOARDING_IDENTITY_MARKER,
      "Onboarding Identity",
      [
        `- Name: ${data.assistantName.trim() || "CoWork"}`,
        `- Role: CoWork OS operator for this workspace`,
        `- Style anchors: ${summary.assistantStyle}`,
        data.workStyle === "planner"
          ? "- Operating assumptions: Prefer clear plans and visible progress."
          : data.workStyle === "flexible"
            ? "- Operating assumptions: Move quickly and adapt in real time."
            : "",
        `- Model provider: ${providerLabel(data)}`,
        `- Voice replies: ${data.voiceEnabled ? "Enabled" : "Disabled"}`,
      ]
        .filter(Boolean)
        .join("\n"),
      now,
    );

    await writeManagedKitDoc(
      workspacePath,
      path.join(KIT_DIR_NAME, "MEMORY.md"),
      ONBOARDING_MEMORY_MARKER,
      "Onboarding Memory",
      [
        summary.priorities.length > 0
          ? `- Help first with: ${summary.priorities.join(", ")}.`
          : "",
        summary.timeDrains.length > 0
          ? `- Watch for recurring drag from: ${summary.timeDrains.join(", ")}.`
          : "",
        `- Keep responses ${summary.responseStyle.toLowerCase()}.`,
        data.additionalGuidance.trim() ? `- Always remember: ${data.additionalGuidance.trim()}.` : "",
        data.memoryEnabled
          ? "- Memory is allowed for useful recurring context."
          : "- Memory remains off until the user enables it.",
      ]
        .filter(Boolean)
        .join("\n"),
      now,
    );

    await writeManagedKitDoc(
      workspacePath,
      path.join(KIT_DIR_NAME, "PRIORITIES.md"),
      ONBOARDING_PRIORITIES_MARKER,
      "Onboarding Priorities",
      summary.priorities.length > 0
        ? summary.priorities.map((item, index) => `${index + 1}. ${item}`).join("\n")
        : EMPTY_ONBOARDING_PRIORITIES_LINE,
      now,
    );

    await writeManagedKitDoc(
      workspacePath,
      path.join(KIT_DIR_NAME, "TOOLS.md"),
      ONBOARDING_TOOLS_MARKER,
      "Onboarding Tool Stack",
      data.workflowTools.trim()
        ? `- Core tools: ${data.workflowTools.trim()}`
        : EMPTY_ONBOARDING_TOOLS_LINE,
      now,
    );

    const bootstrapPath = path.join(kitRoot, "BOOTSTRAP.md");
    if (fs.existsSync(bootstrapPath)) {
      await fsp.unlink(bootstrapPath).catch(() => undefined);
    }
    await ensureBootstrapLifecycleState(workspacePath);

    try {
      await MemoryService.syncWorkspaceMarkdown(workspaceId, kitRoot, true);
    } catch {
      // Best-effort sync only.
    }
  }
}
