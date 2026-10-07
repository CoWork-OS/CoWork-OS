import { useEffect, useMemo, useState } from "react";
import {
  MAX_ANSWER_IMAGE_REQUESTS,
  type AnswerImageRequest,
  type AnswerImageResult,
} from "../../shared/answer-surfaces/images";
import type { AnswerSurfaceImageRef } from "../../shared/answer-surfaces/schema";

export type AnswerImageStatus =
  | { status: "loading" }
  | { status: "ready"; image: AnswerImageResult }
  | { status: "missing" };

const MAX_CACHED = 300;
/** Resolved photos by request key, shared by every surface (and every remount). */
const resolved = new Map<string, Promise<AnswerImageResult | null>>();

export function answerImageKey(ref: AnswerSurfaceImageRef): string {
  return ref.src ? `src:${ref.src}` : `query:${(ref.query ?? "").trim().toLowerCase()}`;
}

function toRequest(ref: AnswerSurfaceImageRef): AnswerImageRequest {
  return ref.src ? { src: ref.src } : { query: ref.query };
}

function requestImages(refs: AnswerSurfaceImageRef[], taskId?: string): void {
  const missing = refs.filter((ref) => !resolved.has(answerImageKey(ref)));
  for (let start = 0; start < missing.length; start += MAX_ANSWER_IMAGE_REQUESTS) {
    const chunk = missing.slice(start, start + MAX_ANSWER_IMAGE_REQUESTS);
    const call =
      window.electronAPI?.resolveAnswerImages?.({
        ...(taskId ? { taskId } : {}),
        requests: chunk.map(toRequest),
      }) ?? Promise.resolve([]);
    const results = Promise.resolve(call).catch(() => [] as Array<AnswerImageResult | null>);
    chunk.forEach((ref, index) => {
      const key = answerImageKey(ref);
      resolved.set(
        key,
        results.then((list) => list[index] ?? null),
      );
      if (resolved.size > MAX_CACHED) {
        const oldest = resolved.keys().next().value;
        if (oldest && oldest !== key) resolved.delete(oldest);
      }
    });
  }
}

/** Photos for a surface's image references, fetched by the host in one batch. */
export function useAnswerImages(
  refs: AnswerSurfaceImageRef[],
  taskId?: string,
): Map<string, AnswerImageStatus> {
  const keys = useMemo(() => refs.map(answerImageKey), [refs]);
  const keySignature = keys.join("\n");
  const [images, setImages] = useState<Map<string, AnswerImageStatus>>(
    () => new Map(keys.map((key) => [key, { status: "loading" } as const])),
  );

  useEffect(() => {
    if (refs.length === 0) return;
    let cancelled = false;
    requestImages(refs, taskId);
    void Promise.all(
      refs.map(async (ref) => {
        const key = answerImageKey(ref);
        const image = await (resolved.get(key) ?? Promise.resolve(null));
        const status: AnswerImageStatus = image
          ? { status: "ready", image }
          : { status: "missing" };
        return [key, status] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setImages(new Map<string, AnswerImageStatus>(entries));
    });
    return () => {
      cancelled = true;
    };
    // The signature covers `refs`: a new array with the same images must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySignature, taskId]);

  return images;
}
