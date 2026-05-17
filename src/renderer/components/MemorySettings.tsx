import { useState, useEffect, useCallback } from "react";
import { ChatGPTImportWizard } from "./ChatGPTImportWizard";
import { PromptMemoryImportWizard } from "./PromptMemoryImportWizard";

// Types inlined since preload types aren't directly importable in renderer
type PrivacyMode = "normal" | "strict" | "disabled";

interface MemorySettingsData {
  workspaceId: string;
  enabled: boolean;
  autoCapture: boolean;
  compressionEnabled: boolean;
  retentionDays: number;
  maxStorageMb: number;
  privacyMode: PrivacyMode;
  excludedPatterns?: string[];
}

interface MemoryStats {
  count: number;
  totalTokens: number;
  compressedCount: number;
  compressionRatio: number;
}

interface ImportedStats {
  count: number;
  totalTokens: number;
}

type UserFactCategory =
  | "identity"
  | "preference"
  | "bio"
  | "work"
  | "goal"
  | "operating"
  | "voice"
  | "accountability"
  | "constraint"
  | "other";

interface UserFact {
  id: string;
  category: UserFactCategory;
  value: string;
  confidence: number;
  source: "conversation" | "feedback" | "manual";
  pinned?: boolean;
  firstSeenAt: number;
  lastUpdatedAt: number;
  lastTaskId?: string;
}

interface UserProfile {
  summary?: string;
  facts: UserFact[];
  updatedAt: number;
}

type RelationshipLayer = "identity" | "preferences" | "context" | "history" | "commitments";

interface RelationshipMemoryItem {
  id: string;
  layer: RelationshipLayer;
  text: string;
  confidence: number;
  source: "conversation" | "feedback" | "task";
  createdAt: number;
  updatedAt: number;
  status?: "open" | "done";
  dueAt?: number;
}

interface MemoryItem {
  id: string;
  content: string;
  tokens: number;
  createdAt: number;
  type?: string;
}

interface ChronicleObservationItem {
  id: string;
  appName: string;
  windowTitle: string;
  localTextSnippet?: string;
  capturedAt: number;
  destinationHints?: string[];
  memoryId?: string;
}

interface MemorySettingsProps {
  workspaceId: string;
  onSettingsChanged?: () => void;
}

interface ToggleRowProps {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** Parse imported-memory tags from memory content */
function parseImportTag(content: string): {
  title: string;
  preview: string;
  ignoredForPromptRecall: boolean;
  isImported: boolean;
} {
  const ignoredForPromptRecall = /^\s*\[cowork:prompt_recall=ignore\]/.test(content);
  const normalizedContent = content.replace(/^\s*\[cowork:prompt_recall=ignore\]\s*(?:\r?\n)?/, "");

  const match = normalizedContent.match(
    /^\[Imported from\s+(.+?)\s*[-—]\s*"(.+?)"\s*(?:\([^)]+\))?\]\n?([\s\S]*)/,
  );
  if (match) {
    return {
      title: `${match[1]}: ${match[2]}`,
      preview: match[3].slice(0, 200),
      ignoredForPromptRecall,
      isImported: true,
    };
  }
  const fallback = normalizedContent.match(/^\[Imported from\s+([^\]]+)\]\n?([\s\S]*)/);
  if (fallback) {
    return {
      title: `Imported from ${fallback[1]}`,
      preview: (fallback[2] || "").slice(0, 200),
      ignoredForPromptRecall,
      isImported: true,
    };
  }
  return {
    title: "Memory",
    preview: normalizedContent.slice(0, 200),
    ignoredForPromptRecall,
    isImported: false,
  };
}

function formatRelativeTime(timestamp: number): string {
  const deltaMs = Date.now() - timestamp;
  const minutes = Math.floor(deltaMs / (60 * 1000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days} day${days === 1 ? "" : "s"} ago`;
}

function formatMemoryTypeLabel(type?: string): string {
  if (!type) return "Memory";
  if (type === "screen_context") return "Screen context";
  return `${type.charAt(0).toUpperCase()}${type.slice(1).replace(/_/g, " ")}`;
}

function ToggleRow({ title, description, checked, onChange, disabled }: ToggleRowProps) {
  return (
    <div className="settings-form-group">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "12px",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>{title}</div>
          <p className="settings-form-hint" style={{ marginTop: "4px", marginBottom: 0 }}>
            {description}
          </p>
        </div>
        <label className="settings-toggle" style={{ flexShrink: 0, marginTop: "2px" }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
          />
          <span className="toggle-slider" />
        </label>
      </div>
    </div>
  );
}

const PAGE_SIZE = 20;

export function MemorySettings({ workspaceId, onSettingsChanged }: MemorySettingsProps) {
  const [settings, setSettings] = useState<MemorySettingsData | null>(null);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [showPromptImportWizard, setShowPromptImportWizard] = useState(false);
  const [showManageMemories, setShowManageMemories] = useState(false);

  // Imported memories state
  const [importedStats, setImportedStats] = useState<ImportedStats | null>(null);
  const [showImported, setShowImported] = useState(false);
  const [importedMemories, setImportedMemories] = useState<MemoryItem[]>([]);
  const [importedOffset, setImportedOffset] = useState(0);
  const [importedHasMore, setImportedHasMore] = useState(false);
  const [loadingImported, setLoadingImported] = useState(false);
  const [deletingImported, setDeletingImported] = useState(false);
  const [deletingImportedEntryId, setDeletingImportedEntryId] = useState<string | null>(null);
  const [updatingImportedEntryId, setUpdatingImportedEntryId] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [newFact, setNewFact] = useState("");
  const [newFactCategory, setNewFactCategory] = useState<UserFactCategory>("preference");
  const [savingFact, setSavingFact] = useState(false);
  const [relationshipItems, setRelationshipItems] = useState<RelationshipMemoryItem[]>([]);
  const [dueSoonItems, setDueSoonItems] = useState<RelationshipMemoryItem[]>([]);
  const [dueSoonReminder, setDueSoonReminder] = useState("");
  const [cleaningRecurringHistory, setCleaningRecurringHistory] = useState(false);
  const [recurringCleanupMessage, setRecurringCleanupMessage] = useState("");
  const [recentMemories, setRecentMemories] = useState<MemoryItem[]>([]);
  const [chronicleObservations, setChronicleObservations] = useState<ChronicleObservationItem[]>([]);
  const [memorySearchQuery, setMemorySearchQuery] = useState("");
  const [memorySearchResults, setMemorySearchResults] = useState<MemoryItem[]>([]);
  const [searchingMemories, setSearchingMemories] = useState(false);
  const [clearingChronicle, setClearingChronicle] = useState(false);
  const [deletingChronicleId, setDeletingChronicleId] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceId) {
      loadData();
    }
  }, [workspaceId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [
        loadedSettings,
        loadedStats,
        loadedImportedStats,
        loadedUserProfile,
        loadedRelationshipItems,
        loadedDueSoon,
        loadedRecentMemories,
        loadedChronicleObservations,
      ] = await Promise.all([
        window.electronAPI.getMemorySettings(workspaceId),
        window.electronAPI.getMemoryStats(workspaceId),
        window.electronAPI.getImportedMemoryStats(workspaceId),
        window.electronAPI.getUserProfile(),
        window.electronAPI.listRelationshipMemory({ limit: 80, includeDone: false }),
        window.electronAPI.getDueSoonCommitments(72),
        window.electronAPI.getRecentMemories({ workspaceId, limit: 20 }),
        window.electronAPI.listChronicleObservations({ workspaceId, limit: 50 }),
      ]);
      setSettings(loadedSettings);
      setStats(loadedStats);
      setImportedStats(loadedImportedStats);
      setUserProfile(loadedUserProfile);
      setRelationshipItems(Array.isArray(loadedRelationshipItems) ? loadedRelationshipItems : []);
      setDueSoonItems(Array.isArray(loadedDueSoon?.items) ? loadedDueSoon.items : []);
      setDueSoonReminder(
        typeof loadedDueSoon?.reminderText === "string" ? loadedDueSoon.reminderText : "",
      );
      setRecentMemories(Array.isArray(loadedRecentMemories) ? loadedRecentMemories : []);
      setChronicleObservations(
        Array.isArray(loadedChronicleObservations) ? loadedChronicleObservations : [],
      );
    } catch (error) {
      console.error("Failed to load memory settings:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const query = memorySearchQuery.trim();
    if (!query) {
      setMemorySearchResults([]);
      setSearchingMemories(false);
      return;
    }

    let cancelled = false;
    setSearchingMemories(true);
    const timeout = setTimeout(async () => {
      try {
        const results = await window.electronAPI.searchMemories({
          workspaceId,
          query,
          limit: 30,
        });
        if (cancelled) return;
        const details = await window.electronAPI.getMemoryDetails(results.map((r) => r.id));
        if (cancelled) return;
        setMemorySearchResults(Array.isArray(details) ? details : []);
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to search memories:", error);
          setMemorySearchResults([]);
        }
      } finally {
        if (!cancelled) {
          setSearchingMemories(false);
        }
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [memorySearchQuery, workspaceId]);

  const loadImportedMemories = useCallback(
    async (offset = 0) => {
      try {
        setLoadingImported(true);
        const memories = await window.electronAPI.findImportedMemories({
          workspaceId,
          limit: PAGE_SIZE,
          offset,
        });
        if (offset === 0) {
          setImportedMemories(memories);
        } else {
          setImportedMemories((prev) => [...prev, ...memories]);
        }
        setImportedOffset(offset + memories.length);
        setImportedHasMore(memories.length === PAGE_SIZE);
      } catch (error) {
        console.error("Failed to load imported memories:", error);
      } finally {
        setLoadingImported(false);
      }
    },
    [workspaceId],
  );

  const handleToggleImported = () => {
    if (!showImported) {
      loadImportedMemories(0);
    }
    setShowImported(!showImported);
  };

  const handleDeleteImported = async () => {
    if (
      !confirm(
        "Are you sure you want to delete all imported memories? Native memories will not be affected. This cannot be undone.",
      )
    ) {
      return;
    }
    try {
      setDeletingImported(true);
      await window.electronAPI.deleteImportedMemories(workspaceId);
      setImportedMemories([]);
      setImportedOffset(0);
      setImportedHasMore(false);
      setShowImported(false);
      await loadData();
    } catch (error) {
      console.error("Failed to delete imported memories:", error);
    } finally {
      setDeletingImported(false);
    }
  };

  const handleDeleteImportedEntry = async (memoryId: string) => {
    if (!confirm("Delete this imported memory entry? This cannot be undone.")) {
      return;
    }
    try {
      setDeletingImportedEntryId(memoryId);
      await window.electronAPI.deleteImportedMemoryEntry({ workspaceId, memoryId });
      await loadImportedMemories(0);
      await loadData();
    } catch (error) {
      console.error("Failed to delete imported memory entry:", error);
    } finally {
      setDeletingImportedEntryId(null);
    }
  };

  const handleToggleImportedPromptRecallIgnored = async (
    memoryId: string,
    currentlyIgnored: boolean,
  ) => {
    try {
      setUpdatingImportedEntryId(memoryId);
      const result = await window.electronAPI.setImportedMemoryPromptRecallIgnored({
        workspaceId,
        memoryId,
        ignored: !currentlyIgnored,
      });

      if (result?.memory) {
        setImportedMemories((prev) =>
          prev.map((entry) =>
            entry.id === memoryId
              ? {
                  ...entry,
                  content: result.memory?.content ?? entry.content,
                  tokens: result.memory?.tokens ?? entry.tokens,
                  createdAt: result.memory?.createdAt ?? entry.createdAt,
                  type: result.memory?.type ?? entry.type,
                }
              : entry,
          ),
        );
      } else {
        await loadImportedMemories(0);
      }

      await loadData();
    } catch (error) {
      console.error("Failed to update imported memory prompt-recall state:", error);
    } finally {
      setUpdatingImportedEntryId(null);
    }
  };

  const handleSave = async (updates: Partial<MemorySettingsData>) => {
    if (!settings) return;
    try {
      setSaving(true);
      await window.electronAPI.saveMemorySettings({ workspaceId, settings: updates });
      setSettings({ ...settings, ...updates });
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to save memory settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (
      !confirm(
        "Are you sure you want to clear all memories for this workspace? This cannot be undone.",
      )
    ) {
      return;
    }
    try {
      setClearing(true);
      await window.electronAPI.clearMemory(workspaceId);
      setImportedMemories([]);
      setImportedOffset(0);
      setImportedHasMore(false);
      setShowImported(false);
      await loadData();
    } catch (error) {
      console.error("Failed to clear memory:", error);
    } finally {
      setClearing(false);
    }
  };

  const handleDeleteChronicleObservation = async (observationId: string) => {
    try {
      setDeletingChronicleId(observationId);
      await window.electronAPI.deleteChronicleObservation({ workspaceId, observationId });
      await loadData();
    } catch (error) {
      console.error("Failed to delete Chronicle observation:", error);
    } finally {
      setDeletingChronicleId(null);
    }
  };

  const handleClearChronicleObservations = async () => {
    try {
      setClearingChronicle(true);
      await window.electronAPI.clearChronicleObservations({ workspaceId });
      await loadData();
    } catch (error) {
      console.error("Failed to clear Chronicle observations:", error);
    } finally {
      setClearingChronicle(false);
    }
  };

  const handleAddFact = async () => {
    const trimmed = newFact.trim();
    if (!trimmed) return;
    try {
      setSavingFact(true);
      const created = await window.electronAPI.addUserFact({
        category: newFactCategory,
        value: trimmed,
        source: "manual",
        confidence: 1,
      });
      setUserProfile((prev) => ({
        summary: prev?.summary,
        updatedAt: Date.now(),
        facts: [created, ...(prev?.facts || [])],
      }));
      setNewFact("");
    } catch (error) {
      console.error("Failed to add user fact:", error);
    } finally {
      setSavingFact(false);
    }
  };

  const handleDeleteFact = async (factId: string) => {
    try {
      await window.electronAPI.deleteUserFact(factId);
      setUserProfile((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          facts: prev.facts.filter((fact) => fact.id !== factId),
          updatedAt: Date.now(),
        };
      });
    } catch (error) {
      console.error("Failed to delete user fact:", error);
    }
  };

  const handleToggleFactPin = async (fact: UserFact) => {
    try {
      const updated = await window.electronAPI.updateUserFact({
        id: fact.id,
        pinned: !fact.pinned,
      });
      if (!updated) return;
      setUserProfile((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          updatedAt: Date.now(),
          facts: prev.facts.map((existing) => (existing.id === updated.id ? updated : existing)),
        };
      });
    } catch (error) {
      console.error("Failed to update user fact:", error);
    }
  };

  const handleDeleteRelationship = async (itemId: string) => {
    try {
      await window.electronAPI.deleteRelationshipMemory(itemId);
      setRelationshipItems((prev) => prev.filter((item) => item.id !== itemId));
      setDueSoonItems((prev) => prev.filter((item) => item.id !== itemId));
    } catch (error) {
      console.error("Failed to delete relationship memory:", error);
    }
  };

  const handleToggleCommitmentStatus = async (item: RelationshipMemoryItem) => {
    try {
      const nextStatus = item.status === "done" ? "open" : "done";
      const updated = await window.electronAPI.updateRelationshipMemory({
        id: item.id,
        status: nextStatus,
      });
      if (!updated) return;
      setRelationshipItems((prev) => prev.map((entry) => (entry.id === item.id ? updated : entry)));
      if (nextStatus === "done") {
        setDueSoonItems((prev) => prev.filter((entry) => entry.id !== item.id));
      }
    } catch (error) {
      console.error("Failed to update commitment status:", error);
    }
  };

  const handleEditRelationship = async (item: RelationshipMemoryItem) => {
    const nextText = prompt("Edit memory item", item.text);
    if (nextText == null) return;
    const trimmed = nextText.trim();
    if (!trimmed) return;
    try {
      const updated = await window.electronAPI.updateRelationshipMemory({
        id: item.id,
        text: trimmed,
      });
      if (!updated) return;
      setRelationshipItems((prev) => prev.map((entry) => (entry.id === item.id ? updated : entry)));
      setDueSoonItems((prev) => prev.map((entry) => (entry.id === item.id ? updated : entry)));
    } catch (error) {
      console.error("Failed to edit relationship memory:", error);
    }
  };

  const handleCleanupRecurringHistory = async () => {
    if (
      !confirm(
        "Collapse duplicate recurring completed-task history entries and keep only the latest per task title?",
      )
    ) {
      return;
    }
    try {
      setCleaningRecurringHistory(true);
      const result = await window.electronAPI.cleanupRecurringRelationshipHistory();
      setRecurringCleanupMessage(
        result.collapsed > 0
          ? `Cleaned ${result.collapsed} duplicate entries across ${result.groupsCollapsed} recurring task title(s).`
          : "No duplicate recurring history entries found.",
      );
      await loadData();
    } catch (error) {
      console.error("Failed to cleanup recurring relationship history:", error);
      setRecurringCleanupMessage("Failed to clean recurring history. Please try again.");
    } finally {
      setCleaningRecurringHistory(false);
    }
  };

  if (loading || !settings) {
    return (
      <div className="settings-section">
        <div className="settings-loading">Loading memory settings...</div>
      </div>
    );
  }

  // Show import wizard full-screen in the settings panel
  if (showImportWizard) {
    return (
      <ChatGPTImportWizard
        workspaceId={workspaceId}
        onClose={() => {
          setShowImportWizard(false);
          loadData();
        }}
        onImportComplete={() => loadData()}
      />
    );
  }

  const latestMemory =
    recentMemories.find((memory) => !/^\s*[{[]/.test((memory.content || "").trim())) ||
    recentMemories[0];
  const selectedManageMemories = memorySearchQuery.trim() ? memorySearchResults : recentMemories;

  return (
    <div className="settings-section">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
        }}
      >
        <h3 className="settings-section-title" style={{ margin: 0 }}>
          Memory
        </h3>
        <button
          className="settings-button"
          onClick={() => setShowManageMemories((prev) => !prev)}
          style={{ whiteSpace: "nowrap" }}
        >
          {showManageMemories ? "Hide Manage" : "Manage"}
        </button>
      </div>
      <p className="settings-section-description">
        Keep useful context over time, control what gets remembered, and review or delete memory
        whenever you want.
      </p>

      <ToggleRow
        title="Use memory in responses"
        description="Allows the assistant to reference saved memories while responding."
        checked={settings.enabled}
        onChange={(checked) => handleSave({ enabled: checked })}
        disabled={saving}
      />

      <ToggleRow
        title="Generate memory from chat history"
        description="Automatically stores useful context from chats/tasks. Turn this off to stop new memory creation."
        checked={settings.autoCapture}
        onChange={(checked) => handleSave({ autoCapture: checked })}
        disabled={saving || !settings.enabled}
      />

      <div className="settings-form-group memory-preview-card">
        <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
          Memory from your chats
        </div>
        <p className="settings-form-hint" style={{ marginTop: "4px", marginBottom: "10px" }}>
          {latestMemory ? formatRelativeTime(latestMemory.createdAt) : "No memory captured yet"}
        </p>
        <div className="settings-card" style={{ color: "var(--color-text-secondary)", fontSize: "13px", lineHeight: "1.45" }}>
          {latestMemory
            ? (() => {
                const preview =
                  parseImportTag(latestMemory.content).preview || latestMemory.content;
                return /^\s*[{[]/.test(preview.trim())
                  ? "Recent memory is technical/system content. Open Manage to inspect all memories."
                  : preview;
              })()
            : "No memory preview available yet."}
        </div>
      </div>

      {/* Import from other AI providers */}
      <div
        className="settings-form-group memory-section"
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div
              style={{ fontWeight: 500, color: "var(--color-text-primary)", marginBottom: "4px" }}
            >
              Import memory from other AI providers
            </div>
            <p className="settings-form-hint" style={{ margin: 0 }}>
              Bring relevant context and data from another AI provider. CoWork OS gives you a prompt
              to fetch memory from Claude, Gemini, Meta AI, and others.
            </p>
          </div>
          <button
            className="chatgpt-import-btn chatgpt-import-btn-primary"
            onClick={() => setShowPromptImportWizard(true)}
            disabled={!settings.enabled}
            style={{ opacity: settings.enabled ? 1 : 0.5, whiteSpace: "nowrap" }}
          >
            Start Import
          </button>
        </div>
      </div>

      {showManageMemories && (
        <>
          <div
            className="settings-form-group memory-section"
          >
            <div
              style={{ fontWeight: 500, color: "var(--color-text-primary)", marginBottom: "8px" }}
            >
              Manage memories
            </div>
            <input
              className="settings-input"
              type="text"
              value={memorySearchQuery}
              onChange={(e) => setMemorySearchQuery(e.target.value)}
              placeholder="Search memories"
              style={{ marginBottom: "10px" }}
            />
            <div className="memory-list" style={{ maxHeight: "220px" }}>
              {searchingMemories && (
                <div className="memory-list-item" style={{ color: "var(--color-text-secondary)", fontSize: "13px" }}>
                  Searching...
                </div>
              )}
              {!searchingMemories && selectedManageMemories.length === 0 && (
                <div className="settings-empty">No memories found.</div>
              )}
              {!searchingMemories &&
                selectedManageMemories.slice(0, 30).map((memory) => {
                  const parsed = parseImportTag(memory.content);
                  const title = parsed.isImported
                    ? parsed.title
                    : memory.type
                      ? formatMemoryTypeLabel(memory.type)
                      : parsed.title;
                  return (
                    <div key={memory.id} className="memory-list-item">
                      <div
                        style={{
                          color: "var(--color-text-primary)",
                          fontSize: "13px",
                          marginBottom: "4px",
                        }}
                      >
                        {title}
                      </div>
                      <div style={{ color: "var(--color-text-secondary)", fontSize: "12px" }}>
                        {parsed.preview || memory.content.slice(0, 180)}
                      </div>
                      <div
                        style={{
                          color: "var(--color-text-tertiary)",
                          fontSize: "11px",
                          marginTop: "4px",
                        }}
                      >
                        {new Date(memory.createdAt).toLocaleDateString()}
                        {typeof memory.tokens === "number" ? ` • ${memory.tokens} tokens` : ""}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>

          <div className="settings-form-group memory-section">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "8px",
              }}
            >
              <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
                Chronicle observations
              </div>
              <button
                className="settings-button"
                onClick={handleClearChronicleObservations}
                disabled={clearingChronicle || chronicleObservations.length === 0}
              >
                {clearingChronicle ? "Clearing..." : "Clear Chronicle"}
              </button>
            </div>
            <p className="settings-form-hint" style={{ marginTop: 0 }}>
              Promoted Chronicle screen-context entries that were actually used by tasks.
            </p>
            <div className="memory-list" style={{ maxHeight: "220px" }}>
              {chronicleObservations.length === 0 && (
                <div className="settings-empty">No Chronicle observations stored yet.</div>
              )}
              {chronicleObservations.map((observation) => (
                <div
                  key={observation.id}
                  className="memory-list-item"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: "8px",
                    alignItems: "start",
                  }}
                >
                  <div>
                    <div style={{ color: "var(--color-text-primary)", fontSize: "13px" }}>
                      {observation.windowTitle || observation.appName || "Screen context"}
                    </div>
                    <div style={{ color: "var(--color-text-secondary)", fontSize: "12px" }}>
                      {[observation.appName, observation.localTextSnippet]
                        .filter(Boolean)
                        .join(" • ")
                        .slice(0, 220) || "No OCR text cached yet."}
                    </div>
                    <div
                      style={{
                        color: "var(--color-text-tertiary)",
                        fontSize: "11px",
                        marginTop: "4px",
                      }}
                    >
                      {new Date(observation.capturedAt).toLocaleString()}
                      {observation.destinationHints?.length
                        ? ` • ${observation.destinationHints.join(", ")}`
                        : ""}
                      {observation.memoryId ? " • memory linked" : ""}
                    </div>
                  </div>
                  <button
                    className="memory-inline-btn danger"
                    disabled={deletingChronicleId === observation.id}
                    onClick={() => void handleDeleteChronicleObservation(observation.id)}
                  >
                    {deletingChronicleId === observation.id ? "Deleting..." : "Delete"}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* User Profile Facts */}
          <div
            className="settings-form-group memory-section"
          >
            <div
              style={{ fontWeight: 500, color: "var(--color-text-primary)", marginBottom: "4px" }}
            >
              User Memory Facts
            </div>
            <p className="settings-form-hint" style={{ marginTop: 0 }}>
              Curate what the assistant remembers about preferences and context.
            </p>

            <div className="memory-fact-form">
              <select
                className="settings-select"
                value={newFactCategory}
                onChange={(e) => setNewFactCategory(e.target.value as UserFactCategory)}
                disabled={savingFact}
              >
                <option value="identity">Identity</option>
                <option value="preference">Preference</option>
                <option value="bio">Profile</option>
                <option value="work">Work</option>
                <option value="goal">Goal</option>
                <option value="operating">Operating Style</option>
                <option value="voice">Voice</option>
                <option value="accountability">Accountability</option>
                <option value="constraint">Constraint</option>
                <option value="other">Other</option>
              </select>
              <input
                className="settings-input"
                type="text"
                value={newFact}
                onChange={(e) => setNewFact(e.target.value)}
                placeholder="Add a fact (for example: Prefers concise responses)"
                disabled={savingFact}
              />
              <button
                className="settings-button"
                onClick={handleAddFact}
                disabled={savingFact || !newFact.trim()}
                style={{ minWidth: "74px" }}
              >
                {savingFact ? "Saving..." : "Add"}
              </button>
            </div>

            <div className="memory-list" style={{ maxHeight: "220px" }}>
              {(!userProfile?.facts || userProfile.facts.length === 0) && (
                <div className="settings-empty">No user facts stored yet.</div>
              )}

              {(userProfile?.facts || [])
                .slice()
                .sort((a, b) => {
                  if ((a.pinned ? 1 : 0) !== (b.pinned ? 1 : 0))
                    return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
                  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
                  return b.lastUpdatedAt - a.lastUpdatedAt;
                })
                .map((fact) => (
                  <div
                    key={fact.id}
                    className="memory-list-item"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: "8px",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div style={{ color: "var(--color-text-primary)", fontSize: "13px" }}>
                        {fact.value}
                      </div>
                      <div
                        style={{
                          color: "var(--color-text-tertiary)",
                          fontSize: "11px",
                          marginTop: "2px",
                        }}
                      >
                        {fact.category} • {Math.round(fact.confidence * 100)}% confidence
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        className={`memory-inline-btn${fact.pinned ? " active" : ""}`}
                        onClick={() => handleToggleFactPin(fact)}
                      >
                        {fact.pinned ? "Pinned" : "Pin"}
                      </button>
                      <button
                        className="memory-inline-btn danger"
                        onClick={() => handleDeleteFact(fact.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Relationship Memory */}
          <div
            className="settings-form-group memory-section"
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "6px",
              }}
            >
              <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
                Relationship Memory
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button
                  className="settings-button"
                  style={{ padding: "4px 10px" }}
                  onClick={handleCleanupRecurringHistory}
                  disabled={cleaningRecurringHistory}
                >
                  {cleaningRecurringHistory ? "Cleaning..." : "Clean Old Recurring History"}
                </button>
                <button
                  className="settings-button"
                  style={{ padding: "4px 10px" }}
                  onClick={() => loadData()}
                >
                  Refresh
                </button>
              </div>
            </div>
            <p className="settings-form-hint" style={{ marginTop: 0 }}>
              Continuity memory across identity, preferences, context, history, and commitments.
            </p>
            {recurringCleanupMessage && (
              <div
                style={{
                  marginBottom: "8px",
                  fontSize: "12px",
                  color: "var(--color-text-secondary)",
                }}
              >
                {recurringCleanupMessage}
              </div>
            )}

            <div
              style={{
                marginBottom: "8px",
                fontSize: "12px",
                color: "var(--color-text-secondary)",
              }}
            >
              {dueSoonReminder || "No commitments due soon."}
            </div>

            <div className="memory-list">
              {relationshipItems.length === 0 && (
                <div className="settings-empty">No relationship memory items stored yet.</div>
              )}
              {relationshipItems.map((item) => (
                <div
                  key={item.id}
                  className="memory-list-item"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: "8px",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ color: "var(--color-text-primary)", fontSize: "13px" }}>
                      {item.text}
                    </div>
                    <div
                      style={{
                        color: "var(--color-text-tertiary)",
                        fontSize: "11px",
                        marginTop: "2px",
                      }}
                    >
                      {item.layer} • {Math.round(item.confidence * 100)}% confidence
                      {item.status ? ` • ${item.status}` : ""}
                      {item.dueAt ? ` • due ${new Date(item.dueAt).toLocaleDateString()}` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {item.layer === "commitments" && (
                      <button
                        className={`memory-inline-btn${item.status === "done" ? " active" : ""}`}
                        onClick={() => handleToggleCommitmentStatus(item)}
                      >
                        {item.status === "done" ? "Reopen" : "Done"}
                      </button>
                    )}
                    <button className="memory-inline-btn" onClick={() => handleEditRelationship(item)}>
                      Edit
                    </button>
                    <button className="memory-inline-btn danger" onClick={() => handleDeleteRelationship(item.id)}>
                      Forget
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {dueSoonItems.length > 0 && (
              <div
                style={{
                  marginTop: "10px",
                  fontSize: "12px",
                  color: "var(--color-text-secondary)",
                }}
              >
                Due soon:{" "}
                {dueSoonItems
                  .slice(0, 3)
                  .map((item) => item.text)
                  .join(" • ")}
              </div>
            )}
          </div>

          {/* Stats Display */}
          {stats && (
            <div className="memory-stats-grid">
              <div className="stat-card">
                <div className="stat-value">{(stats.count ?? 0).toLocaleString()}</div>
                <div className="stat-label">Memories</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{(stats.totalTokens ?? 0).toLocaleString()}</div>
                <div className="stat-label">Tokens</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{(stats.compressedCount ?? 0).toLocaleString()}</div>
                <div className="stat-label">Compressed</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{Math.round((stats.compressionRatio ?? 0) * 100)}%</div>
                <div className="stat-label">Ratio</div>
              </div>
            </div>
          )}

          {/* Imported Memories Section */}
          {importedStats && importedStats.count > 0 && (
            <div className="settings-form-group memory-section">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "12px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
                    Imported Memories
                  </div>
                  <span className="settings-badge settings-badge--success">
                    {importedStats.count.toLocaleString()}
                  </span>
                </div>
                <button className="memory-inline-btn" onClick={handleToggleImported}>
                  {showImported ? "Hide" : "View"}
                </button>
              </div>

              {/* Imported stats mini cards */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  gap: "8px",
                  marginBottom: showImported ? "12px" : 0,
                }}
              >
                <div
                  style={{
                    padding: "8px 12px",
                    background: "var(--color-bg-tertiary)",
                    borderRadius: "6px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                    Conversations
                  </span>
                  <span
                    style={{
                      fontSize: "14px",
                      fontWeight: "600",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {importedStats.count.toLocaleString()}
                  </span>
                </div>
                <div
                  style={{
                    padding: "8px 12px",
                    background: "var(--color-bg-tertiary)",
                    borderRadius: "6px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                    Tokens
                  </span>
                  <span
                    style={{
                      fontSize: "14px",
                      fontWeight: "600",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {importedStats.totalTokens.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* Expanded imported memories list */}
              {showImported && (
                <div>
                  <div className="memory-list" style={{ maxHeight: "300px" }}>
                    {importedMemories.map((memory) => {
                      const { title, preview, ignoredForPromptRecall } = parseImportTag(memory.content);
                      const busy =
                        deletingImportedEntryId === memory.id || updatingImportedEntryId === memory.id;
                      return (
                        <div key={memory.id} className="memory-list-item" style={{ fontSize: "13px" }}>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              marginBottom: "4px",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                minWidth: 0,
                                maxWidth: "70%",
                              }}
                            >
                              <div
                                style={{
                                  fontWeight: 500,
                                  color: "var(--color-text-primary)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {title}
                              </div>
                              {ignoredForPromptRecall && (
                                <span className="settings-badge settings-badge--warning" style={{ fontSize: "10px" }}>
                                  ignored in prompts
                                </span>
                              )}
                            </div>
                            <div
                              style={{
                                fontSize: "11px",
                                color: "var(--color-text-tertiary)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {new Date(memory.createdAt).toLocaleDateString()} · {memory.tokens}{" "}
                              tokens
                            </div>
                          </div>
                          <div
                            style={{
                              color: "var(--color-text-secondary)",
                              fontSize: "12px",
                              lineHeight: "1.4",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical" as const,
                            }}
                          >
                            {preview}
                          </div>
                          <div
                            style={{
                              marginTop: "8px",
                              display: "flex",
                              gap: "8px",
                              justifyContent: "flex-end",
                            }}
                          >
                            <button
                              className="memory-inline-btn active"
                              onClick={() =>
                                handleToggleImportedPromptRecallIgnored(memory.id, ignoredForPromptRecall)
                              }
                              disabled={busy}
                              style={{ opacity: busy ? 0.6 : 1 }}
                            >
                              {updatingImportedEntryId === memory.id
                                ? "Saving..."
                                : ignoredForPromptRecall
                                  ? "Use in prompts"
                                  : "Ignore in prompts"}
                            </button>
                            <button
                              className="memory-inline-btn danger"
                              onClick={() => handleDeleteImportedEntry(memory.id)}
                              disabled={busy}
                              style={{ opacity: busy ? 0.6 : 1 }}
                            >
                              {deletingImportedEntryId === memory.id ? "Deleting..." : "Delete"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {importedMemories.length === 0 && !loadingImported && (
                      <div className="settings-empty">No imported memories found.</div>
                    )}
                    {loadingImported && (
                      <div className="memory-list-item" style={{ textAlign: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}>
                        Loading...
                      </div>
                    )}
                  </div>

                  {importedHasMore && !loadingImported && (
                    <button
                      className="memory-inline-btn"
                      onClick={() => loadImportedMemories(importedOffset)}
                      style={{ display: "block", width: "100%", marginTop: "8px", textAlign: "center" }}
                    >
                      Load more...
                    </button>
                  )}

                  <button
                    className="settings-button settings-button-danger"
                    onClick={handleDeleteImported}
                    disabled={deletingImported}
                    style={{ display: "block", width: "100%", marginTop: "8px", opacity: deletingImported ? 0.6 : 1 }}
                  >
                    {deletingImported ? "Deleting..." : "Delete All Imported Memories"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Import from ChatGPT */}
          <div
            className="settings-form-group memory-section"
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div
                  style={{
                    fontWeight: 500,
                    color: "var(--color-text-primary)",
                    marginBottom: "4px",
                  }}
                >
                  Import from ChatGPT (JSON export)
                </div>
                <p className="settings-form-hint" style={{ margin: 0 }}>
                  {importedStats && importedStats.count > 0
                    ? "Import more conversations to append to existing imported memories. Duplicates are automatically skipped."
                    : "Import your ChatGPT conversation history to build richer context. Your data stays on your device."}
                </p>
              </div>
              <button
                className="chatgpt-import-btn chatgpt-import-btn-primary"
                onClick={() => setShowImportWizard(true)}
                disabled={!settings.enabled}
                style={{ opacity: settings.enabled ? 1 : 0.5, whiteSpace: "nowrap" }}
              >
                {importedStats && importedStats.count > 0 ? "Import More" : "Import"}
              </button>
            </div>
          </div>

          {settings.enabled && (
            <>
              <div
                className="settings-form-group"
                style={{
                  marginTop: "10px",
                  paddingTop: "10px",
                  borderTop: "1px solid var(--color-border)",
                }}
              >
                <div
                  style={{
                    fontWeight: 500,
                    color: "var(--color-text-primary)",
                    marginBottom: "4px",
                  }}
                >
                  Advanced memory settings
                </div>
                <p className="settings-form-hint" style={{ margin: 0 }}>
                  Tune memory quality, privacy, retention, and storage behavior.
                </p>
              </div>

              {/* Compression Toggle */}
              <ToggleRow
                title="Enable compression"
                description="Uses LLM to summarize memories, reducing token usage by ~10x."
                checked={settings.compressionEnabled}
                onChange={(checked) => handleSave({ compressionEnabled: checked })}
                disabled={saving}
              />

              {/* Privacy Mode */}
              <div className="settings-form-group">
                <label className="settings-label">Privacy Mode</label>
                <select
                  value={settings.privacyMode}
                  onChange={(e) => handleSave({ privacyMode: e.target.value as PrivacyMode })}
                  disabled={saving}
                  className="settings-select"
                >
                  <option value="normal">Normal - Auto-detect sensitive data</option>
                  <option value="strict">Strict - Mark all as private</option>
                  <option value="disabled">Disabled - No memory capture</option>
                </select>
                <p className="settings-form-hint">
                  Controls how sensitive data is handled in memories.
                </p>
              </div>

              {/* Retention Period */}
              <div className="settings-form-group">
                <label className="settings-label">Retention Period</label>
                <select
                  value={settings.retentionDays}
                  onChange={(e) => handleSave({ retentionDays: parseInt(e.target.value) })}
                  disabled={saving}
                  className="settings-select"
                >
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="180">180 days</option>
                  <option value="365">1 year</option>
                </select>
                <p className="settings-form-hint">
                  Memories older than this will be automatically deleted.
                </p>
              </div>

              {/* Storage Cap */}
              <div className="settings-form-group">
                <label className="settings-label">Storage Cap (MB)</label>
                <input
                  type="number"
                  min={10}
                  max={5000}
                  step={10}
                  value={settings.maxStorageMb}
                  onChange={(e) => {
                    const value = Math.max(
                      10,
                      Math.min(5000, parseInt(e.target.value || "0", 10) || 100),
                    );
                    handleSave({ maxStorageMb: value });
                  }}
                  disabled={saving}
                  className="settings-input"
                />
                <p className="settings-form-hint">
                  Oldest memories are pruned automatically when this limit is exceeded.
                </p>
              </div>

              {/* Clear Button */}
              <div
                className="settings-form-group"
                style={{
                  marginTop: "24px",
                  paddingTop: "16px",
                  borderTop: "1px solid var(--color-border)",
                }}
              >
                <button
                  className="settings-button settings-button-danger"
                  onClick={handleClear}
                  disabled={saving || clearing}
                  style={{ opacity: clearing ? 0.6 : 1 }}
                >
                  {clearing ? "Clearing..." : "Clear All Memories"}
                </button>
                <p className="settings-form-hint" style={{ marginTop: "8px" }}>
                  Permanently deletes all memories for this workspace.
                </p>
              </div>
            </>
          )}
        </>
      )}
      {showPromptImportWizard && (
        <PromptMemoryImportWizard
          workspaceId={workspaceId}
          onClose={() => {
            setShowPromptImportWizard(false);
            loadData();
          }}
          onImportComplete={() => loadData()}
        />
      )}
    </div>
  );
}
