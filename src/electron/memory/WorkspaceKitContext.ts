import fs from "fs";
import path from "path";
import { buildWorkspaceKitSections } from "../context/kit-injection";
import { WORKSPACE_KIT_CONTRACTS, type KitContract, type KitScope } from "../context/kit-contracts";
import { parseKitDocument } from "../context/kit-parser";
import { checkProjectAccessFromMarkdown } from "../security/project-access";
import { InputSanitizer } from "../agent/security";
import { redactSensitiveMarkdownContent } from "./MarkdownMemoryIndexService";
import type { MarkdownMemoryReadGuard } from "./MarkdownMemoryIndexService";

type ExtractedSection = {
  title: string;
  relPath: string;
  content: string;
  /** Per-section cap; defaults to MAX_SECTION_CHARS. */
  maxChars?: number;
};

const KIT_DIRNAME = ".cowork";
const MAX_FILE_BYTES = 96 * 1024;
const MAX_SECTION_CHARS = 6000;
const MAX_TOTAL_CHARS = 24000;
/**
 * Repo-root agent instructions (AGENTS.md, the cross-tool standard; CLAUDE.md as a
 * fallback). Loaded whether or not the workspace has a .cowork kit, with their own
 * budget so they are never crowded out by kit files.
 */
const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const MAX_PROJECT_INSTRUCTIONS_CHARS = 20000;
const MAX_DESIGN_CONTEXT_CHARS = 7000;
const AUTO_LORE_START = "<!-- cowork:auto:lore:start -->";
const AUTO_LORE_END = "<!-- cowork:auto:lore:end -->";

function canReadPath(
  readGuard: MarkdownMemoryReadGuard | undefined,
  candidatePath: string,
): boolean {
  if (!readGuard) return true;
  try {
    return readGuard(candidatePath) === true;
  } catch {
    return false;
  }
}

const MAP_FILES: Array<{ relPath: string; title: string }> = [
  { relPath: "docs/CODEBASE_MAP.md", title: "Codebase Map" },
  { relPath: "docs/architecture.md", title: "Architecture Notes" },
  { relPath: "ARCHITECTURE.md", title: "Architecture Notes (Root)" },
];

const DESIGN_SYSTEM_FILES = [
  ".cowork/DESIGN.md",
  "DESIGN.md",
  "docs/DESIGN.md",
  "design/DESIGN.md",
] as const;

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

function readFilePrefix(
  absPath: string,
  maxBytes: number,
  readGuard?: MarkdownMemoryReadGuard,
): string | null {
  if (!canReadPath(readGuard, absPath)) return null;
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
  const kept = markdown.split("\n").flatMap((line) => {
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

/**
 * Generated curated auto-blocks of USER.md / MEMORY.md (CuratedMemoryService): views of
 * memory_items. A block cut by the kit truncation (no end marker) is dropped to the end.
 */
const GENERATED_MEMORY_BLOCKS: Array<[string, string]> = [
  ["<!-- cowork:auto:curated-user:start -->", "<!-- cowork:auto:curated-user:end -->"],
  ["<!-- cowork:auto:curated-workspace:start -->", "<!-- cowork:auto:curated-workspace:end -->"],
];

function stripGeneratedMemoryBlocks(markdown: string): string {
  let out = markdown;
  for (const [start, end] of GENERATED_MEMORY_BLOCKS) {
    const startAt = out.indexOf(start);
    if (startAt === -1) continue;
    const endAt = out.indexOf(end, startAt);
    out =
      endAt === -1
        ? out.slice(0, startAt)
        : `${out.slice(0, startAt)}${out.slice(endAt + end.length).replace(/^\n/, "")}`;
  }
  return out.trim();
}

function formatWorkspaceKitBody(
  body: string,
  contract: KitContract,
  excludeGeneratedMemoryBlocks = false,
): string {
  const withoutLore =
    contract.file === "LORE.md" ? stripMarkedBlock(body, AUTO_LORE_START, AUTO_LORE_END) : body;
  const normalizedBody =
    excludeGeneratedMemoryBlocks && (contract.file === "USER.md" || contract.file === "MEMORY.md")
      ? stripGeneratedMemoryBlocks(withoutLore)
      : withoutLore;
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

export function isDesignSystemRelevantTask(taskPrompt: string): boolean {
  const text = String(taskPrompt || "").toLowerCase();
  if (!text.trim()) return false;
  if (/\bdesign\.md\b/i.test(taskPrompt)) return true;
  return /\b(ui|ux|frontend|front-end|web\s*app|webapp|website|landing\s*page|dashboard|design\s*system|design\s*tokens?|theme|theming|css|scss|tailwind|styled|styles?|layout|typography|palette|colors?|component|button|modal|sidebar|navbar|page|responsive|mobile|visual\s+design)\b/.test(
    text,
  );
}

export function buildWorkspaceDesignSystemContext(
  workspacePath: string,
  taskPrompt: string,
  readGuard?: MarkdownMemoryReadGuard,
): string {
  if (!isDesignSystemRelevantTask(taskPrompt)) return "";

  for (const relPath of DESIGN_SYSTEM_FILES) {
    const absPath = safeResolveWithinWorkspace(workspacePath, relPath);
    if (!absPath) continue;
    const raw = readFilePrefix(absPath, MAX_FILE_BYTES, readGuard);
    if (!raw) continue;

    const contract =
      relPath === ".cowork/DESIGN.md" ? WORKSPACE_KIT_CONTRACTS["DESIGN.md"] : undefined;
    const parsed = contract ? parseKitDocument(absPath, contract, relPath) : null;
    const source = parsed?.body || raw;
    const content = sanitizeForInjection(clampSection(source, MAX_DESIGN_CONTEXT_CHARS));
    if (!content) continue;

    return [
      `### Workspace Design System (${relPath})`,
      content,
      "",
      "Design-system behavior:",
      "- Treat this document as the source of truth for UI/frontend visual decisions.",
      "- Preserve its colors, typography, spacing, radii, component semantics, and motion constraints unless the user explicitly asks for a redesign.",
      "- Map new UI values back to the closest existing token instead of inventing one-off values.",
    ].join("\n");
  }

  return [
    "### Workspace Design System (not found)",
    "This task appears to involve UI/frontend/design work, but no DESIGN.md was found at .cowork/DESIGN.md, DESIGN.md, docs/DESIGN.md, or design/DESIGN.md.",
    "",
    "Design-system behavior:",
    "- Before changing UI, inspect existing styles, CSS variables, theme files, and nearby components to infer the current design system.",
    "- If the task creates or materially changes the visual system, create or update .cowork/DESIGN.md with tokens and design principles as part of the work.",
    "- Do not invent disconnected colors, typography, spacing, or component treatments when existing UI patterns are discoverable.",
  ].join("\n");
}

function buildMapSections(
  workspacePath: string,
  readGuard?: MarkdownMemoryReadGuard,
): ExtractedSection[] {
  const sections: ExtractedSection[] = [];

  for (const file of MAP_FILES) {
    const absPath = safeResolveWithinWorkspace(workspacePath, file.relPath);
    if (!absPath) continue;
    const raw = readFilePrefix(absPath, MAX_FILE_BYTES, readGuard);
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
  readGuard?: MarkdownMemoryReadGuard,
): string {
  const absPath = safeResolveWithinWorkspace(workspacePath, relPath);
  if (!absPath) return "";
  if (!canReadPath(readGuard, absPath)) return "";
  const parsed = parseKitDocument(absPath, contract, relPath.replace(/\\/g, "/"));
  if (!parsed) return "";
  const body = formatter ? formatter(parsed.body) : parsed.body;
  return body.trim();
}

function buildProjectContextSections(
  workspacePath: string,
  taskPrompt: string,
  agentRoleId: string | null,
  readGuard?: MarkdownMemoryReadGuard,
): ExtractedSection[] {
  const sections: ExtractedSection[] = [];

  const projectsDirRel = path.join(KIT_DIRNAME, "projects");
  const projectsDirAbs = safeResolveWithinWorkspace(workspacePath, projectsDirRel);
  if (!projectsDirAbs) return sections;
  if (!canReadPath(readGuard, projectsDirAbs)) return sections;

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

      const raw = readFilePrefix(contextAbs, MAX_FILE_BYTES, readGuard);
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
    const accessRaw = accessAbs
      ? readFilePrefix(accessAbs, Math.min(MAX_FILE_BYTES, 24 * 1024), readGuard)
      : null;
    if (accessRaw && agentRoleId) {
      const res = checkProjectAccessFromMarkdown({ markdown: accessRaw, agentRoleId });
      if (!res.allowed) continue;
    }

    const accessText = accessContract
      ? renderProjectDoc(
          workspacePath,
          candidate.accessRel,
          accessContract,
          (body) => clampSection(body, 2000),
          readGuard,
        )
      : "";
    const contextText = contextContract
      ? renderProjectDoc(
          workspacePath,
          candidate.contextRel,
          contextContract,
          (body) => clampSection(body, MAX_SECTION_CHARS),
          readGuard,
        )
      : "";

    const combined = [
      accessText ? `#### Access (${candidate.accessRel.replace(/\\/g, "/")})\n${accessText}` : "",
      contextText
        ? `#### Context (${candidate.contextRel.replace(/\\/g, "/")})\n${contextText}`
        : "",
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

function buildDailyLogSection(
  workspacePath: string,
  now: Date,
  readGuard?: MarkdownMemoryReadGuard,
): ExtractedSection[] {
  const stamp = getLocalDateStamp(now);
  const relPath = path.join(KIT_DIRNAME, "memory", `${stamp}.md`);
  const absPath = safeResolveWithinWorkspace(workspacePath, relPath);
  if (!absPath) return [];

  const raw = readFilePrefix(absPath, MAX_FILE_BYTES, readGuard);
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
  includeDesignSystem: boolean,
  readGuard?: MarkdownMemoryReadGuard,
  excludeGeneratedMemoryBlocks = false,
  excludeFiles: ReadonlySet<string> = new Set(),
): ExtractedSection[] {
  return buildWorkspaceKitSections({
    workspacePath,
    scopes,
    onboardingIncomplete,
    readGuard,
  })
    .filter((section) => includeDesignSystem || section.file !== "DESIGN.md")
    .filter((section) => !excludeFiles.has(section.file))
    .map((section) => ({
      title: section.title,
      relPath: section.relPath,
      content: formatWorkspaceKitBody(
        section.parsed.body,
        section.contract,
        excludeGeneratedMemoryBlocks,
      ),
      maxChars: Math.max(MAX_SECTION_CHARS, section.contract.maxChars),
    }))
    .filter((section) => !excludeGeneratedMemoryBlocks || section.content.trim().length > 0);
}

export function buildProjectInstructionsSection(
  workspacePath: string,
  readGuard?: MarkdownMemoryReadGuard,
): string {
  for (const file of PROJECT_INSTRUCTION_FILES) {
    const absPath = safeResolveWithinWorkspace(workspacePath, file);
    if (!absPath) continue;
    const raw = readFilePrefix(absPath, MAX_FILE_BYTES, readGuard);
    if (!raw?.trim()) continue;
    const content = sanitizeForInjection(clampSection(raw, MAX_PROJECT_INSTRUCTIONS_CHARS));
    if (!content) continue;
    return `### Project Instructions (${file})\n${content}\n`;
  }
  return "";
}

/**
 * Kit files that carry durable memory and workspace rules. Within a token-limited
 * slice they come before everything else, so `.cowork/USER.md` and `MEMORY.md`
 * are not crowded out by long repo docs (PROMPT-2).
 */
const MEMORY_PRIORITY_KIT_FILES = [
  "USER.md",
  "MEMORY.md",
  "RULES.md",
  "AGENTS.md",
  "IDENTITY.md",
] as const;

function memoryPriorityRank(section: ExtractedSection): number {
  const rel = section.relPath.replace(/\\/g, "/");
  if (!rel.startsWith(`${KIT_DIRNAME}/`)) return MEMORY_PRIORITY_KIT_FILES.length;
  const file = rel.slice(KIT_DIRNAME.length + 1);
  const index = (MEMORY_PRIORITY_KIT_FILES as readonly string[]).indexOf(file);
  return index === -1 ? MEMORY_PRIORITY_KIT_FILES.length : index;
}

function prioritizeMemoryKitSections(sections: ExtractedSection[]): ExtractedSection[] {
  return sections
    .map((section, index) => ({ section, index, rank: memoryPriorityRank(section) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.section);
}

function renderSectionBlock(section: ExtractedSection): string {
  const header = `### ${section.title} (${section.relPath})`;
  const body = clampSection(section.content, section.maxChars ?? MAX_SECTION_CHARS);
  return `${header}\n${body}\n`;
}

function renderSectionsWithinTotal(sections: ExtractedSection[], maxTotalChars: number): string[] {
  const parts: string[] = [];
  let totalChars = 0;
  for (const section of sections) {
    const block = renderSectionBlock(section);
    if (totalChars + block.length > maxTotalChars) {
      const remaining = Math.max(0, maxTotalChars - totalChars);
      if (remaining > 200) {
        parts.push(block.slice(0, remaining) + "\n[... truncated ...]");
      }
      break;
    }
    parts.push(block);
    totalChars += block.length;
  }
  return parts;
}

function collectKitMemorySections(
  workspacePath: string,
  taskPrompt: string,
  now: Date,
  agentRoleId: string | null,
  readGuard?: MarkdownMemoryReadGuard,
  options: {
    includeDesignSystem?: boolean;
    excludeGeneratedMemoryBlocks?: boolean;
    excludeFiles?: readonly string[];
  } = {},
): ExtractedSection[] {
  const collected: ExtractedSection[] = [];
  const includeDesignSystem = options.includeDesignSystem ?? isDesignSystemRelevantTask(taskPrompt);
  const kitDir = safeResolveWithinWorkspace(workspacePath, KIT_DIRNAME);
  if (!kitDir) return collected;
  try {
    if (
      canReadPath(readGuard, kitDir) &&
      fs.existsSync(kitDir) &&
      fs.statSync(kitDir).isDirectory()
    ) {
      collected.push(
        ...prioritizeMemoryKitSections(
          buildScopedKitSections(
            workspacePath,
            ["task", "company-ops"],
            false,
            includeDesignSystem,
            readGuard,
            options.excludeGeneratedMemoryBlocks === true,
            new Set(options.excludeFiles ?? []),
          ),
        ),
      );
      collected.push(
        ...buildProjectContextSections(workspacePath, taskPrompt, agentRoleId, readGuard),
      );
      collected.push(...buildDailyLogSection(workspacePath, now, readGuard));
    }
  } catch {
    // ignore
  }
  return collected;
}

/**
 * Repo-level project guidance: root AGENTS.md / CLAUDE.md and docs map files.
 * The execution prompt gives this its own budgeted section, separate from the
 * memory slice.
 */
export function buildProjectGuidanceContext(
  workspacePath: string,
  readGuard?: MarkdownMemoryReadGuard,
): string {
  const projectInstructions = buildProjectInstructionsSection(workspacePath, readGuard);
  const maps = renderSectionsWithinTotal(
    buildMapSections(workspacePath, readGuard),
    MAX_TOTAL_CHARS,
  );
  return [projectInstructions, ...maps].filter(Boolean).join("\n").trim();
}

export function buildWorkspaceKitContext(
  workspacePath: string,
  taskPrompt: string,
  now: Date = new Date(),
  opts?: {
    agentRoleId?: string | null;
    readGuard?: MarkdownMemoryReadGuard;
    /**
     * Include repo-root project instructions and docs map files (default true).
     * The step memory slice passes false: those files get their own prompt section.
     */
    includeProjectGuidance?: boolean;
    /**
     * Include `.cowork/DESIGN.md` (default: when the task looks like UI work). Pass false
     * when the caller injects the design system in its own section.
     */
    includeDesignSystem?: boolean;
    /** Drop the generated curated auto-blocks of USER.md / MEMORY.md (memory_items views). */
    excludeGeneratedMemoryBlocks?: boolean;
    /** Kit files another prompt section already carries (for example the shared context). */
    excludeFiles?: readonly string[];
  },
): string {
  const agentRoleId = typeof opts?.agentRoleId === "string" ? opts.agentRoleId : null;
  const includeProjectGuidance = opts?.includeProjectGuidance !== false;
  const kitSections = collectKitMemorySections(
    workspacePath,
    taskPrompt,
    now,
    agentRoleId,
    opts?.readGuard,
    {
      includeDesignSystem: opts?.includeDesignSystem,
      excludeGeneratedMemoryBlocks: opts?.excludeGeneratedMemoryBlocks,
      excludeFiles: opts?.excludeFiles,
    },
  );
  const mapSections = includeProjectGuidance
    ? buildMapSections(workspacePath, opts?.readGuard)
    : [];
  const projectInstructions = includeProjectGuidance
    ? buildProjectInstructionsSection(workspacePath, opts?.readGuard)
    : "";

  // Order: memory/rules kit files first, then the repo's own instructions (kept
  // outside the total cap, as before), then the remaining kit context and the
  // docs maps, which are the most expendable.
  const prioritySections = kitSections.filter(
    (section) => memoryPriorityRank(section) < MEMORY_PRIORITY_KIT_FILES.length,
  );
  const otherSections = kitSections.filter(
    (section) => memoryPriorityRank(section) >= MEMORY_PRIORITY_KIT_FILES.length,
  );
  const collected = [...prioritySections, ...otherSections, ...mapSections];
  if (collected.length === 0) return projectInstructions.trim();

  const rendered = renderSectionsWithinTotal(collected, MAX_TOTAL_CHARS);
  const priorityCount = Math.min(prioritySections.length, rendered.length);
  const parts = [
    ...rendered.slice(0, priorityCount),
    ...(projectInstructions ? [projectInstructions] : []),
    ...rendered.slice(priorityCount),
  ];
  return parts.join("\n").trim();
}
