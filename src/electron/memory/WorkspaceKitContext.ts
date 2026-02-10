import fs from 'fs';
import path from 'path';
import { InputSanitizer } from '../agent/security';
import { checkProjectAccessFromMarkdown } from '../security/project-access';
import { redactSensitiveMarkdownContent } from './MarkdownMemoryIndexService';

type ExtractedSection = {
  title: string;
  relPath: string;
  content: string;
};

const KIT_DIRNAME = '.cowork';

// Hard caps to prevent blowing up system prompt tokens.
const MAX_FILE_BYTES = 96 * 1024;
const MAX_SECTION_CHARS = 6000;
const MAX_TOTAL_CHARS = 16000;

// Optional "map" files for faster codebase orientation. These are NOT part of the kit directory.
const MAP_FILES: Array<{ relPath: string; title: string }> = [
  { relPath: 'docs/CODEBASE_MAP.md', title: 'Codebase Map' },
  { relPath: 'docs/ARCHITECTURE.md', title: 'Architecture Notes' },
  { relPath: 'ARCHITECTURE.md', title: 'Architecture Notes (Root)' },
];

function getLocalDateStamp(now: Date): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
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
    const fd = fs.openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buf, 0, size, 0);
      return buf.toString('utf8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function extractFilledFieldLines(markdown: string, maxLines = 40): string {
  const lines = markdown.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    // Match "- Key: value" where value is non-empty (skip template placeholders like "- Name:")
    if (/^\s*-\s*[^:]{1,80}:\s*\S/.test(line)) {
      out.push(line.trimEnd());
      if (out.length >= maxLines) break;
    }
  }

  return out.join('\n').trim();
}

function extractBulletSections(
  markdown: string,
  opts?: { onlyHeadings?: Set<string>; maxBulletsPerSection?: number; maxSections?: number }
): string {
  const onlyHeadings = opts?.onlyHeadings;
  const maxBulletsPerSection = opts?.maxBulletsPerSection ?? 12;
  const maxSections = opts?.maxSections ?? 8;

  const lines = markdown.split('\n');
  const sections: Array<{ heading: string; bullets: string[] }> = [];

  let currentHeading = '';
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
      heading: currentHeading || 'Notes',
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
    rendered.push(section.bullets.join('\n'));
    rendered.push('');
  }
  return rendered.join('\n').trim();
}

function sanitizeForInjection(text: string): string {
  // Treat kit files as untrusted input. They can guide behavior, but must not
  // contain control tokens that enable instruction override.
  const redacted = redactSensitiveMarkdownContent(text || '');
  return InputSanitizer.sanitizeMemoryContent(redacted).trim();
}

function clampSection(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n[... truncated ...]';
}

function buildKitSections(workspacePath: string, taskPrompt: string, now: Date): ExtractedSection[] {
  // Note: taskPrompt is reserved for future relevance scoring; for now we keep extraction deterministic.
  void taskPrompt;

  const stamp = getLocalDateStamp(now);
  const files: Array<{
    relPath: string;
    title: string;
    extractor: (raw: string) => string;
  }> = [
    {
      relPath: path.join(KIT_DIRNAME, 'AGENTS.md'),
      title: 'Workspace Rules',
      extractor: (raw) => sanitizeForInjection(clampSection(raw, MAX_SECTION_CHARS)),
    },
    {
      relPath: path.join(KIT_DIRNAME, 'MEMORY.md'),
      title: 'Long-Term Memory',
      extractor: (raw) => sanitizeForInjection(extractBulletSections(raw, { maxSections: 12 })),
    },
    {
      relPath: path.join(KIT_DIRNAME, 'USER.md'),
      title: 'User Profile',
      extractor: (raw) => sanitizeForInjection(extractFilledFieldLines(raw)),
    },
    {
      relPath: path.join(KIT_DIRNAME, 'SOUL.md'),
      title: 'Assistant Style',
      // SOUL.md is intentionally free-form; inject the (sanitized) document rather than
      // only extracting filled "- Key: value" template lines.
      extractor: (raw) => sanitizeForInjection(clampSection(raw, MAX_SECTION_CHARS)),
    },
    {
      relPath: path.join(KIT_DIRNAME, 'IDENTITY.md'),
      title: 'Assistant Identity',
      extractor: (raw) => sanitizeForInjection(extractFilledFieldLines(raw)),
    },
    {
      relPath: path.join(KIT_DIRNAME, 'TOOLS.md'),
      title: 'Local Setup Notes',
      extractor: (raw) => sanitizeForInjection(extractBulletSections(raw, { maxSections: 8 })),
    },
    {
      relPath: path.join(KIT_DIRNAME, 'HEARTBEAT.md'),
      title: 'Recurring Checks',
      extractor: (raw) => sanitizeForInjection(extractBulletSections(raw, { maxSections: 10 })),
    },
    {
      relPath: path.join(KIT_DIRNAME, 'PRIORITIES.md'),
      title: 'Priorities',
      // Priorities are often numbered lists; keep the (sanitized) doc rather than only "- bullets".
      extractor: (raw) => sanitizeForInjection(clampSection(raw, MAX_SECTION_CHARS)),
    },
    {
      relPath: path.join(KIT_DIRNAME, 'CROSS_SIGNALS.md'),
      title: 'Cross-Agent Signals',
      extractor: (raw) => sanitizeForInjection(clampSection(raw, MAX_SECTION_CHARS)),
    },
    {
      relPath: path.join(KIT_DIRNAME, 'MISTAKES.md'),
      title: 'Mistakes / Preferences',
      extractor: (raw) => sanitizeForInjection(clampSection(raw, MAX_SECTION_CHARS)),
    },
    {
      relPath: path.join(KIT_DIRNAME, 'memory', `${stamp}.md`),
      title: `Daily Log (${stamp})`,
      extractor: (raw) =>
        sanitizeForInjection(
          extractBulletSections(raw, {
            onlyHeadings: new Set(['Open Loops', 'Next Actions', 'Decisions', 'Summary']),
            maxSections: 4,
          })
        ),
    },
  ];

  const sections: ExtractedSection[] = [];

  for (const file of files) {
    const absPath = safeResolveWithinWorkspace(workspacePath, file.relPath);
    if (!absPath) continue;
    const raw = readFilePrefix(absPath, MAX_FILE_BYTES);
    if (!raw) continue;
    const extracted = file.extractor(raw);
    if (!extracted) continue;
    sections.push({
      title: file.title,
      relPath: file.relPath.replace(/\\/g, '/'),
      content: extracted,
    });
  }

  return sections;
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
      relPath: file.relPath.replace(/\\/g, '/'),
      content: extracted,
    });
  }

  return sections;
}

function scoreTextOverlap(a: string, b: string): number {
  const tokensA = new Set((a.toLowerCase().match(/[a-z0-9]{3,}/g) || []).slice(0, 200));
  const tokensB = new Set((b.toLowerCase().match(/[a-z0-9]{3,}/g) || []).slice(0, 400));
  let score = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) score += 1;
  }
  return score;
}

function buildProjectContextSections(workspacePath: string, taskPrompt: string, agentRoleId: string | null): ExtractedSection[] {
  const sections: ExtractedSection[] = [];

  const projectsDirRel = path.join(KIT_DIRNAME, 'projects');
  const projectsDirAbs = safeResolveWithinWorkspace(workspacePath, projectsDirRel);
  if (!projectsDirAbs) return sections;

  try {
    if (!fs.existsSync(projectsDirAbs) || !fs.statSync(projectsDirAbs).isDirectory()) return sections;
  } catch {
    return sections;
  }

  type Candidate = { name: string; score: number; contextRel: string; accessRel: string };
  const candidates: Candidate[] = [];

  try {
    const dirents = fs.readdirSync(projectsDirAbs, { withFileTypes: true });
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const name = d.name;
      if (!name || name.startsWith('.')) continue;

      const contextRel = path.join(projectsDirRel, name, 'CONTEXT.md');
      const accessRel = path.join(projectsDirRel, name, 'ACCESS.md');

      const contextAbs = safeResolveWithinWorkspace(workspacePath, contextRel);
      if (!contextAbs) continue;
      const raw = readFilePrefix(contextAbs, MAX_FILE_BYTES);
      if (!raw) continue;

      // Prefer matches on directory name; fall back to content overlap.
      const nameScore = scoreTextOverlap(taskPrompt, name.replace(/[-_]/g, ' '));
      const contentScore = scoreTextOverlap(taskPrompt, raw.slice(0, 6000));
      const score = nameScore * 3 + contentScore;

      candidates.push({ name, score, contextRel, accessRel });
    }
  } catch {
    return sections;
  }

  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates.filter((c) => c.score > 0).slice(0, 2);
  if (selected.length === 0) return sections;

  for (const c of selected) {
    const contextAbs = safeResolveWithinWorkspace(workspacePath, c.contextRel);
    if (!contextAbs) continue;

    const accessAbs = safeResolveWithinWorkspace(workspacePath, c.accessRel);
    const accessRaw = accessAbs ? readFilePrefix(accessAbs, Math.min(MAX_FILE_BYTES, 24 * 1024)) : null;
    const accessText = accessRaw ? sanitizeForInjection(clampSection(accessRaw, 2000)) : '';

    if (accessRaw && agentRoleId) {
      const res = checkProjectAccessFromMarkdown({ markdown: accessRaw, agentRoleId });
      if (!res.allowed) continue;
    }

    const contextRaw = readFilePrefix(contextAbs, MAX_FILE_BYTES) || '';
    const contextText = sanitizeForInjection(clampSection(contextRaw, MAX_SECTION_CHARS));

    const combined = [
      accessText ? `#### Access (${c.accessRel.replace(/\\\\/g, '/')})\n${accessText}` : '',
      `#### Context (${c.contextRel.replace(/\\\\/g, '/')})\n${contextText}`,
    ]
      .filter(Boolean)
      .join('\n\n')
      .trim();

    if (!combined) continue;

    sections.push({
      title: `Project: ${c.name}`,
      relPath: c.contextRel.replace(/\\/g, '/'),
      content: combined,
    });
  }

  return sections;
}

/**
 * Build a concise workspace "context pack" from `.cowork/` files.
 * Intended for system prompt injection (sanitized and size-capped).
 */
export function buildWorkspaceKitContext(
  workspacePath: string,
  taskPrompt: string,
  now: Date = new Date(),
  opts?: { agentRoleId?: string | null }
): string {
  const collectedSections: ExtractedSection[] = [];
  const agentRoleId = typeof opts?.agentRoleId === 'string' ? opts?.agentRoleId : null;

  // Map files are independent of kit dir existence.
  collectedSections.push(...buildMapSections(workspacePath));

  const kitDir = safeResolveWithinWorkspace(workspacePath, KIT_DIRNAME);
  if (kitDir) {
    try {
      if (fs.existsSync(kitDir) && fs.statSync(kitDir).isDirectory()) {
        collectedSections.push(...buildKitSections(workspacePath, taskPrompt, now));
        collectedSections.push(...buildProjectContextSections(workspacePath, taskPrompt, agentRoleId));
      }
    } catch {
      // ignore
    }
  }

  const sections = collectedSections;
  if (sections.length === 0) return '';

  const parts: string[] = [];
  let totalChars = 0;

  for (const section of sections) {
    const header = `### ${section.title} (${section.relPath})`;
    const body = clampSection(section.content, MAX_SECTION_CHARS);
    const block = `${header}\n${body}\n`;

    if (totalChars + block.length > MAX_TOTAL_CHARS) {
      const remaining = Math.max(0, MAX_TOTAL_CHARS - totalChars);
      if (remaining > 200) {
        parts.push(block.slice(0, remaining) + '\n[... truncated ...]');
      }
      break;
    }

    parts.push(block);
    totalChars += block.length;
  }

  return parts.join('\n').trim();
}
