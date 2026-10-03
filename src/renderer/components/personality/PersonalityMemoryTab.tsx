import "../memory/memory-knowledge.css";

interface PersonalityMemoryTabProps {
  /** Opens Settings > Memory on its "What CoWork knows" tab. */
  onOpenMemoryHub?: () => void;
}

/**
 * Facts about the user are edited in one place: Memory Hub > What CoWork knows, which
 * shows every fact with its source, scope and history. This tab points there instead of
 * keeping a second editor over the legacy profile store.
 */
export function PersonalityMemoryTab({ onOpenMemoryHub }: PersonalityMemoryTabProps) {
  return (
    <div className="personality-memory-tab settings-section memory-personality-redirect">
      <h3>View and manage memory</h3>
      <p className="settings-description">
        What CoWork remembers about you (your name, preferences, rules and commitments) now lives in{" "}
        <strong>Settings &gt; Memory &gt; What CoWork knows</strong>. Each fact shows where it came
        from, and you can edit, pin or forget it there.
      </p>
      {onOpenMemoryHub ? (
        <button type="button" className="button-primary" onClick={onOpenMemoryHub}>
          Open What CoWork knows
        </button>
      ) : (
        <p className="settings-form-hint">Open Settings &gt; Memory to manage these facts.</p>
      )}
    </div>
  );
}
