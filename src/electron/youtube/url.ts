const YOUTUBE_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

export function extractYouTubeVideoId(input: string): string | null {
  const value = String(input || "").trim();
  if (!value) return null;
  if (YOUTUBE_ID_PATTERN.test(value)) return value;

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0] || "";
      return YOUTUBE_ID_PATTERN.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const watchId = parsed.searchParams.get("v") || "";
      if (YOUTUBE_ID_PATTERN.test(watchId)) return watchId;
      const parts = parsed.pathname.split("/").filter(Boolean);
      const candidate =
        parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live" ? parts[1] || "" : "";
      return YOUTUBE_ID_PATTERN.test(candidate) ? candidate : null;
    }
  } catch {
    const match = value.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([a-zA-Z0-9_-]{11})/);
    return match?.[1] || null;
  }

  return null;
}

export function buildYouTubeWatchUrl(videoId: string, startMs?: number): string {
  const base = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs <= 0) return base;
  return `${base}&t=${Math.max(0, Math.floor(startMs / 1000))}s`;
}
