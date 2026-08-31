import { useEffect, useMemo, useState } from "react";
import type { UserFact, UserProfile } from "../../../shared/types";
import {
  buildStructuredUserProfileSummary,
  inferUserFactCategory,
} from "../../../shared/user-profile-summary";

interface PersonalityMemoryTabProps {
  onChanged?: () => void;
}

const MAX_PROFILE_MEMORY_LENGTH = 240;

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "Not updated yet";
  const deltaMs = Date.now() - timestamp;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days} day${days === 1 ? "" : "s"} ago`;
}

export function PersonalityMemoryTab({ onChanged }: PersonalityMemoryTabProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingFact, setEditingFact] = useState<UserFact | null>(null);
  const [status, setStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const sections = useMemo(() => buildStructuredUserProfileSummary(profile), [profile]);
  const factCount = profile?.facts?.length ?? 0;
  const draftLength = draft.trim().length;

  const loadProfile = async () => {
    try {
      setLoading(true);
      const loaded = await window.electronAPI.getUserProfile();
      setProfile(loaded);
    } catch (error) {
      console.error("Failed to load profile memory:", error);
      setProfile({ facts: [], updatedAt: 0 });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProfile();
  }, []);

  const replaceFact = (updated: UserFact) => {
    setProfile((current) => {
      if (!current) return { facts: [updated], updatedAt: Date.now() };
      return {
        ...current,
        updatedAt: Date.now(),
        facts: current.facts.map((fact) => (fact.id === updated.id ? updated : fact)),
      };
    });
  };

  const handleSubmit = async () => {
    const value = draft.trim();
    if (!value) return;
    if (value.length > MAX_PROFILE_MEMORY_LENGTH) {
      setStatus({
        tone: "error",
        message: `Profile memory is limited to ${MAX_PROFILE_MEMORY_LENGTH} characters.`,
      });
      return;
    }

    try {
      setSaving(true);
      const category = inferUserFactCategory(value);
      if (editingFact) {
        const updated = await window.electronAPI.updateUserFact({
          id: editingFact.id,
          value,
          category,
          confidence: 1,
          pinned: true,
        });
        if (!updated) {
          setStatus({
            tone: "error",
            message: "That memory no longer exists. Refreshing memory.",
          });
          await loadProfile();
          return;
        }
        replaceFact(updated);
      } else {
        const created = await window.electronAPI.addUserFact({
          category,
          value,
          source: "manual",
          confidence: 1,
          pinned: true,
        });
        setProfile((current) => ({
          summary: current?.summary,
          updatedAt: Date.now(),
          facts: [created, ...(current?.facts || []).filter((fact) => fact.id !== created.id)],
        }));
      }
      setDraft("");
      setEditingFact(null);
      setStatus({
        tone: "success",
        message: editingFact ? "Profile memory updated." : "Profile memory added.",
      });
      onChanged?.();
    } catch (error) {
      console.error("Failed to save profile memory:", error);
      setStatus({ tone: "error", message: "Failed to save profile memory." });
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (fact: UserFact) => {
    setEditingFact(fact);
    setDraft(fact.value);
  };

  const handleCancelEdit = () => {
    setEditingFact(null);
    setDraft("");
  };

  const handleDelete = async (factId: string) => {
    if (!window.confirm("Delete this profile memory? This cannot be undone.")) {
      return;
    }
    try {
      const result = await window.electronAPI.deleteUserFact(factId);
      if (!result?.success) {
        setStatus({
          tone: "error",
          message: "That memory was already removed. Refreshing memory.",
        });
        await loadProfile();
        return;
      }
      setProfile((current) => {
        if (!current) return current;
        return {
          ...current,
          updatedAt: Date.now(),
          facts: current.facts.filter((fact) => fact.id !== factId),
        };
      });
      if (editingFact?.id === factId) handleCancelEdit();
      setStatus({ tone: "success", message: "Profile memory deleted." });
      onChanged?.();
    } catch (error) {
      console.error("Failed to delete profile memory:", error);
      setStatus({ tone: "error", message: "Failed to delete profile memory." });
    }
  };

  const handleTogglePin = async (fact: UserFact) => {
    try {
      const updated = await window.electronAPI.updateUserFact({
        id: fact.id,
        pinned: !fact.pinned,
      });
      if (updated) {
        replaceFact(updated);
        setStatus({
          tone: "success",
          message: updated.pinned ? "Memory pinned." : "Memory unpinned.",
        });
        onChanged?.();
      } else {
        setStatus({ tone: "error", message: "That memory no longer exists. Refreshing memory." });
        await loadProfile();
      }
    } catch (error) {
      console.error("Failed to update profile memory pin:", error);
      setStatus({ tone: "error", message: "Failed to update profile memory." });
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading profile memory...</div>;
  }

  return (
    <div className="personality-memory-tab settings-section">
      <div className="profile-memory-header">
        <div>
          <h3>View and manage memory</h3>
          <p className="settings-description">
            View a structured summary of what CoWork remembers about you. These profile entries are
            the prompt-visible personalization layer.
          </p>
        </div>
        <div className="profile-memory-meta">
          <span>
            {factCount} item{factCount === 1 ? "" : "s"}
          </span>
          <span>{formatRelativeTime(profile?.updatedAt)}</span>
        </div>
      </div>

      {sections.length === 0 ? (
        <div className="settings-empty profile-memory-empty">
          No profile memory yet. Add a preference, goal, work context, or constraint below.
        </div>
      ) : (
        <div className="profile-memory-summary">
          {sections.map((section) => (
            <section key={section.id} className="profile-memory-section">
              <h4>{section.title}</h4>
              <div className="profile-memory-facts">
                {section.facts.map((fact) => (
                  <article key={fact.id} className="profile-memory-fact">
                    <div className="profile-memory-fact-body">
                      <p>{fact.value}</p>
                      <span>
                        {Math.round(fact.confidence * 100)}% confidence
                        {fact.pinned ? " • pinned" : ""}
                      </span>
                    </div>
                    <div className="profile-memory-actions">
                      <button type="button" onClick={() => handleEdit(fact)}>
                        Edit
                      </button>
                      <button type="button" onClick={() => void handleTogglePin(fact)}>
                        {fact.pinned ? "Unpin" : "Pin"}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => void handleDelete(fact.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="profile-memory-composer">
        {status && <div className={`profile-memory-status ${status.tone}`}>{status.message}</div>}
        {editingFact && (
          <div className="profile-memory-editing">
            Updating {editingFact.category} memory
            <button type="button" onClick={handleCancelEdit} disabled={saving}>
              Cancel
            </button>
          </div>
        )}
        <div className="profile-memory-input-row">
          <input
            className="settings-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder="Add or update something about yourself"
            disabled={saving}
            maxLength={MAX_PROFILE_MEMORY_LENGTH}
          />
          <button
            type="button"
            className="button-primary"
            onClick={() => void handleSubmit()}
            disabled={saving || !draft.trim()}
          >
            {saving ? "Saving..." : editingFact ? "Update" : "Add"}
          </button>
        </div>
        <div
          className={`profile-memory-char-count ${
            draftLength >= MAX_PROFILE_MEMORY_LENGTH ? "at-limit" : ""
          }`}
        >
          {draftLength}/{MAX_PROFILE_MEMORY_LENGTH}
        </div>
      </div>
    </div>
  );
}
