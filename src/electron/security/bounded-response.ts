/** Read decoded response bytes incrementally; never allocate an unbounded body first. */
export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  context: string,
  signal?: AbortSignal,
  options?: { truncate?: boolean },
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        if (!options?.truncate) throw new Error(`${context} exceeds the ${maxBytes}-byte limit`);
        // Keep the leading bytes and stop reading; the finally block cancels the rest.
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        break;
      }
      total += value.byteLength;
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
