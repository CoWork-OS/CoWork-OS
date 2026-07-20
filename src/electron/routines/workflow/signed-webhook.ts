import { createHmac } from "crypto";
import { lookup } from "dns/promises";
import { request } from "https";
import { isIP } from "net";
import { assertNetworkPolicyAllowed } from "../../security/network-policy";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface SignedWebhookRequest {
  url: string;
  method?: string;
  body?: unknown;
  secret: string;
  idempotencyKey: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SignedWebhookResult {
  status: number;
  ok: boolean;
  body: unknown;
  contentType?: string;
}

export async function executeSignedWebhook(
  input: SignedWebhookRequest,
): Promise<SignedWebhookResult> {
  const endpoint = validateSignedWebhookUrl(input.url);
  assertNetworkPolicyAllowed({ url: endpoint.toString(), toolName: "routine_signed_webhook" });
  const addresses = await lookup(endpoint.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("Webhook hostname did not resolve.");
  if (addresses.some((entry) => isDisallowedWebhookAddress(entry.address))) {
    throw new Error(
      "Webhook hostname resolves to a private, loopback, link-local, or metadata address.",
    );
  }

  const method = normalizeWebhookMethod(input.method);
  const body = input.body === undefined ? "" : JSON.stringify(input.body);
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("Webhook request body exceeds the 1 MiB limit.");
  }
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = signWebhookBody(input.secret, timestamp, body);
  const timeoutMs = Math.min(
    Math.max(Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000),
    60_000,
  );
  const pinned = addresses[0];

  return await new Promise<SignedWebhookResult>((resolve, reject) => {
    const outbound = request(
      {
        protocol: "https:",
        hostname: endpoint.hostname,
        port: endpoint.port || 443,
        path: `${endpoint.pathname}${endpoint.search}`,
        method,
        servername: endpoint.hostname,
        headers: {
          Accept: "application/json, text/plain;q=0.9, */*;q=0.5",
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(Buffer.byteLength(body, "utf8")),
          "User-Agent": "CoWork-OS-Automation-Studio/1",
          "X-CoWork-Timestamp": timestamp,
          "X-CoWork-Signature": `sha256=${signature}`,
          "X-CoWork-Idempotency-Key": input.idempotencyKey,
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, pinned.address, pinned.family);
        },
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400) {
          response.resume();
          reject(new Error(`Webhook redirects are not allowed (HTTP ${status}).`));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buffer.length;
          if (received > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Webhook response exceeds the 1 MiB limit."));
            return;
          }
          chunks.push(buffer);
        });
        response.on("error", reject);
        response.on("end", () => {
          const contentType = Array.isArray(response.headers["content-type"])
            ? response.headers["content-type"][0]
            : response.headers["content-type"];
          const text = Buffer.concat(chunks).toString("utf8");
          const parsedBody = parseResponseBody(text, contentType);
          if (status < 200 || status >= 300) {
            reject(
              new Error(`Webhook responded with HTTP ${status}: ${summarizeBody(parsedBody)}`),
            );
            return;
          }
          resolve({ status, ok: true, body: parsedBody, contentType });
        });
      },
    );
    outbound.setTimeout(timeoutMs, () => {
      outbound.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms.`));
    });
    const abort = () =>
      outbound.destroy(
        input.signal?.reason instanceof Error
          ? input.signal.reason
          : new Error("Webhook request was cancelled."),
      );
    input.signal?.addEventListener("abort", abort, { once: true });
    outbound.once("close", () => input.signal?.removeEventListener("abort", abort));
    outbound.on("error", reject);
    if (body) outbound.write(body);
    outbound.end();
  });
}

export function validateSignedWebhookUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("Webhook URL must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("Webhook URL must use HTTPS.");
  if (parsed.username || parsed.password)
    throw new Error("Webhook URL cannot contain credentials.");
  const hostname = parsed.hostname.trim().toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Webhook URL cannot target a local hostname.");
  }
  if (isDisallowedWebhookAddress(hostname)) {
    throw new Error(
      "Webhook URL cannot target a private, loopback, link-local, or metadata address.",
    );
  }
  return parsed;
}

export function normalizeWebhookMethod(value?: string): "POST" | "PUT" | "PATCH" {
  const method = String(value || "POST")
    .trim()
    .toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
    throw new Error("Webhook method must be POST, PUT, or PATCH.");
  }
  return method;
}

export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  if (!secret) throw new Error("Webhook signing secret is required.");
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function isDisallowedWebhookAddress(value: string): boolean {
  const address = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (family === 6) {
    if (address === "::" || address === "::1") return true;
    if (address.startsWith("fc") || address.startsWith("fd") || /^fe[89ab]/.test(address))
      return true;
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isDisallowedWebhookAddress(mapped[1]) : false;
  }
  return false;
}

function parseResponseBody(value: string, contentType?: string): unknown {
  if (!value) return null;
  if (contentType?.toLowerCase().includes("json")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function summarizeBody(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "empty response";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
