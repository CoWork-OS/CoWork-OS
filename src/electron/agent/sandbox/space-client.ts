import { BoundedOutputBuffer } from "./bounded-output";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export type SpaceRecord = Record<string, unknown>;
export function spaceRecord(value: unknown): SpaceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid SPACE object");
  return value as SpaceRecord;
}

export function spaceBaseUrl(value: string | undefined): string {
  if (!value) throw new Error("SPACE connection requires API and data-plane URLs on the host");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/", "/api", "/api/"].includes(url.pathname) ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error(
      "SPACE URLs require HTTPS (HTTP only on loopback), without credentials or query",
    );
  }
  return url.href.replace(/\/$/, "");
}

export function spaceId(value: unknown, prefix: "sbx" | "op" | "proc"): string {
  if (
    typeof value !== "string" ||
    !new RegExp(
      `^${prefix}_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
    ).test(value)
  ) {
    throw new Error(`SPACE returned an invalid ${prefix} identity`);
  }
  return value;
}

export class SpaceHttpError extends Error {
  constructor(readonly status: number) {
    super(`SPACE HTTP ${status}`);
  }
}

/** No automatic retries, redirects, inherited proxies, or vendor error-body logging. */
export class SpaceClient {
  readonly apiUrl: string;
  readonly dataPlaneUrl: string;
  private readonly token: string;

  constructor() {
    this.apiUrl = spaceBaseUrl(process.env.COWORK_SPACE_API_URL);
    this.dataPlaneUrl = spaceBaseUrl(process.env.COWORK_SPACE_DATA_PLANE_URL);
    this.token = process.env.COWORK_SPACE_API_TOKEN || "";
    if (!this.token.trim() || /[\r\n]/.test(this.token)) {
      throw new Error("SPACE requires COWORK_SPACE_API_TOKEN on the host");
    }
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
    signal?: AbortSignal,
  ): Promise<SpaceRecord> {
    if (!path.startsWith("/v1/") || path.includes("..")) throw new Error("Invalid SPACE API path");
    const boundedSignal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]);
    try {
      const response = await directRequest(this.apiUrl + path, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: boundedSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SpaceHttpError(response.status);
      }
      const text = await readBounded(response, 1024 * 1024);
      const result = JSON.parse(text);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("Invalid SPACE response");
      }
      return spaceRecord(result);
    } catch (error) {
      throw boundedSignal.aborted ? boundedSignal.reason : error;
    }
  }

  async wait(path: string, target: string, signal?: AbortSignal): Promise<void> {
    signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const result = await this.request("GET", path, undefined, undefined, signal);
      if (result.state === target) return;
      if (
        typeof result.state === "string" &&
        ["failed", "canceled", "cancelled", "expired", "deleted", "stopped"].includes(result.state)
      ) {
        throw new Error("SPACE lifecycle operation did not succeed");
      }
      await new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("SPACE cancelled"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 250);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw new Error("SPACE lifecycle deadline exceeded");
  }

  async stream(
    command: SpaceRecord,
    timeout: number,
    cap: number,
    signal: AbortSignal,
    checkpoint: (stdout: string, stderr: string) => void,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
    killed: boolean;
    timedOut: boolean;
  }> {
    const sessionId = spaceId(command.session_id, "proc");
    const expected = `${this.dataPlaneUrl}/v1/sessions/${sessionId}/events`;
    const attach = spaceRecord(command.attach);
    const relative = new URL(expected).pathname;
    if (
      !attach ||
      typeof attach.events_url !== "string" ||
      ![expected, relative].includes(attach.events_url) ||
      typeof attach.token !== "string" ||
      !attach.token ||
      /[\r\n]/.test(attach.token)
    ) {
      throw new Error("SPACE attachment destination or credential is invalid");
    }
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout + 5000)]);
    try {
      const response = await directRequest(expected, {
        redirect: "error",
        headers: { Authorization: `Bearer ${attach.token}`, Accept: "text/event-stream" },
        signal: boundedSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SpaceHttpError(response.status);
      }
      if (
        !response.headers.get("content-type")?.startsWith("text/event-stream") ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new Error("SPACE did not return an event stream");
      }
      const stdout = new BoundedOutputBuffer(cap);
      const stderr = new BoundedOutputBuffer(cap);
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let pending = "";
      let data: string[] = [];
      let frameSize = 0;
      let sequence = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end).replace(/\r$/, "");
            pending = pending.slice(end + 1);
            if (line === "" && data.length) {
              const frame = spaceRecord(JSON.parse(data.join("\n")));
              data = [];
              frameSize = 0;
              if (
                typeof frame.type === "string" &&
                ["error", "resync_required"].includes(frame.type)
              ) {
                throw new Error("SPACE stream is incomplete or contradictory; outcome unknown");
              }
              if (frame.type === "stdout" || frame.type === "stderr") {
                if (frame.seq !== ++sequence)
                  throw new Error("SPACE output sequence gap; outcome unknown");
                const bytes = decodeSpaceBase64(frame.data_base64);
                (frame.type === "stdout" ? stdout : stderr).append(
                  (frame.type === "stdout" ? stdoutDecoder : stderrDecoder).write(bytes),
                );
                checkpoint(stdout.toString(), stderr.toString());
              } else if (frame.type === "process_exited") {
                if (
                  typeof frame.exit_code !== "number" ||
                  !Number.isInteger(frame.exit_code) ||
                  frame.process_id !== command.process_id ||
                  typeof frame.status !== "string" ||
                  !["exited", "signaled", "timed_out"].includes(frame.status)
                )
                  throw new Error("Invalid SPACE exit status");
                stdout.append(stdoutDecoder.end());
                stderr.append(stderrDecoder.end());
                checkpoint(stdout.toString(), stderr.toString());
                // A validated terminal event is authoritative. The SSE transport
                // may stay open or fail after completion; neither reopens the command.
                return {
                  stdout: stdout.toString(),
                  stderr: stderr.toString(),
                  exitCode: frame.status === "exited" ? frame.exit_code : frame.exit_code || 1,
                  truncated: stdout.truncated || stderr.truncated,
                  killed: frame.status === "signaled" || frame.status === "timed_out",
                  timedOut: frame.status === "timed_out",
                };
              }
            } else if (line.startsWith("data:")) {
              frameSize += line.length;
              if (frameSize > 2 * 1024 * 1024) throw new Error("SPACE event exceeds size limit");
              data.push(line.slice(5).replace(/^ /, ""));
            }
          }
          if (pending.length > 2 * 1024 * 1024) throw new Error("SPACE event exceeds size limit");
          if (done) break;
        }
        throw new Error("SPACE stream ended without a complete exit event; outcome unknown");
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch (error) {
      throw boundedSignal.aborted ? boundedSignal.reason : error;
    }
  }
}

/** Use core HTTP directly so NODE_USE_ENV_PROXY/global fetch dispatchers cannot
 * forward credentials through inherited proxies. Redirects are never followed. */
function directRequest(
  url: string,
  options: {
    method?: string;
    redirect?: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (url.startsWith("https:") ? httpsRequest : httpRequest)(
      url,
      {
        method: options.method || "GET",
        headers: options.headers,
        signal: options.signal,
      },
      (incoming) => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const status = incoming.statusCode || 500;
          if ([204, 205, 304].includes(status)) incoming.resume();
          resolve(
            new Response(
              [204, 205, 304].includes(status)
                ? null
                : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
              { status, headers },
            ),
          );
        } catch {
          incoming.destroy();
          reject(new Error("Invalid SPACE HTTP response"));
        }
      },
    );
    request.once("error", (error) =>
      reject(options.signal.aborted ? options.signal.reason : error),
    );
    request.end(options.body);
  });
}

export function decodeSpaceBase64(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("Invalid SPACE base64 data");
  }
  return Buffer.from(value, "base64");
}

async function readBounded(response: Response, cap: number): Promise<string> {
  if (!response.body) throw new Error("Empty SPACE response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString("utf8");
      size += value.length;
      if (size > cap) throw new Error("SPACE response exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
