import { describe, expect, it, vi } from "vitest";
import { lazyClient } from "../sdk-loaders";

describe("lazyClient", () => {
  it("creates the client once, on the first request", async () => {
    const create = vi.fn(async () => ({ id: "client" }));
    const getClient = lazyClient(create);
    expect(create).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([getClient(), getClient()]);
    expect(first).toBe(second);
    expect(await getClient()).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("tries again after a failed load", async () => {
    const create = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("module failed to load"))
      .mockResolvedValueOnce("client");
    const getClient = lazyClient(create);

    await expect(getClient()).rejects.toThrow("module failed to load");
    await expect(getClient()).resolves.toBe("client");
    expect(create).toHaveBeenCalledTimes(2);
  });
});
