import { isTopModal, useModalDialog } from "./ModalDialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Copy,
  ExternalLink,
  FolderOpen,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  RotateCcw,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import "./image-lightbox.css";
import "./video-lightbox.css";

type VideoLightboxProps = {
  /** Playback source. When empty the lightbox shows a loading state. */
  src?: string;
  poster?: string;
  fileName?: string;
  /** Short format label, e.g. "MP4". */
  formatLabel?: string;
  /** Human-readable file size, e.g. "2.2 MB". */
  sizeLabel?: string;
  onClose: () => void;
  onCopyPath?: () => Promise<void> | void;
  onShowInFinder?: () => void;
  onOpenExternal?: () => void;
};

export type VideoShortcut =
  | { type: "toggle" }
  | { type: "seek"; by: number }
  | { type: "seekFraction"; value: number }
  | { type: "frame"; direction: 1 | -1 }
  | { type: "volume"; by: number }
  | { type: "mute" }
  | { type: "fullscreen" }
  | { type: "loop" };

const PLAYBACK_RATES = [1, 1.25, 1.5, 2, 0.5];
const FRAME_SECONDS = 1 / 30;
const IDLE_MS = 2200;

/** "0:02", "1:05", "1:02:09". */
export function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Keyboard shortcut for a key, following common video player conventions. */
export function resolveVideoShortcut(key: string): VideoShortcut | null {
  switch (key) {
    case " ":
    case "k":
    case "K":
      return { type: "toggle" };
    case "ArrowLeft":
      return { type: "seek", by: -5 };
    case "ArrowRight":
      return { type: "seek", by: 5 };
    case "j":
    case "J":
      return { type: "seek", by: -10 };
    case "l":
    case "L":
      return { type: "seek", by: 10 };
    case "ArrowUp":
      return { type: "volume", by: 0.1 };
    case "ArrowDown":
      return { type: "volume", by: -0.1 };
    case ",":
      return { type: "frame", direction: -1 };
    case ".":
      return { type: "frame", direction: 1 };
    case "m":
    case "M":
      return { type: "mute" };
    case "f":
    case "F":
      return { type: "fullscreen" };
    case "r":
    case "R":
      return { type: "loop" };
    case "Home":
      return { type: "seekFraction", value: 0 };
    case "End":
      return { type: "seekFraction", value: 1 };
    default:
      if (/^[0-9]$/.test(key)) return { type: "seekFraction", value: Number(key) / 10 };
      return null;
  }
}

export function nextPlaybackRate(rate: number): number {
  const index = PLAYBACK_RATES.indexOf(rate);
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Full-viewport video player that matches ImageLightbox: dimmed, blurred backdrop with the
 * video floating in the middle and a single floating control bar that fades out while playing.
 */
export function VideoLightbox({
  src,
  poster,
  fileName,
  formatLabel,
  sizeLabel,
  onClose,
  onCopyPath,
  onShowInFinder,
  onOpenExternal,
}: VideoLightboxProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const scrubRef = useRef<{ resume: boolean } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);

  const label = fileName || "Video";
  const pipSupported = typeof document !== "undefined" && Boolean(document.pictureInPictureEnabled);

  // Esc leaves fullscreen first, then closes the viewer.
  const handleClose = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    onClose();
  }, [onClose]);
  useModalDialog(rootRef, handleClose);

  // Start with focus on the dialog itself so Space plays instead of pressing the first button.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    setPlaying(false);
    setEnded(false);
    setCurrentTime(0);
    setDuration(0);
    setBufferedEnd(0);
    setDimensions(null);
    setPlaybackError(false);
  }, [src]);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  // timeupdate fires only a few times a second; follow frames while playing so the bar is smooth.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) setCurrentTime(video.currentTime);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    const handleChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || playbackError) return;
    if (video.paused || video.ended) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [playbackError]);

  const seekTo = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    const next = Math.min(video.duration, Math.max(0, time));
    video.currentTime = next;
    setCurrentTime(next);
  }, []);

  const changeVolume = useCallback((next: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = clamp01(next);
    video.muted = video.volume === 0;
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.muted && video.volume === 0) video.volume = 0.6;
    video.muted = !video.muted;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void root.requestFullscreen?.().catch(() => {});
    }
  }, []);

  const togglePip = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => {});
    } else {
      void video.requestPictureInPicture?.().catch(() => {});
    }
  }, []);

  const toggleLoop = useCallback(() => setLoop((value) => !value), []);

  const cycleRate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = nextPlaybackRate(video.playbackRate);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopModal(rootRef.current) || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const shortcut = resolveVideoShortcut(event.key);
      const video = videoRef.current;
      if (!shortcut || !video) return;
      event.preventDefault();
      wake();
      switch (shortcut.type) {
        case "toggle":
          togglePlay();
          break;
        case "seek":
          seekTo(video.currentTime + shortcut.by);
          break;
        case "seekFraction":
          seekTo(video.duration * shortcut.value);
          break;
        case "frame":
          video.pause();
          seekTo(video.currentTime + shortcut.direction * FRAME_SECONDS);
          break;
        case "volume":
          changeVolume((video.muted ? 0 : video.volume) + shortcut.by);
          break;
        case "mute":
          toggleMute();
          break;
        case "fullscreen":
          toggleFullscreen();
          break;
        case "loop":
          toggleLoop();
          break;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [changeVolume, seekTo, toggleFullscreen, toggleLoop, toggleMute, togglePlay, wake]);

  const fractionAt = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? clamp01((clientX - rect.left) / rect.width) : 0;
  };

  const handleTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (event.button !== 0 || !video || !duration) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubRef.current = { resume: !video.paused && !video.ended };
    video.pause();
    setScrubbing(true);
    seekTo(fractionAt(event.clientX) * duration);
  };

  const handleTrackPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const fraction = fractionAt(event.clientX);
    setHoverFraction(fraction);
    if (scrubRef.current && duration) seekTo(fraction * duration);
  };

  const endScrub = () => {
    const scrub = scrubRef.current;
    scrubRef.current = null;
    setScrubbing(false);
    if (scrub?.resume) void videoRef.current?.play().catch(() => {});
  };

  const handleCopyPath = async () => {
    if (!onCopyPath) return;
    try {
      await onCopyPath();
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // The caller reports its own failure.
    }
  };

  const syncBuffered = (video: HTMLVideoElement) => {
    const ranges = video.buffered;
    setBufferedEnd(ranges.length > 0 ? ranges.end(ranges.length - 1) : 0);
  };

  const progress = duration > 0 ? clamp01(currentTime / duration) : 0;
  const buffered = duration > 0 ? clamp01(bufferedEnd / duration) : 0;
  const effectiveVolume = muted ? 0 : volume;
  const VolumeIcon = effectiveVolume === 0 ? VolumeX : effectiveVolume < 0.5 ? Volume1 : Volume2;
  const controlsHidden = idle && playing && !scrubbing;

  const metaLine = [
    formatLabel,
    dimensions ? `${dimensions.width}×${dimensions.height}` : null,
    duration > 0 ? formatVideoTime(duration) : null,
    sizeLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  return createPortal(
    <div
      ref={rootRef}
      className="image-lightbox video-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      data-idle={controlsHidden ? "true" : undefined}
      onPointerMove={wake}
      onPointerDown={wake}
      onClick={(event) => {
        // The portal still bubbles through the React tree, e.g. to a card around the preview.
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="image-lightbox-topbar" onClick={(event) => event.stopPropagation()}>
        <div className="image-lightbox-title">
          <span className="image-lightbox-filename" title={label}>
            {label}
          </span>
          {metaLine && <span className="image-lightbox-meta">{metaLine}</span>}
        </div>
        <div className="image-lightbox-actions">
          {onCopyPath && (
            <button
              type="button"
              className="image-lightbox-btn"
              onClick={handleCopyPath}
              title={copied ? "Copied" : "Copy file path"}
              aria-label="Copy file path"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          )}
          {onShowInFinder && (
            <button
              type="button"
              className="image-lightbox-btn"
              onClick={onShowInFinder}
              title="Show in Finder"
              aria-label="Show in Finder"
            >
              <FolderOpen size={16} />
            </button>
          )}
          {onOpenExternal && (
            <button
              type="button"
              className="image-lightbox-btn"
              onClick={onOpenExternal}
              title="Open in default app"
              aria-label="Open in default app"
            >
              <ExternalLink size={16} />
            </button>
          )}
          <span className="image-lightbox-divider" aria-hidden="true" />
          <button
            type="button"
            className="image-lightbox-btn"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close video player"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="image-lightbox-stage video-lightbox-stage">
        {!src ? (
          <div className="image-lightbox-spinner" aria-label="Loading video" />
        ) : playbackError ? (
          <div className="video-lightbox-error" onClick={(event) => event.stopPropagation()}>
            <p className="video-lightbox-error-title">This video can't be played here</p>
            <p className="video-lightbox-error-detail">
              The format or codec isn't supported by the built-in player.
            </p>
            {onOpenExternal && (
              <button type="button" className="video-lightbox-error-btn" onClick={onOpenExternal}>
                <ExternalLink size={14} />
                Open in default app
              </button>
            )}
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              key={src}
              src={src}
              poster={poster}
              className="video-lightbox-video"
              autoPlay
              playsInline
              preload="auto"
              loop={loop}
              onClick={(event) => {
                event.stopPropagation();
                togglePlay();
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                toggleFullscreen();
              }}
              onPlay={() => {
                setPlaying(true);
                setEnded(false);
                wake();
              }}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                setPlaying(false);
                setEnded(true);
              }}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                if (Number.isFinite(video.duration)) setDuration(video.duration);
                if (video.videoWidth && video.videoHeight) {
                  setDimensions({ width: video.videoWidth, height: video.videoHeight });
                }
              }}
              onDurationChange={(event) => {
                const next = event.currentTarget.duration;
                if (Number.isFinite(next)) setDuration(next);
              }}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onProgress={(event) => syncBuffered(event.currentTarget)}
              onVolumeChange={(event) => {
                setVolume(event.currentTarget.volume);
                setMuted(event.currentTarget.muted);
              }}
              onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
              onError={() => setPlaybackError(true)}
            />
            {!playing && !scrubbing && (
              <div className="video-lightbox-center" aria-hidden="true">
                {ended ? <RotateCcw size={26} /> : <Play size={28} className="is-play" />}
              </div>
            )}
          </>
        )}
      </div>

      {src && !playbackError && (
        <div
          className="video-lightbox-controls"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="image-lightbox-btn video-lightbox-play"
            onClick={togglePlay}
            title={playing ? "Pause (Space)" : ended ? "Replay (Space)" : "Play (Space)"}
            aria-label={playing ? "Pause" : ended ? "Replay" : "Play"}
          >
            {playing ? (
              <Pause size={16} fill="currentColor" />
            ) : ended ? (
              <RotateCcw size={16} />
            ) : (
              <Play size={16} fill="currentColor" />
            )}
          </button>

          <span className="video-lightbox-time">{formatVideoTime(currentTime)}</span>

          <div
            ref={trackRef}
            className="video-lightbox-track"
            data-scrubbing={scrubbing ? "true" : undefined}
            role="slider"
            tabIndex={-1}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(currentTime)}
            aria-valuetext={`${formatVideoTime(currentTime)} of ${formatVideoTime(duration)}`}
            onPointerDown={handleTrackPointerDown}
            onPointerMove={handleTrackPointerMove}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
            onPointerLeave={() => setHoverFraction(null)}
          >
            <div className="video-lightbox-rail">
              <div
                className="video-lightbox-buffered"
                style={{ transform: `scaleX(${buffered})` }}
              />
              {hoverFraction !== null && !scrubbing && (
                <div
                  className="video-lightbox-hover"
                  style={{ transform: `scaleX(${hoverFraction})` }}
                />
              )}
              <div
                className="video-lightbox-progress"
                style={{ transform: `scaleX(${progress})` }}
              />
            </div>
            <div className="video-lightbox-thumb" style={{ left: `${progress * 100}%` }} />
            {hoverFraction !== null && duration > 0 && (
              <div className="video-lightbox-tooltip" style={{ left: `${hoverFraction * 100}%` }}>
                {formatVideoTime(hoverFraction * duration)}
              </div>
            )}
          </div>

          <span className="video-lightbox-time is-muted">{formatVideoTime(duration)}</span>

          <span className="image-lightbox-divider" aria-hidden="true" />

          <button
            type="button"
            className="video-lightbox-rate"
            onClick={cycleRate}
            title="Playback speed"
            aria-label={`Playback speed ${rate}×`}
          >
            {rate}×
          </button>
          <button
            type="button"
            className="image-lightbox-btn"
            onClick={toggleLoop}
            data-active={loop ? "true" : undefined}
            aria-pressed={loop}
            title={loop ? "Loop on (R)" : "Loop off (R)"}
            aria-label="Loop"
          >
            <Repeat size={15} />
          </button>
          <div className="video-lightbox-volume">
            <button
              type="button"
              className="image-lightbox-btn"
              onClick={toggleMute}
              title={effectiveVolume === 0 ? "Unmute (M)" : "Mute (M)"}
              aria-label={effectiveVolume === 0 ? "Unmute" : "Mute"}
            >
              <VolumeIcon size={16} />
            </button>
            <input
              type="range"
              className="video-lightbox-volume-slider"
              min={0}
              max={1}
              step={0.05}
              value={effectiveVolume}
              aria-label="Volume"
              style={{ backgroundSize: `${effectiveVolume * 100}% 100%` }}
              onChange={(event) => changeVolume(Number(event.currentTarget.value))}
            />
          </div>
          {pipSupported && (
            <button
              type="button"
              className="image-lightbox-btn"
              onClick={togglePip}
              title="Picture in picture"
              aria-label="Picture in picture"
            >
              <PictureInPicture2 size={15} />
            </button>
          )}
          <button
            type="button"
            className="image-lightbox-btn"
            onClick={toggleFullscreen}
            title={fullscreen ? "Exit full screen (F)" : "Full screen (F)"}
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          >
            {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
