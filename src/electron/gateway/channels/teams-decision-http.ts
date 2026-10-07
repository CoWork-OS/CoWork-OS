/**
 * One card publication per client. The installed connector ignores noRetryPolicy and
 * runs its compatibility policies outside retries, so fence at the HTTP boundary.
 */
export function createTeamsDecisionHttpClient() {
  let attempted = false;
  return {
    async sendRequest(request: Any): Promise<Any> {
      if (attempted) throw new Error("Teams decision publication is ambiguous; retry refused");
      if (request.method !== "POST" || typeof request.body !== "string")
        throw new Error("Unsupported Teams decision publication");
      attempted = true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timeout = setTimeout(abort, 15000);
      if (request.abortSignal?.aborted) abort();
      request.abortSignal?.addEventListener("abort", abort);
      try {
        const response = await fetch(request.url, {
          method: "POST",
          headers: request.headers.toJson(),
          body: request.body,
          signal: controller.signal,
          redirect: "error",
        });
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) {
              await reader.cancel();
              throw new Error("Teams decision response exceeds limit");
            }
            chunks.push(value);
          }
        }
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return {
          request,
          status: response.status,
          bodyAsText: Buffer.concat(chunks).toString("utf8"),
          headers: { toJson: () => headers },
        };
      } finally {
        clearTimeout(timeout);
        request.abortSignal?.removeEventListener("abort", abort);
      }
    },
  };
}
