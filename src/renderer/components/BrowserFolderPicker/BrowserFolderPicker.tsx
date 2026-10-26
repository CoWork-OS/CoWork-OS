import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Folder, X } from "lucide-react";
import type { Workspace } from "../../../shared/types";
import {
  getBrowserHostFolderApi,
  registerBrowserHostFolderPicker,
} from "../../host/browser-host-folders";
import { useHostFolderBrowser } from "../../hooks/useHostFolderBrowser";
import "./browser-folder-picker.css";

type PickerRequest = {
  id: number;
  startWorkspaceId?: string;
  resolve: (workspace: Workspace | null) => void;
};

/**
 * Mounted once in a browser session. `chooseBrowserHostFolderWorkspace()` opens
 * the picker through it; desktop keeps the native folder dialog and never mounts it.
 */
export function BrowserFolderPickerHost() {
  const [request, setRequest] = useState<PickerRequest | null>(null);
  const requestRef = useRef<PickerRequest | null>(null);

  useEffect(() => {
    let sequence = 0;
    const unregister = registerBrowserHostFolderPicker(
      ({ startWorkspaceId }) =>
        new Promise<Workspace | null>((resolve) => {
          // A second request replaces the first, which resolves as cancelled.
          requestRef.current?.resolve(null);
          const next = { id: ++sequence, startWorkspaceId, resolve };
          requestRef.current = next;
          setRequest(next);
        }),
    );
    return () => {
      unregister();
      requestRef.current?.resolve(null);
      requestRef.current = null;
    };
  }, []);

  const finish = useCallback((workspace: Workspace | null) => {
    const current = requestRef.current;
    requestRef.current = null;
    setRequest(null);
    current?.resolve(workspace);
  }, []);

  if (!request) return null;
  return (
    <BrowserFolderPickerDialog
      key={request.id}
      startWorkspaceId={request.startWorkspaceId}
      onCancel={() => finish(null)}
      onChoose={finish}
    />
  );
}

export function BrowserFolderPickerDialog({
  startWorkspaceId,
  onCancel,
  onChoose,
}: {
  startWorkspaceId?: string;
  onCancel: () => void;
  onChoose: (workspace: Workspace) => void;
}) {
  const browser = useHostFolderBrowser(startWorkspaceId);
  const { listing } = browser;
  const [filter, setFilter] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const locationKey = listing ? JSON.stringify([listing.rootId, listing.path]) : "";

  useEffect(() => {
    setFilter("");
    setChooseError(null);
  }, [locationKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !choosing) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [choosing, onCancel]);

  const visibleFolders = useMemo(() => {
    const folders = listing?.folders ?? [];
    const query = filter.trim().toLowerCase();
    return query ? folders.filter((name) => name.toLowerCase().includes(query)) : folders;
  }, [filter, listing]);

  const root = listing?.roots.find((candidate) => candidate.id === listing.rootId);
  const crumbs = listing
    ? [
        { label: root?.label ?? "Home", path: [] as string[] },
        ...listing.path.map((name, index) => ({
          label: name,
          path: listing.path.slice(0, index + 1),
        })),
      ]
    : [];
  const busy = choosing || browser.loading;

  const handleChoose = async () => {
    if (!listing || busy) return;
    setChoosing(true);
    setChooseError(null);
    try {
      const workspace = await getBrowserHostFolderApi().openHostFolderWorkspace({
        rootId: listing.rootId,
        path: listing.path,
      });
      onChoose(workspace);
    } catch (error) {
      setChooseError(error instanceof Error ? error.message : "Could not use this folder.");
      setChoosing(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !choosing) onCancel();
      }}
    >
      <div
        className="modal-content browser-folder-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="browser-folder-picker-title"
      >
        <div className="modal-header">
          <h2 id="browser-folder-picker-title">Choose a folder</h2>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            disabled={choosing}
            onClick={onCancel}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="browser-folder-picker-toolbar">
          <select
            className="browser-folder-picker-root"
            aria-label="Location"
            value={listing?.rootId ?? ""}
            disabled={!listing || choosing}
            onChange={(event) => browser.open({ rootId: event.target.value, path: [] })}
          >
            {listing?.roots.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="browser-folder-picker-up"
            aria-label="Up one folder"
            title="Up one folder"
            disabled={!listing || listing.path.length === 0 || choosing}
            onClick={() =>
              listing && browser.open({ rootId: listing.rootId, path: listing.path.slice(0, -1) })
            }
          >
            <ArrowUp size={15} aria-hidden="true" />
          </button>
          <input
            type="search"
            className="browser-folder-picker-filter"
            aria-label="Filter folders"
            placeholder="Filter folders"
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>

        <nav className="browser-folder-picker-crumbs" aria-label="Folder path">
          {crumbs.map((crumb, index) => {
            const current = index === crumbs.length - 1;
            return (
              <Fragment key={crumb.path.join("/") || "root"}>
                {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
                <button
                  type="button"
                  aria-current={current ? "location" : undefined}
                  disabled={current || choosing}
                  onClick={() =>
                    listing && browser.open({ rootId: listing.rootId, path: crumb.path })
                  }
                >
                  {crumb.label}
                </button>
              </Fragment>
            );
          })}
        </nav>

        <div className="browser-folder-picker-body" aria-busy={browser.loading}>
          {browser.error ? (
            <div className="browser-folder-picker-status" role="alert">
              <span>{browser.error}</span>
              <button type="button" className="btn-secondary" onClick={browser.retry}>
                Try again
              </button>
            </div>
          ) : !listing ? (
            <div className="browser-folder-picker-status">Loading folders…</div>
          ) : visibleFolders.length === 0 ? (
            <div className="browser-folder-picker-status">
              {filter.trim() ? "No folders match." : "No folders here."}
            </div>
          ) : (
            <ul className="browser-folder-picker-list" aria-label="Folders">
              {visibleFolders.map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    className="browser-folder-picker-item"
                    disabled={choosing}
                    onClick={() =>
                      browser.open({ rootId: listing.rootId, path: [...listing.path, name] })
                    }
                  >
                    <Folder size={15} aria-hidden="true" />
                    <span>{name}</span>
                    <ChevronRight
                      size={14}
                      aria-hidden="true"
                      className="browser-folder-picker-item-chevron"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {listing?.truncated && !browser.error && (
            <p className="browser-folder-picker-note">
              This folder is large, so only part of it is listed.
            </p>
          )}
        </div>

        {chooseError && (
          <p className="browser-folder-picker-error" role="alert">
            {chooseError}
          </p>
        )}

        <div className="modal-footer">
          <label className="browser-folder-picker-hidden">
            <input
              type="checkbox"
              checked={browser.includeHidden}
              disabled={choosing}
              onChange={(event) => browser.setIncludeHidden(event.target.checked)}
            />
            Show hidden folders
          </label>
          <div className="browser-folder-picker-actions">
            <button type="button" className="btn-secondary" disabled={choosing} onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!listing || busy || Boolean(browser.error)}
              onClick={() => void handleChoose()}
            >
              {choosing ? "Adding…" : "Use this folder"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
