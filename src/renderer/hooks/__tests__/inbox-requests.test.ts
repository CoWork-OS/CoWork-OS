import { describe, expect, it } from "vitest";
import { InboxRequests } from "../useInboxRequests";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("InboxRequests", () => {
  it("keeps B displayed when an older A response arrives last", async () => {
    const scope = new InboxRequests();
    scope.activate();
    let selected = "A";
    let displayed = "";
    const read = async (id: string, response: Promise<string>) => {
      const current = scope.capture("thread", () => selected === id);
      const detail = await response;
      if (current()) displayed = detail;
    };
    const a = deferred<string>();
    const b = deferred<string>();
    const first = read("A", a.promise);
    selected = "B";
    const second = read("B", b.promise);
    b.resolve("B");
    await second;
    a.resolve("A");
    await first;
    expect(displayed).toBe("B");
  });

  it("discards a list response when filters change before another request starts", () => {
    const scope = new InboxRequests();
    scope.activate();
    let account = "personal";
    const current = scope.capture("threads", () => account === "personal");
    account = "work";
    expect(current()).toBe(false);
  });

  it("does not resurrect work from the previous mount in StrictMode", () => {
    const scope = new InboxRequests();
    scope.activate();
    const initialize = scope.capture("initialize");
    const background = scope.capture("backgroundSync");
    scope.deactivate();
    scope.activate();
    expect(initialize()).toBe(false);
    expect(background()).toBe(false);
    expect(scope.capture("initialize")()).toBe(true);
  });

  it("allows independent status and list reads while rejecting an older list", () => {
    const scope = new InboxRequests();
    scope.activate();
    const status = scope.capture("status");
    const first = scope.capture("threads");
    const second = scope.capture("threads");
    expect([status(), first(), second()]).toEqual([true, false, true]);
  });
});
