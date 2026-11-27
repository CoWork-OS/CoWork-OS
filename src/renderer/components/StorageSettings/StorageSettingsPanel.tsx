import { useCallback, useEffect, useMemo, useState } from "react";
import {
  STORAGE_CATEGORY_LABELS,
  formatStorageBytes,
  type StorageBreakdown,
  type StorageDatabaseCopy,
} from "../../../shared/storage-usage";
import "./storage-settings.css";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CopyRow({
  copy,
  busy,
  onTrash,
}: {
  copy: StorageDatabaseCopy;
  busy: boolean;
  onTrash: (copy: StorageDatabaseCopy) => void;
}) {
  return (
    <li className="storage-copy">
      <span className="storage-copy-name" title={copy.name}>
        {copy.name}
      </span>
      <span className="storage-copy-meta">
        {copy.folder === "backups" ? "backups · " : ""}
        {copy.modifiedAt > 0 ? DATE_FORMAT.format(copy.modifiedAt) : ""}
      </span>
      <span className="storage-size">{formatStorageBytes(copy.bytes)}</span>
      <button
        type="button"
        className="button-secondary button-small"
        disabled={busy}
        onClick={() => onTrash(copy)}
        aria-label={`Move ${copy.name} to the Trash`}
      >
        Move to Trash
      </button>
    </li>
  );
}

/** Settings > Storage: what CoWork keeps in its profile folder, by kind. */
export function StorageSettingsPanel() {
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      setBreakdown(await window.electronAPI.getStorageBreakdown());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  const shown = useMemo(
    () =>
      (breakdown?.categories ?? [])
        .filter((category) => category.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes),
    [breakdown],
  );
  const copies = breakdown?.databaseCopies ?? [];

  const clearCache = async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await window.electronAPI.clearStorageCache();
      const freed = Math.max(0, result.before - result.after);
      setNotice(
        freed > 0 ? `Cleared ${formatStorageBytes(freed)} of cache.` : "The cache was empty.",
      );
      await scan();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const trash = async (targets: StorageDatabaseCopy[]) => {
    if (targets.length === 0) return;
    const total = targets.reduce((sum, copy) => sum + copy.bytes, 0);
    const what = targets.length === 1 ? `"${targets[0].name}"` : `${targets.length} backups`;
    const onlyCopies = targets.filter((copy) => copy.onlyCopy);
    const onlyCopyNote =
      onlyCopies.length > 0
        ? ` ${onlyCopies.length === 1 ? `"${onlyCopies[0].name}" is` : `${onlyCopies.length} of them are`} the only copy of memory CoWork retired in an upgrade.`
        : "";
    if (
      !window.confirm(
        `Move ${what} (${formatStorageBytes(total)}) to the Trash?${onlyCopyNote} You can put ${targets.length === 1 ? "it" : "them"} back from the Trash until you empty it.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await window.electronAPI.trashDatabaseCopies(targets.map((copy) => copy.id));
      if (result.failed.length > 0) {
        setError(
          `${result.failed.length} couldn't be moved: ${result.failed.map((item) => `${item.name} (${item.reason})`).join(", ")}`,
        );
      }
      if (result.trashed.length > 0) {
        setNotice(
          `Moved ${result.trashed.length} ${result.trashed.length === 1 ? "backup" : "backups"} to the Trash.`,
        );
      }
      await scan();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (folder: "profile" | "backups") => {
    try {
      const result = await window.electronAPI.openStorageFolder(folder);
      if (!result.success && result.error) setError(result.error);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="storage-settings settings-section">
      <h3>Storage</h3>
      <p className="settings-description">
        What CoWork keeps on this computer, in its profile folder. Your workspaces' own files aren't
        counted here.
      </p>

      <div className="storage-summary">
        <div className="storage-summary-total">
          {breakdown ? (
            <>
              <span className="storage-summary-size">
                {formatStorageBytes(breakdown.totalBytes)}
              </span>
              <span className="storage-summary-note">
                {breakdown.disk
                  ? `used · ${formatStorageBytes(breakdown.disk.freeBytes)} free on this disk`
                  : "used"}
              </span>
            </>
          ) : (
            <span className="storage-summary-note">{scanning ? "Counting…" : ""}</span>
          )}
        </div>
        <div className="storage-summary-actions">
          <button
            type="button"
            className="button-secondary button-small"
            disabled={scanning || busy}
            onClick={() => void scan()}
          >
            {scanning ? "Counting…" : "Count again"}
          </button>
          <button
            type="button"
            className="button-secondary button-small"
            onClick={() => void openFolder("profile")}
          >
            Show folder
          </button>
        </div>
      </div>

      {breakdown?.partial && (
        <p className="storage-hint">
          The folder has too many files to count in one go; these sizes are at least this much.
        </p>
      )}

      {breakdown && (
        <ul className="storage-categories" aria-label="Storage by kind">
          {shown.map((category) => {
            const { label, hint } = STORAGE_CATEGORY_LABELS[category.id];
            return (
              <li key={category.id} className="storage-category">
                <div className="storage-category-head">
                  <span className="storage-category-label">{label}</span>
                  <span className="storage-size">{formatStorageBytes(category.bytes)}</span>
                </div>
                <progress
                  className="storage-bar"
                  max={Math.max(breakdown.totalBytes, 1)}
                  value={category.bytes}
                  aria-label={`${label}: ${formatStorageBytes(category.bytes)}`}
                />
                <div className="storage-category-foot">
                  <span className="storage-hint">
                    {category.id === "chronicle"
                      ? `${hint}. Clear them in Settings > Built-in Tools > Chronicle.`
                      : hint}
                  </span>
                  {category.id === "cache" && (
                    <button
                      type="button"
                      className="button-secondary button-small"
                      disabled={busy || scanning}
                      onClick={() => void clearCache()}
                    >
                      Clear cache
                    </button>
                  )}
                </div>
                {category.id === "database_copies" && copies.length > 0 && (
                  <details className="storage-copies">
                    <summary>
                      {copies.length} {copies.length === 1 ? "backup" : "backups"}
                    </summary>
                    <ul className="storage-copy-list">
                      {copies.map((copy) => (
                        <CopyRow
                          key={copy.id}
                          copy={copy}
                          busy={busy}
                          onTrash={(target) => void trash([target])}
                        />
                      ))}
                    </ul>
                    <div className="storage-copy-actions">
                      <button
                        type="button"
                        className="button-secondary button-small"
                        disabled={busy}
                        onClick={() => void trash(copies)}
                      >
                        Move all to Trash
                      </button>
                      {copies.some((copy) => copy.folder === "backups") && (
                        <button
                          type="button"
                          className="button-secondary button-small"
                          onClick={() => void openFolder("backups")}
                        >
                          Show backups folder
                        </button>
                      )}
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {notice && (
        <p className="storage-notice" role="status">
          {notice}
        </p>
      )}
      {error && <div className="settings-error">{error}</div>}
    </div>
  );
}

export default StorageSettingsPanel;
