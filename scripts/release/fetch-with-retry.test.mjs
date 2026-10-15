import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "./fetch-with-retry.mjs";

function scripted(...outcomes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return { ok: next >= 200 && next < 300, status: next };
  };
  return { calls, fetchImpl };
}

const quiet = { sleep: async () => {}, log: () => {}, label: "Go SDK" };

test("retries a 502 and returns the next successful response", async () => {
  const { calls, fetchImpl } = scripted(502, 200);
  const response = await fetchWithRetry("https://go.dev/dl/go.zip", { ...quiet, fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
});

test("retries network errors with exponential backoff", async () => {
  const delays = [];
  const { fetchImpl } = scripted(new Error("ECONNRESET"), new Error("ECONNRESET"), 200);
  await fetchWithRetry("https://go.dev/dl/go.zip", {
    ...quiet,
    fetchImpl,
    baseDelayMs: 1000,
    sleep: async (ms) => delays.push(ms),
  });
  assert.deepEqual(delays, [1000, 2000]);
});

test("fails at once on a 404", async () => {
  const { calls, fetchImpl } = scripted(404, 200);
  await assert.rejects(
    fetchWithRetry("https://go.dev/dl/missing.zip", { ...quiet, fetchImpl }),
    /Go SDK download failed with HTTP 404/,
  );
  assert.equal(calls.length, 1);
});

test("gives up after the last attempt and names the last problem", async () => {
  const { calls, fetchImpl } = scripted(503, 503, 502);
  await assert.rejects(
    fetchWithRetry("https://go.dev/dl/go.zip", { ...quiet, fetchImpl, attempts: 3 }),
    /Go SDK download failed after 3 attempts \(HTTP 502\)/,
  );
  assert.equal(calls.length, 3);
});
