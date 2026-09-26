import type * as http from "http";

export const DEFAULT_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

export class WebhookBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Webhook body exceeds ${limit} bytes`);
  }
}

/** Read the raw request body as a Buffer, rejecting bodies over `limitBytes`. */
export function readLimitedBody(
  req: http.IncomingMessage,
  limitBytes = DEFAULT_WEBHOOK_BODY_LIMIT_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > limitBytes) {
        rejected = true;
        reject(new WebhookBodyTooLargeError(limitBytes));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

export function resolveRequestPath(req: http.IncomingMessage): string {
  const url = req.url || "/";
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return url;
  }
}

export function resolveRequestQuery(req: http.IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url || "/", "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Normalize an international phone number to E.164, or return null. A leading
 * `+` or `00` is required: a bare national number has no country code and
 * guessing one could message the wrong person.
 */
export function normalizeE164(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, "");
  const withPlus = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  return /^\+[1-9]\d{6,14}$/.test(withPlus) ? withPlus : null;
}
