import { describe, expect, it, vi } from "vitest";
import { BlueBubblesClient, type BlueBubblesMessage } from "../bluebubbles-client";

const message = (guid: string, dateCreated: number): BlueBubblesMessage => ({
  guid,
  chatGuid: "chat",
  handleId: 1,
  text: guid,
  isFromMe: false,
  isRead: false,
  dateCreated,
});

describe("BlueBubblesClient polling cursor", () => {
  it("keeps same timestamp ties and does not re-emit them after an empty poll", async () => {
    const client = new BlueBubblesClient({ serverUrl: "http://localhost", password: "x" });
    const apiRequest = vi
      .fn()
      .mockResolvedValueOnce({ data: [message("a", 101), message("b", 101)] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [message("a", 101), message("b", 101), message("c", 101)] });
    (client as Any).apiRequest = apiRequest;
    (client as Any).lastMessageDate = 100;
    const received: string[] = [];
    client.on("message", (item) => received.push(item.guid));

    await (client as Any).pollMessages();
    await (client as Any).pollMessages();
    await (client as Any).pollMessages();

    expect(received).toEqual(["a", "b", "c"]);
    expect(apiRequest.mock.calls[0][2]).toMatchObject({ after: 99 });
  });

  it("deduplicates repeated GUIDs across pages", async () => {
    const client = new BlueBubblesClient({ serverUrl: "http://localhost", password: "x" });
    const apiRequest = vi
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, i) => message(`m${i}`, i + 1)),
      })
      .mockResolvedValueOnce({ data: [message("m99", 100), message("m100", 101)] });
    (client as Any).apiRequest = apiRequest;
    const received: string[] = [];
    client.on("message", (item) => received.push(item.guid));
    await (client as Any).pollMessages();
    expect(received).toHaveLength(101);
    expect(new Set(received).size).toBe(101);
  });

  it("stops paginating when a server ignores offset and repeats a full page", async () => {
    const client = new BlueBubblesClient({ serverUrl: "http://localhost", password: "x" });
    const fullPage = Array.from({ length: 100 }, (_, i) => message(`m${i}`, i + 1));
    const apiRequest = vi.fn().mockResolvedValue({ data: fullPage });
    (client as Any).apiRequest = apiRequest;
    const received: string[] = [];
    client.on("message", (item) => received.push(item.guid));
    await (client as Any).pollMessages();
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(100);
  });

  it("coalesces overlapping polls and releases the guard after failure", async () => {
    const client = new BlueBubblesClient({ serverUrl: "http://localhost", password: "x" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apiRequest = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return { data: [message("same", 101)] };
      })
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ data: [message("after-failure", 102)] });
    (client as Any).apiRequest = apiRequest;
    const received: string[] = [];
    client.on("message", (item) => received.push(item.guid));

    const first = (client as Any).pollMessages();
    const second = (client as Any).pollMessages();
    expect(apiRequest).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(received).toEqual(["same"]);

    await expect((client as Any).pollMessages()).rejects.toThrow("temporary failure");
    await (client as Any).pollMessages();
    expect(received).toEqual(["same", "after-failure"]);
  });
});
