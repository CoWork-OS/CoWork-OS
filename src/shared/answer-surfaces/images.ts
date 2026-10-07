/** Image lookups for answer surfaces, shared by the renderer and the main process. */

export type AnswerImageRequest = { query?: string; src?: string };

export type AnswerImageResult = {
  /** A data: URL of a small, verified image. */
  dataUrl: string;
  width?: number;
  height?: number;
  title?: string;
  creator?: string;
  license?: string;
  /** The page that credits the image. */
  sourceUrl?: string;
  provider: "openverse" | "wikimedia" | "web";
};

export const MAX_ANSWER_IMAGE_REQUESTS = 12;

/** A human-readable credit line, e.g. "Photo: Jane Doe · CC BY 2.0 · Openverse". */
export function answerImageCredit(image: AnswerImageResult): string {
  if (image.provider === "web") {
    let host = "";
    try {
      host = image.sourceUrl ? new URL(image.sourceUrl).hostname.replace(/^www\./, "") : "";
    } catch {
      host = "";
    }
    return host ? `Image: ${host}` : "Image from the web";
  }
  const source = image.provider === "openverse" ? "Openverse" : "Wikimedia Commons";
  return [image.creator ? `Photo: ${image.creator}` : "Photo", image.license, source]
    .filter(Boolean)
    .join(" · ");
}
