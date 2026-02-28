import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchMentionsWithRetry } from "../fetch";

const runBirdCommandMock = vi.fn();

vi.mock("../../utils/x-cli", () => ({
  runBirdCommand: (...args: unknown[]) => runBirdCommandMock(...args),
}));

describe("fetchMentionsWithRetry", () => {
  const settings = {
    enabled: true,
    authMethod: "browser",
    mentionTrigger: {
      enabled: true,
      commandPrefix: "do:",
      allowedAuthors: ["almarionai"],
      pollIntervalSec: 120,
      fetchCount: 25,
      workspaceMode: "temporary",
    },
  } as Any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses at least 45s timeout on primary request", async () => {
    runBirdCommandMock.mockResolvedValueOnce({ data: [] });

    await fetchMentionsWithRetry({ ...settings, timeoutMs: 20_000 }, 25);

    expect(runBirdCommandMock).toHaveBeenCalledTimes(1);
    expect(runBirdCommandMock).toHaveBeenCalledWith(
      expect.anything(),
      ["mentions", "-n", "25"],
      expect.objectContaining({ json: true, timeoutMs: 45_000 }),
    );
  });

  it("retries with smaller fetch and longer timeout on timeout error", async () => {
    runBirdCommandMock
      .mockRejectedValueOnce(new Error("Timeout: Unspecified"))
      .mockResolvedValueOnce({ data: [] });

    await fetchMentionsWithRetry(settings, 25);

    expect(runBirdCommandMock).toHaveBeenCalledTimes(2);
    expect(runBirdCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      ["mentions", "-n", "25"],
      expect.objectContaining({ json: true, timeoutMs: 45_000 }),
    );
    expect(runBirdCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ["mentions", "-n", "10"],
      expect.objectContaining({ json: true, timeoutMs: 90_000 }),
    );
  });
});
