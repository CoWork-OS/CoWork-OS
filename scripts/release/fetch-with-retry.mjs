// Build-time downloads (Go SDK, pinned sources) come from public hosts that
// occasionally answer 5xx or drop the connection. Retry those; a 4xx is a real
// error and fails at once. Callers still verify the checksum of what arrives.

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(
  url,
  {
    attempts = 4,
    baseDelayMs = 2000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.log,
    label = url,
  } = {},
) {
  let lastProblem = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { redirect: "follow" });
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    if (response?.ok) return response;
    if (response && !RETRYABLE_STATUS.has(response.status)) {
      throw new Error(`${label} download failed with HTTP ${response.status}`);
    }
    if (response) lastProblem = `HTTP ${response.status}`;
    if (attempt < attempts) {
      const delay = baseDelayMs * 2 ** (attempt - 1);
      log(
        `[download] ${label}: ${lastProblem}; retrying in ${delay / 1000}s (${attempt}/${attempts})`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`${label} download failed after ${attempts} attempts (${lastProblem})`);
}
