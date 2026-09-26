import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-model-metadata-"));
vi.mock("../../../utils/user-data-dir", () => ({ getUserDataDir: () => userDataDir }));

import { resetRuntimeModelMetadata, resolveModelMetadata } from "../../../../shared/model-metadata";
import { refreshModelMetadataNow } from "../model-metadata-refresh";
import { toLiveModelMetadata } from "../openrouter-provider";

function catalogue(modelCount: number, opusInput = 4) {
  const models: Record<string, unknown> = {
    "claude-opus-4-6": { cost: { input: opusInput, output: 20 }, limit: { context: 1_000_000 } },
  };
  for (let i = 0; i < modelCount; i += 1) models[`filler-${i}`] = { cost: { input: 1, output: 1 } };
  return { anthropic: { models } };
}

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

beforeEach(() => resetRuntimeModelMetadata());
afterEach(() => {
  resetRuntimeModelMetadata();
  fs.rmSync(path.join(userDataDir, "model-metadata-cache.json"), { force: true });
});

describe("refreshModelMetadataNow", () => {
  it("applies and caches a fresh catalogue without sending identifiers", async () => {
    const fetchImpl = fakeFetch(catalogue(300));
    const result = await refreshModelMetadataNow(fetchImpl);

    expect(result.modelCount).toBe(301);
    expect(resolveModelMetadata("claude-opus-4-6")?.input).toBe(4);
    expect(fs.existsSync(path.join(userDataDir, "model-metadata-cache.json"))).toBe(true);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://models.dev/api.json");
    expect(init.headers).toEqual({ accept: "application/json" });
  });

  it("keeps current data when the catalogue looks truncated or the request fails", async () => {
    await expect(refreshModelMetadataNow(fakeFetch(catalogue(10, 99)))).rejects.toThrow(/only/);
    await expect(refreshModelMetadataNow(fakeFetch({}, 503))).rejects.toThrow(/503/);
    expect(resolveModelMetadata("claude-opus-4-6")?.input).toBe(5);
  });
});

describe("OpenRouter live metadata", () => {
  it("converts per-token prices to per-million and skips router-dependent pricing", () => {
    const live = toLiveModelMetadata([
      {
        id: "anthropic/claude-opus-4.6",
        context_length: 1_000_000,
        pricing: { prompt: "0.000005", completion: "0.000025", input_cache_read: "0.0000005" },
      },
      { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
    ]);
    expect(live["anthropic/claude-opus-4.6"]).toEqual({
      provider: "openrouter-live",
      input: 5,
      output: 25,
      cacheRead: 0.5,
      context: 1_000_000,
    });
    expect(live["openrouter/auto"]).toBeUndefined();
  });
});
