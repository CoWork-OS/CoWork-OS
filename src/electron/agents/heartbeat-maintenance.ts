import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import {
  buildWorkspaceKitSections,
  parseHeartbeatChecklist,
  renderHeartbeatPrompt,
} from "../context/kit-injection";
import { getUserDataDir } from "../utils/user-data-dir";

const KIT_DIRNAME = ".cowork";
const STATE_FILENAME = "heartbeat-maintenance-state.json";
const checklistCache = new Map<string, { revisionHash: string; items: HeartbeatChecklistItem[] }>();

export type HeartbeatChecklistCadence = "heartbeat" | "hourly" | "daily" | "weekly" | "monthly";

export interface HeartbeatChecklistItem {
  id: string;
  workspaceId?: string;
  title: string;
  sectionTitle: string;
  cadence: HeartbeatChecklistCadence;
  cadenceMs: number;
  sourcePath: string;
}

function getLocalDateStamp(now: Date): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function readTextFile(absPath: string, maxChars = 3000): string {
  try {
    if (!fs.existsSync(absPath)) return "";
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return "";
    const text = fs.readFileSync(absPath, "utf8").trim();
    if (!text) return "";
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[... truncated ...]`;
  } catch {
    return "";
  }
}

interface PersistedHeartbeatMaintenanceState {
  version: 1;
  checklistLastRunAt: Record<string, number>;
  proactiveLastRunAt: Record<string, number>;
}

const DEFAULT_STATE: PersistedHeartbeatMaintenanceState = {
  version: 1,
  checklistLastRunAt: {},
  proactiveLastRunAt: {},
};

function normalizeBullet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hashId(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function getCadence(sectionTitle: string): {
  cadence: HeartbeatChecklistCadence;
  cadenceMs: number;
} {
  const text = sectionTitle.trim().toLowerCase();
  if (/\b(hourly|hour|every hour)\b/.test(text)) {
    return { cadence: "hourly", cadenceMs: 60 * 60 * 1000 };
  }
  if (/\b(daily|day|every day)\b/.test(text)) {
    return { cadence: "daily", cadenceMs: 24 * 60 * 60 * 1000 };
  }
  if (/\b(weekly|week|every week)\b/.test(text)) {
    return { cadence: "weekly", cadenceMs: 7 * 24 * 60 * 60 * 1000 };
  }
  if (/\b(monthly|month|every month)\b/.test(text)) {
    return { cadence: "monthly", cadenceMs: 30 * 24 * 60 * 60 * 1000 };
  }
  return { cadence: "heartbeat", cadenceMs: 0 };
}

export function getHeartbeatChecklistPath(workspacePath?: string): string | undefined {
  const root = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!root) return undefined;
  return path.join(root, KIT_DIRNAME, "HEARTBEAT.md");
}

export function readHeartbeatChecklist(
  workspacePath?: string,
  workspaceId?: string,
): HeartbeatChecklistItem[] {
  const root = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!root) return [];
  const sourcePath =
    getHeartbeatChecklistPath(root) || path.join(root, KIT_DIRNAME, "HEARTBEAT.md");
  const rawText = readTextFile(sourcePath, Number.MAX_SAFE_INTEGER);
  const revisionHash = rawText ? createHash("sha1").update(rawText).digest("hex") : "";
  const cached = checklistCache.get(root);
  if (cached && cached.revisionHash === revisionHash) {
    return cached.items.map((item) => ({ ...item, workspaceId }));
  }

  const heartbeatSection = buildWorkspaceKitSections({
    workspacePath: root,
    scopes: ["heartbeat"],
  }).find((section) => section.file === "HEARTBEAT.md");
  if (!heartbeatSection) return [];
  const tasks = parseHeartbeatChecklist(heartbeatSection.parsed.body);
  const items = tasks.map((task) => {
    const sectionTitle = task.cadence || "Heartbeat";
    const normalizedTitle = normalizeBullet(task.check);
    const { cadence, cadenceMs } = getCadence(sectionTitle);
    return {
      id: hashId(`${sectionTitle}\n${normalizedTitle}`),
      workspaceId,
      title: normalizedTitle,
      sectionTitle,
      cadence,
      cadenceMs,
      sourcePath,
    };
  });
  checklistCache.set(root, {
    revisionHash,
    items: items.map((item) => ({ ...item, workspaceId: undefined })),
  });
  return items.map((item) => ({ ...item, workspaceId }));
}

export function buildHeartbeatWorkspaceContext(workspacePath?: string, now = new Date()): string {
  const root = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!root) return "";

  const kitRoot = path.join(root, KIT_DIRNAME);
  const sections: string[] = [];
  const pushSection = (title: string, relPath: string, maxChars = 2200) => {
    const text = readTextFile(path.join(kitRoot, relPath), maxChars);
    if (!text) return;
    sections.push(`### ${title}\n${text}`);
  };

  const heartbeatItems = readHeartbeatChecklist(root);
  const heartbeatPrompt = renderHeartbeatPrompt(
    heartbeatItems.map((item) => ({
      check: item.title,
      cadence: item.sectionTitle,
      action: "propose",
    })),
  );
  if (heartbeatPrompt) {
    sections.push(`### Heartbeat Contract\n${heartbeatPrompt}`);
  }

  pushSection("Priorities", "PRIORITIES.md");
  pushSection("Company Profile", "COMPANY.md");
  pushSection("Operating System", "OPERATIONS.md");
  pushSection("KPIs", "KPIS.md");
  pushSection("User Profile", "USER.md", 1400);
  pushSection("Long-Term Memory", "MEMORY.md", 1800);
  pushSection("Today's Log", path.join("memory", `${getLocalDateStamp(now)}.md`), 1800);

  if (sections.length === 0) return "";
  return sections.join("\n\n");
}

export class HeartbeatMaintenanceStateStore {
  private state: PersistedHeartbeatMaintenanceState = { ...DEFAULT_STATE };
  private loaded = false;

  private get filePath(): string {
    return path.join(getUserDataDir(), STATE_FILENAME);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedHeartbeatMaintenanceState>;
      this.state = {
        version: 1,
        checklistLastRunAt: parsed.checklistLastRunAt || {},
        proactiveLastRunAt: parsed.proactiveLastRunAt || {},
      };
    } catch {
      this.state = { ...DEFAULT_STATE };
    }
  }

  private save(): void {
    this.ensureLoaded();
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2) + "\n", "utf8");
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // Best-effort persistence only.
    }
  }

  getChecklistLastRunAt(key: string): number {
    this.ensureLoaded();
    const value = this.state.checklistLastRunAt[key];
    return typeof value === "number" ? value : 0;
  }

  setChecklistLastRunAt(key: string, timestamp: number): void {
    this.ensureLoaded();
    this.state.checklistLastRunAt[key] = timestamp;
    this.save();
  }

  getProactiveLastRunAt(key: string): number {
    this.ensureLoaded();
    const value = this.state.proactiveLastRunAt[key];
    return typeof value === "number" ? value : 0;
  }

  setProactiveLastRunAt(key: string, timestamp: number): void {
    this.ensureLoaded();
    this.state.proactiveLastRunAt[key] = timestamp;
    this.save();
  }

  clearAgent(agentRoleId: string): void {
    this.ensureLoaded();
    const prefix = `${agentRoleId}:`;
    for (const key of Object.keys(this.state.checklistLastRunAt)) {
      if (key.startsWith(prefix)) delete this.state.checklistLastRunAt[key];
    }
    for (const key of Object.keys(this.state.proactiveLastRunAt)) {
      if (key.startsWith(prefix)) delete this.state.proactiveLastRunAt[key];
    }
    this.save();
  }
}
