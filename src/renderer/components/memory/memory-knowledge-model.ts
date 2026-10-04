/**
 * Memory Hub "What CoWork knows": grouping, labels and the IPC flows behind the tab.
 * Kept free of React so the flows can be tested with a mocked API.
 */
import type {
  MemoryHubAddableKind,
  MemoryHubItem,
  MemoryHubKind,
  MemoryHubListRequest,
  MemoryHubListResult,
  MemoryHubMutationResult,
  MemoryHubSource,
  MemoryHubWhy,
} from "../../../shared/memory-hub-types";

export type MemoryKnowledgeApi = {
  listMemoryItems: (data: MemoryHubListRequest) => Promise<MemoryHubListResult>;
  addMemoryItem: (data: {
    workspaceId: string;
    content: string;
    kind: MemoryHubAddableKind;
    scope: "global" | "workspace";
    pinned?: boolean;
  }) => Promise<MemoryHubMutationResult>;
  updateMemoryItem: (data: {
    workspaceId: string;
    id: string;
    content: string;
  }) => Promise<MemoryHubMutationResult>;
  setMemoryItemPinned: (data: {
    workspaceId: string;
    id: string;
    pinned: boolean;
  }) => Promise<MemoryHubMutationResult>;
  deleteMemoryItem: (data: { workspaceId: string; id: string }) => Promise<MemoryHubMutationResult>;
  getMemoryItemWhy: (data: { workspaceId: string; id: string }) => Promise<MemoryHubWhy>;
  clearGlobalMemoryItems: (data: {
    workspaceId: string;
    confirm: true;
  }) => Promise<{ success: boolean; deleted: number }>;
};

export const MEMORY_KNOWLEDGE_PAGE_SIZE = 100;

export interface KnowledgeGroup {
  id: string;
  title: string;
  kinds: MemoryHubKind[];
  items: MemoryHubItem[];
}

const GROUPS: Array<Omit<KnowledgeGroup, "items">> = [
  { id: "identity", title: "Identity", kinds: ["identity"] },
  { id: "preferences", title: "Preferences", kinds: ["preference"] },
  { id: "rules", title: "Rules", kinds: ["rule"] },
  { id: "project_facts", title: "Project facts", kinds: ["project_fact"] },
  { id: "commitments", title: "Commitments", kinds: ["commitment"] },
  { id: "corrections", title: "Corrections", kinds: ["correction"] },
  { id: "decisions", title: "Decisions and insights", kinds: ["decision", "insight", "outcome"] },
];

export const KIND_LABELS: Record<MemoryHubKind, string> = {
  identity: "Identity",
  preference: "Preference",
  rule: "Rule",
  project_fact: "Project fact",
  commitment: "Commitment",
  correction: "Correction",
  decision: "Decision",
  insight: "Insight",
  outcome: "Outcome",
};

export const SOURCE_LABELS: Record<MemoryHubSource, string> = {
  user_stated: "You said",
  user_confirmed: "You confirmed",
  curated: "Curated",
  inferred: "Inferred",
  third_party: "Third-party",
  import: "Imported",
  system: "Inferred",
};

export type SourceTone = "success" | "neutral" | "warning";

export function sourceTone(source: MemoryHubSource): SourceTone {
  if (source === "user_stated" || source === "user_confirmed") return "success";
  if (source === "third_party") return "warning";
  return "neutral";
}

export function scopeLabel(item: Pick<MemoryHubItem, "scope">): string {
  switch (item.scope) {
    case "global":
      return "Global";
    case "workspace":
      return "This workspace";
    case "contact":
      return "Contact";
    case "task":
      return "Task";
    default:
      return item.scope;
  }
}

/** Text written by or about other people (mail, contacts): kept apart from facts about you. */
export function isFromOtherPeople(item: Pick<MemoryHubItem, "scope" | "source">): boolean {
  return item.scope === "contact" || item.source === "third_party";
}

export function groupKnowledge(items: MemoryHubItem[]): {
  groups: KnowledgeGroup[];
  fromOthers: MemoryHubItem[];
} {
  const fromOthers: MemoryHubItem[] = [];
  const groups = GROUPS.map((group) => ({ ...group, items: [] as MemoryHubItem[] }));
  for (const item of items) {
    if (isFromOtherPeople(item)) {
      fromOthers.push(item);
      continue;
    }
    const group =
      groups.find((entry) => entry.kinds.includes(item.kind)) ?? groups[groups.length - 1];
    group.items.push(item);
  }
  return { groups: groups.filter((group) => group.items.length > 0), fromOthers };
}

export function formatRelative(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return "never";
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface KnowledgeFlowResult {
  items: MemoryHubItem[];
  error?: string;
  notice?: string;
  cancelled?: boolean;
}

/** Edit: the new revision replaces the edited item in place. */
export async function editKnowledgeItem(
  api: MemoryKnowledgeApi,
  workspaceId: string,
  items: MemoryHubItem[],
  id: string,
  content: string,
): Promise<KnowledgeFlowResult> {
  const text = content.trim();
  if (!text) return { items, error: "A memory cannot be empty." };
  try {
    const result = await api.updateMemoryItem({ workspaceId, id, content: text });
    if (!result.success) return { items, error: result.error };
    const next = result.item;
    if (!next) return { items: items.filter((item) => item.id !== id), notice: "Memory updated." };
    const withoutDuplicate = items.filter((item) => item.id === id || item.id !== next.id);
    return {
      items: withoutDuplicate.map((item) => (item.id === id ? next : item)),
      notice: "Memory updated.",
    };
  } catch (error) {
    return { items, error: errorMessage(error, "Failed to update the memory.") };
  }
}

export async function toggleKnowledgePin(
  api: MemoryKnowledgeApi,
  workspaceId: string,
  items: MemoryHubItem[],
  item: MemoryHubItem,
): Promise<KnowledgeFlowResult> {
  try {
    const result = await api.setMemoryItemPinned({
      workspaceId,
      id: item.id,
      pinned: !item.pinned,
    });
    if (!result.success) return { items, error: result.error };
    const updated = result.item ?? { ...item, pinned: !item.pinned };
    return {
      items: items.map((entry) => (entry.id === item.id ? updated : entry)),
      notice: updated.pinned ? "Memory pinned." : "Memory unpinned.",
    };
  } catch (error) {
    return { items, error: errorMessage(error, "Failed to update the pin.") };
  }
}

export async function deleteKnowledgeItem(
  api: MemoryKnowledgeApi,
  workspaceId: string,
  items: MemoryHubItem[],
  item: MemoryHubItem,
  confirm: (message: string) => boolean,
): Promise<KnowledgeFlowResult> {
  if (
    !confirm(
      "Forget this memory? CoWork stops using it right away, and its earlier versions are erased too.",
    )
  ) {
    return { items, cancelled: true };
  }
  try {
    const result = await api.deleteMemoryItem({ workspaceId, id: item.id });
    if (!result.success) return { items, error: result.error };
    return { items: items.filter((entry) => entry.id !== item.id), notice: "Memory forgotten." };
  } catch (error) {
    return { items, error: errorMessage(error, "Failed to forget the memory.") };
  }
}

export async function addKnowledgeItem(
  api: MemoryKnowledgeApi,
  workspaceId: string,
  items: MemoryHubItem[],
  draft: { content: string; kind: MemoryHubAddableKind; scope: "global" | "workspace" },
): Promise<KnowledgeFlowResult> {
  const content = draft.content.trim();
  if (!content) return { items, error: "Type what CoWork should remember." };
  try {
    const result = await api.addMemoryItem({ workspaceId, ...draft, content });
    if (!result.success) return { items, error: result.error };
    const added = result.item;
    if (!added) return { items };
    return {
      items: [added, ...items.filter((item) => item.id !== added.id)],
      notice: result.action === "reinforced" ? "CoWork already knew that." : "Memory added.",
    };
  } catch (error) {
    return { items, error: errorMessage(error, "Failed to add the memory.") };
  }
}

export async function clearGlobalKnowledge(
  api: MemoryKnowledgeApi,
  workspaceId: string,
  items: MemoryHubItem[],
  confirm: (message: string) => boolean,
): Promise<KnowledgeFlowResult> {
  const count = items.filter((item) => item.scope === "global").length;
  if (
    !confirm(
      `Clear all global memories${count ? ` (${count} shown)` : ""}? Facts CoWork knows about you in every workspace are erased. This cannot be undone.`,
    )
  ) {
    return { items, cancelled: true };
  }
  try {
    const result = await api.clearGlobalMemoryItems({ workspaceId, confirm: true });
    return {
      items: items.filter((item) => item.scope !== "global"),
      notice: `Cleared ${result.deleted} global memor${result.deleted === 1 ? "y" : "ies"}.`,
    };
  } catch (error) {
    return { items, error: errorMessage(error, "Failed to clear global memories.") };
  }
}

/** Per-store counts from Clear All Memories, largest first, zero counts left out. */
export function describePurgeCounts(counts: Record<string, number> | undefined): string[] {
  if (!counts) return [];
  const labels: Record<string, string> = {
    memories: "archived memories",
    curatedEntries: "curated entries",
    durableContext: "durable context rows",
    knowledgeGraph: "knowledge graph rows",
    transcripts: "transcript records",
    topicFiles: "topic files",
    dailySummaries: "daily summaries",
    chronicleObservations: "Chronicle observations",
    dreaming: "dreaming records",
    coreMemoryCandidates: "core memory candidates",
    playbookEvidence: "playbook evidence rows",
    playbookEntries: "playbook entries",
    suggestions: "suggestions",
    memoryItems: "facts (What CoWork knows)",
    pendingMemoryWrites: "pending memory writes",
  };
  return Object.entries(counts)
    .filter(([, value]) => typeof value === "number" && value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${value} ${labels[key] ?? key}`);
}
