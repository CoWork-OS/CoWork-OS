import type { ChronicleBufferedFrame, ChronicleResolvedContext } from "./types";

function normalizeText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function queryOverlapScore(haystack: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      matches += 1;
    }
  }
  return matches / queryTokens.length;
}

function getRecencyScore(capturedAt: number): number {
  const ageMs = Math.max(0, Date.now() - capturedAt);
  const ageMinutes = ageMs / 60_000;
  return Math.max(0, 1 - Math.min(ageMinutes / 10, 1));
}

function hasScreenReference(query: string): boolean {
  return /\b(this|that|on screen|same doc|latest draft|failing one|what is this|why is this failing|right side|left side|top right|top left|bottom right|bottom left)\b/i.test(
    query,
  );
}

export class ChronicleSelector {
  static rank(
    frames: ChronicleBufferedFrame[],
    query: string,
    limit = 5,
  ): ChronicleResolvedContext[] {
    const normalizedQuery = normalizeText(query);
    const queryTokens = tokenize(normalizedQuery);
    const vagueScreenReference = hasScreenReference(normalizedQuery);

    return frames
      .map((frame) => {
        const appTitle = normalizeText(`${frame.appName} ${frame.windowTitle}`);
        const ocrText = normalizeText(frame.localTextSnippet);
        const appScore = queryOverlapScore(appTitle, queryTokens);
        const ocrScore = queryOverlapScore(ocrText, queryTokens);
        const recencyScore = getRecencyScore(frame.capturedAt);
        const confidenceBase =
          queryTokens.length === 0
            ? recencyScore
            : appScore * 0.35 + ocrScore * 0.45 + recencyScore * 0.2;
        const confidence = Math.max(
          0,
          Math.min(1, confidenceBase + (vagueScreenReference ? 0.08 : 0)),
        );

        return {
          observationId: frame.id,
          capturedAt: frame.capturedAt,
          displayId: frame.displayId,
          appName: frame.appName,
          windowTitle: frame.windowTitle,
          imagePath: frame.imagePath,
          localTextSnippet: frame.localTextSnippet || "",
          confidence: Number(confidence.toFixed(3)),
          usedFallback: false,
          provenance: "untrusted_screen_text",
          sourceRef: frame.sourceRef || null,
          width: frame.width,
          height: frame.height,
        } satisfies ChronicleResolvedContext;
      })
      .sort((a, b) => b.confidence - a.confidence || b.capturedAt - a.capturedAt)
      .slice(0, Math.max(1, limit));
  }

  static shouldFallback(results: ChronicleResolvedContext[], query: string): boolean {
    if (results.length === 0) return true;
    if (!normalizeText(query)) return false;
    return (results[0]?.confidence || 0) < 0.32;
  }
}
