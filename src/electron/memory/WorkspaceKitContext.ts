import fs from "fs";
import path from "path";
import { buildWorkspaceKitSections } from "../context/kit-injection";
import {
  WORKSPACE_KIT_CONTRACTS,
  type KitContract,
  type KitScope,
} from "../context/kit-contracts";
import { parseKitDocument } from "../context/kit-parser";
import { checkProjectAccessFromMarkdown } from "../security/project-access";
import { InputSanitizer } from "../agent/security";
import { redactSensitiveMarkdownContent } from "./MarkdownMemoryIndexService";

type ExtractedSection = {
  title: string;
  relPath: string;
  content: string;
};

const KIT_DIRNAME = ".cowork";
const MAX_FILE_BYTES = 96 * 1024;
const MAX_SECTION_CHARS = 6000;
const MAX_TOTAL_CHARS = 16000;
const AUTO_LORE_START = "<!-- cowork:auto:lore:start -->";
const AUTO_LORE_END = "<!-- cowork:auto:lore:end -->";

const MAP_FILES: Array<{ relPath: string; title: string }> = [
  { relPath: "docs/CODEBASE_MAP.md", title: "Codebase Map" },
  { relPath: "docs/architecture.md", title: "Architecture Notes" },
  { relPath: "ARCHITECTURE.md", title: "Architecture Notes (Root)" },
];

function getLocalDateStamp(now: Date): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function safeResolveWithinWorkspace(workspacePath: string, relPath: string): string | null {
  const root = path.resolve(workspacePath);
  const candidate = path.resolve(root, relPath);
  if (candidate === root || candidate.startsWith(root + path.sep)) {
    return candidate;
  }
  return null;
}

function readFilePrefix(absPath: string, maxBytes: number): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;

    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buf, 0, size, 0);
      return buf.toString("utf8", 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function extractBulletSections(
  markdown: string,
  opts?: { onlyHeadings?: Set<string>; maxBulletsPerSection?: number; maxSections?: number },
): string {
  const onlyHeadings = opts?.onlyHeadings;
  const maxBulletsPerSection = opts?.maxBulletsPerSection ?? 12;
  const maxSections = opts?.maxSections ?? 8;

  const lines = markdown.split("\n");
  const sections: Array<{ heading: string; bullets: string[] }> = [];

  let currentHeading = "";
  let currentBullets: string[] = [];

  const flush = () => {
    if (!currentHeading && currentBullets.length === 0) return;
    if (onlyHeadings && currentHeading && !onlyHeadings.has(currentHeading)) {
      currentBullets = [];
      return;
    }
    const bullets = currentBullets.filter((b) => /^\s*-\s+\S/.test(b));
    if (bullets.length === 0) {
      currentBullets = [];
      return;
    }
    sections.push({
      heading: currentHeading || "Notes",
      bullets: bullets.slice(0, maxBulletsPerSection),
    });
    currentBullets = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)\s*$/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1].trim();
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      currentBullets.push(line.trimEnd());
    }
  }
  flush();

  const selected = sections.slice(0, maxSections);
  const rendered: string[] = [];
  for (const section of selected) {
    rendered.push(`#### ${section.heading}`);
    rendered.push(section.bullets.join("\n"));
    rendered.push("");
  }
  return rendered.join("\n").trim();
}

function extractFilledKvLines(markdown: string): string {
  const kept = markdown
    .split("\n")
    .flatMap((line) => {
      const bulletMatch = line.match(/^\s*-\s*([^:]+):(.*)$/);
      if (bulletMatch) {
        const value = bulletMatch[2].trim();
        return value ? [`- ${bulletMatch[1].trim()}: ${value}`] : [];
      }

      const plainMatch = line.match(/^\s*([^#\-\s][^:]*):(.*)$/);
      if (plainMatch) {
        const value = plainMatch[2].trim();
        return value ? [`${plainMatch[1].trim()}: ${value}`] : [];
      }

      return [];
    });

  return kept.join("\n").trim();
}

function stripMarkedBlock(markdown: string, startMarker: string, endMarker: string): string {
  if (!markdown) return "";
  const pattern = new RegExp(
    `${startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
    "g",
  );
  return markdown.replace(pattern, "").trim();
}

function formatWorkspaceKitBody(body: string, contract: KitContract): string {
  const normalizedBody =
    contract.file === "LORE.md" ? stripMarkedBlock(body, AUTO_LORE_START, AUTO_LORE_END) : body;
  switch (contract.parser) {
    case "kv-lines":
      return extractFilledKvLines(normalizedBody) || normalizedBody.trim();
    case "decision-log":
      return extractBulletSections(normalizedBody) || normalizedBody.trim();
    default:
      return normalizedBody.trim();
  }
}

function sanitizeForInjection(text: string): string {
  const redacted = redactSensitiveMarkdownContent(text || "");
  return InputSanitizer.sanitizeMemoryContent(redacted).trim();
}

function clampSection(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n[... truncated ...]";
}

function buildMapSections(workspacePath: string): ExtractedSection[] {
  const sections: ExtractedSection[] = [];

  for (const file of MAP_FILES) {
    const absPath = safeResolveWithinWorkspace(workspacePath, file.relPath);
    if (!absPath) continue;
    const raw = readFilePrefix(absPath, MAX_FILE_BYTES);
    if (!raw) continue;
    const extracted = sanitizeForInjection(clampSection(raw, MAX_SECTION_CHARS));
    if (!extracted) continue;
    sections.push({
      title: file.title,
      relPath: file.relPath.replace(/\\/g, "/"),
      content: extracted,
    });
  }

  return sections;
}

function scoreTextOverlap(a: string, b: string): number {
  const tokensA = new Set((a.toLowerCase().match(/[a-z0-9]{3,}/g) || []).slice(0, 200));
  const tokensB = new Set((b.toLowerCase().match(/[a-z0-9]{3,}/g) || []).slice(0, 400));
  let score = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) score += 1;
  }
  return score;
}

function renderProjectDoc(
  workspacePath: string,
  relPath: string,
  contract: KitContract,
  formatter?: (body: string) => string,
): string {
  const absPath = safeResolveWithinWorkspace(workspacePath, relPath);
  if (!absPath) return "";
  const parsed = parseKitDocument(absPath, contract, relPath.replace(/\\/g, "/"));
  if (!parsed) return "";
  const body = formatter ? formatter(parsed.body) : parsed.body;
  return body.trim();
}

function buildProjectContextSections(
  workspacePath: string,
  taskPrompt: string,
  agentRoleId: string | null,
): ExtractedSection[] {
  const sections: ExtractedSection[] = [];

  const projectsDirRel = path.join(KIT_DIRNAME, "projects");
  const projectsDirAbs = safeResolveWithinWorkspace(workspacePath, projectsDirRel);
  if (!projectsDirAbs) return sections;

  try {
    if (!fs.existsSync(projectsDirAbs) || !fs.statSync(projectsDirAbs).isDirectory()) {
      return sections;
    }
  } catch {
    return sections;
  }

  type Candidate = { name: string; score: number; contextRel: string; accessRel: string };
  const candidates: Candidate[] = [];

  try {
    const dirents = fs.readdirSync(projectsDirAbs, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name;
      if (!name || name.startsWith(".")) continue;

      const contextRel = path.join(projectsDirRel, name, "CONTEXT.md");
      const accessRel = path.join(projectsDirRel, name, "ACCESS.md");
      const contextAbs = safeResolveWithinWorkspace(workspacePath, contextRel);
      if (!contextAbs) continue;

      const raw = readFilePrefix(contextAbs, MAX_FILE_BYTES);
      if (!raw) continue;

      const nameScore = scoreTextOverlap(taskPrompt, name.replace(/[-_]/g, " "));
      const contentScore = scoreTextOverlap(taskPrompt, raw.slice(0, 6000));
      candidates.push({ name, score: nameScore * 3 + contentScore, contextRel, accessRel });
    }
  } catch {
    return sections;
  }

  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates.filter((candidate) => candidate.score > 0).slice(0, 2);
  if (selected.length === 0) return sections;

  const accessContract = WORKSPACE_KIT_CONTRACTS["ACCESS.md"];
  const contextContract = WORKSPACE_KIT_CONTRACTS["CONTEXT.md"];

  for (const candidate of selected) {
    const accessAbs = safeResolveWithinWorkspace(workspacePath, candidate.accessRel);
    const accessRaw = accessAbs ? readFilePrefix(accessAbs, Math.min(MAX_FILE_BYTES, 24 * 1024)) : null;
    if (accessRaw && agentRoleId) {
      const res = checkProjectAccessFromMarkdown({ markdown: accessRaw, agentRoleId });
      if (!res.allowed) continue;
    }

    const accessText = accessContract
      ? renderProjectDoc(workspacePath, candidate.accessRel, accessContract, (body) => clampSection(body, 2000))
      : "";
    const contextText = contextContract
      ? renderProjectDoc(workspacePath, candidate.contextRel, contextContract, (body) => clampSection(body, MAX_SECTION_CHARS))
      : "";

    const combined = [
      accessText ? `#### Access (${candidate.accessRel.replace(/\\/g, "/")})\n${accessText}` : "",
      contextText ? `#### Context (${candidate.contextRel.replace(/\\/g, "/")})\n${contextText}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (!combined) continue;

    sections.push({
      title: `Project: ${candidate.name}`,
      relPath: candidate.contextRel.replace(/\\/g, "/"),
      content: combined,
    });
  }

  return sections;
}

function buildDailyLogSection(workspacePath: string, now: Date): ExtractedSection[] {
  const stamp = getLocalDateStamp(now);
  const relPath = path.join(KIT_DIRNAME, "memory", `${stamp}.md`);
  const absPath = safeResolveWithinWorkspace(workspacePath, relPath);
  if (!absPath) return [];

  const raw = readFilePrefix(absPath, MAX_FILE_BYTES);
  if (!raw) return [];

  const extracted = sanitizeForInjection(
    extractBulletSections(raw, {
      onlyHeadings: new Set(["Open Loops", "Next Actions", "Decisions", "Summary"]),
      maxSections: 4,
    }),
  );
  if (!extracted) return [];

  return [
    {
      title: `Daily Log (${stamp})`,
      relPath: relPath.replace(/\\/g, "/"),
      content: extracted,
    },
  ];
}

function buildScopedKitSections(
  workspacePath: string,
  scopes: KitScope[],
  onboardingIncomplete: boolean,
): ExtractedSection[] {
  return buildWorkspaceKitSections({
    workspacePath,
    scopes,
    onboardingIncomplete,
  }).map((section) => ({
    title: section.title,
    relPath: section.relPath,
    content: formatWorkspaceKitBody(section.parsed.body, section.contract),
  }));
}

export function buildWorkspaceKitContext(
  workspacePath: string,
  taskPrompt: string,
  now: Date = new Date(),
  opts?: { agentRoleId?: string | null },
): string {
  const collectedSections: ExtractedSection[] = [];
  const agentRoleId = typeof opts?.agentRoleId === "string" ? opts.agentRoleId : null;

  collectedSections.push(...buildMapSections(workspacePath));

  const kitDir = safeResolveWithinWorkspace(workspacePath, KIT_DIRNAME);
  if (kitDir) {
    try {
      if (fs.existsSync(kitDir) && fs.statSync(kitDir).isDirectory()) {
        collectedSections.push(...buildScopedKitSections(workspacePath, ["task", "company-ops"], false));
        collectedSections.push(...buildProjectContextSections(workspacePath, taskPrompt, agentRoleId));
        collectedSections.push(...buildDailyLogSection(workspacePath, now));
      }
    } catch {
      // ignore
    }
  }

  if (collectedSections.length === 0) return "";

  const parts: string[] = [];
  let totalChars = 0;

  for (const section of collectedSections) {
    const header = `### ${section.title} (${section.relPath})`;
    const body = clampSection(section.content, MAX_SECTION_CHARS);
    const block = `${header}\n${body}\n`;

    if (totalChars + block.length > MAX_TOTAL_CHARS) {
      const remaining = Math.max(0, MAX_TOTAL_CHARS - totalChars);
      if (remaining > 200) {
        parts.push(block.slice(0, remaining) + "\n[... truncated ...]");
      }
      break;
    }

    parts.push(block);
    totalChars += block.length;
  }

  return parts.join("\n").trim();
}
