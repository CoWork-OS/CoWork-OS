import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

type SnapshotNode = {
  ref: string;
  role: string;
  name: string;
  bounds?: { x: number; y: number; width: number; height: number };
};

type SnapshotOverlayProps = {
  taskId: string;
  sessionId: string;
  tabId: string;
  onCopyRef: (ref: string) => void;
};

/**
 * Boxes for the nodes of the agent's latest browser_snapshot of this tab, with
 * their refs. It shows what the agent saw; it never takes a snapshot itself,
 * so the agent's refs stay valid.
 */
export function SnapshotOverlay({ taskId, sessionId, tabId, onCopyRef }: SnapshotOverlayProps) {
  const [nodes, setNodes] = useState<SnapshotNode[]>([]);
  const [status, setStatus] = useState("Loading snapshot…");

  const load = useCallback(async () => {
    const getSnapshot = window.electronAPI.getBrowserWorkbenchSnapshot;
    if (!getSnapshot) return;
    try {
      const snapshot = await getSnapshot({ taskId, sessionId, tabId });
      if (!snapshot || !snapshot.snapshotId) {
        setNodes([]);
        setStatus("No snapshot yet. Boxes appear after CoWork calls browser_snapshot on this tab.");
        return;
      }
      setNodes(snapshot.nodes || []);
      setStatus(
        snapshot.stale
          ? `Snapshot is out of date (${snapshot.staleReason || "the page changed"}).`
          : `${snapshot.nodes.length} visible nodes from the latest snapshot.`,
      );
    } catch {
      setStatus("Snapshot unavailable.");
    }
  }, [sessionId, tabId, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="browser-workbench-snapshot-overlay">
      {nodes.map((node) =>
        node.bounds ? (
          <button
            key={node.ref}
            type="button"
            className="browser-workbench-snapshot-box"
            style={{
              left: node.bounds.x,
              top: node.bounds.y,
              width: node.bounds.width,
              height: node.bounds.height,
            }}
            title={`${node.role} "${node.name}" — click to copy ${node.ref}`}
            onClick={() => onCopyRef(node.ref)}
          >
            <span>{node.ref.split(":").pop()}</span>
          </button>
        ) : null,
      )}
      <div className="browser-workbench-snapshot-status">
        <span>{status}</span>
        <button type="button" title="Refresh" onClick={() => void load()}>
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
