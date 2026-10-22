import { useEffect, useRef, useState } from "react";
import { Box, Grid3x3, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { createModelStage, type ModelStage, type ModelStats } from "./model-stage";

export interface ModelFileSource {
  /** Workspace-relative or absolute path of a .glb / .gltf. */
  path: string;
  workspacePath?: string;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  return value.toLocaleString();
}

function formatSize([x, y, z]: [number, number, number]): string {
  const largest = Math.max(x, y, z);
  const unit = largest < 1 ? { scale: 100, label: "cm" } : { scale: 1, label: "m" };
  const fmt = (value: number) => (value * unit.scale).toFixed(largest < 1 ? 0 : 2);
  return `${fmt(x)} × ${fmt(y)} × ${fmt(z)} ${unit.label}`;
}

export function describeStats(stats: ModelStats): string {
  const parts = [`${formatCount(stats.triangles)} triangles`, formatSize(stats.size)];
  if (stats.clips.length) {
    parts.push(`${stats.clips.length} animation${stats.clips.length === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

/**
 * Loads one model into a three.js stage with orbit, wireframe, grid and clip controls.
 * The stage (and its WebGL context) exists only while this is mounted.
 */
export function ModelViewer({
  source,
  autoRotate = false,
  className = "",
  onStats,
}: {
  source: ModelFileSource;
  autoRotate?: boolean;
  className?: string;
  onStats?: (stats: ModelStats) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<ModelStage | null>(null);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(autoRotate);
  const [wireframe, setWireframe] = useState(false);
  const [grid, setGrid] = useState(true);
  const [clip, setClip] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const read = window.electronAPI.readModel3d;
    if (!host) return;
    if (!read) {
      setError("3D models can be viewed in the desktop app.");
      return;
    }
    let cancelled = false;
    const stage = createModelStage(host);
    stageRef.current = stage;
    stage.setAutoRotate(autoRotate);
    setStats(null);
    setError(null);
    setClip(0);
    setPaused(false);
    read({ filePath: source.path, workspacePath: source.workspacePath })
      .then((file) => stage.load(copyToArrayBuffer(file.bytes)))
      .then((loaded) => {
        if (cancelled) return;
        setStats(loaded);
        onStatsRef.current?.(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // IPC errors arrive wrapped: "Error invoking remote method 'model3d:read': Error: …"
        setError(message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ""));
      });
    return () => {
      cancelled = true;
      stage.dispose();
      stageRef.current = null;
    };
    // autoRotate is applied live below; a change must not reload the model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.path, source.workspacePath]);

  useEffect(() => stageRef.current?.setAutoRotate(rotating), [rotating]);
  useEffect(() => stageRef.current?.setWireframe(wireframe), [wireframe, stats]);
  useEffect(() => stageRef.current?.setGrid(grid), [grid]);

  const clips = stats?.clips ?? [];

  return (
    <div className={`model-viewer ${className}`.trim()}>
      <div className="model-viewer-stage" ref={hostRef}>
        {!stats && !error && <div className="model-viewer-overlay">Loading model…</div>}
        {error && <div className="model-viewer-overlay model-viewer-error">{error}</div>}
      </div>
      {stats && (
        <div className="model-viewer-toolbar">
          <span
            className="model-viewer-stats"
            title={`${stats.vertices.toLocaleString()} vertices, ${stats.meshes} meshes, ${stats.materials} materials`}
          >
            {describeStats(stats)}
          </span>
          <span className="model-viewer-spacer" />
          {clips.length > 0 && (
            <>
              <select
                className="model-viewer-clip"
                aria-label="Animation"
                value={clip}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setClip(next);
                  setPaused(false);
                  stageRef.current?.playClip(next);
                }}
              >
                {clips.map((name, index) => (
                  <option key={`${index}-${name}`} value={index}>
                    {name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="model-viewer-btn"
                title={paused ? "Play animation" : "Pause animation"}
                aria-label={paused ? "Play animation" : "Pause animation"}
                onClick={() => {
                  stageRef.current?.setPaused(!paused);
                  setPaused(!paused);
                }}
              >
                {paused ? <Play size={14} /> : <Pause size={14} />}
              </button>
            </>
          )}
          <button
            type="button"
            className={`model-viewer-btn${rotating ? " is-on" : ""}`}
            title="Auto-rotate"
            aria-label="Auto-rotate"
            aria-pressed={rotating}
            onClick={() => setRotating((on) => !on)}
          >
            <RotateCw size={14} />
          </button>
          <button
            type="button"
            className={`model-viewer-btn${wireframe ? " is-on" : ""}`}
            title="Wireframe"
            aria-label="Wireframe"
            aria-pressed={wireframe}
            onClick={() => setWireframe((on) => !on)}
          >
            <Box size={14} />
          </button>
          <button
            type="button"
            className={`model-viewer-btn${grid ? " is-on" : ""}`}
            title="Grid"
            aria-label="Grid"
            aria-pressed={grid}
            onClick={() => setGrid((on) => !on)}
          >
            <Grid3x3 size={14} />
          </button>
          <button
            type="button"
            className="model-viewer-btn"
            title="Reset view"
            aria-label="Reset view"
            onClick={() => stageRef.current?.resetView()}
          >
            <RotateCcw size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
