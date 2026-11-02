import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SPILL_PAGE_MAX_CHARS,
  SPILL_TTL_MS,
  ToolResultSpillStore,
  type ToolResultSpillPage,
} from "../tool-result-spill-store";

let rootDir: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-spill-test-"));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function page(result: ReturnType<ToolResultSpillStore["read"]>): ToolResultSpillPage {
  if (!result.success) throw new Error(result.error);
  return result;
}

describe("ToolResultSpillStore", () => {
  it("serves a spilled text page by page until next_offset is null", () => {
    const store = new ToolResultSpillStore({ rootDir });
    const text = Array.from({ length: 4000 }, (_, index) => `line ${index}`).join("\n");
    expect(store.write("task-1", new Map([["sp0123456789ab", text]]))).toBe(true);

    let offset: number | null = 0;
    let rebuilt = "";
    let pages = 0;
    while (offset !== null) {
      const next = page(store.read("task-1", "sp0123456789ab", offset, 5000));
      expect(next.total_chars).toBe(text.length);
      rebuilt += next.content;
      offset = next.next_offset;
      pages += 1;
    }
    expect(rebuilt).toBe(text);
    expect(pages).toBe(Math.ceil(text.length / 5000));
  });

  it("caps page length and keeps a page's escaped size bounded", () => {
    const store = new ToolResultSpillStore({ rootDir });
    store.write("task-1", new Map([["sp0123456789ab", "\u0001".repeat(50_000)]]));
    const first = page(store.read("task-1", "sp0123456789ab", 0, 1_000_000));
    expect(first.length).toBeLessThanOrEqual(SPILL_PAGE_MAX_CHARS);
    expect(JSON.stringify(first.content).length).toBeLessThanOrEqual(24_000);
    expect(first.next_offset).toBe(first.length);
  });

  it("never splits a surrogate pair and always moves forward", () => {
    const store = new ToolResultSpillStore({ rootDir });
    const text = "a😀b";
    store.write("task-1", new Map([["sp0123456789ab", text]]));
    const first = page(store.read("task-1", "sp0123456789ab", 0, 2));
    expect(first.content).toBe("a");
    const second = page(store.read("task-1", "sp0123456789ab", first.next_offset!, 1));
    expect(second.content).toBe("😀");
    expect(second.next_offset).toBe(3);
  });

  it("keeps spills private to the task that wrote them", () => {
    const store = new ToolResultSpillStore({ rootDir });
    store.write("task-1", new Map([["sp0123456789ab", "secret output"]]));
    const other = store.read("task-2", "sp0123456789ab");
    expect(other.success).toBe(false);
    expect(other.success === false && other.expired).toBe(true);
  });

  it("rejects handles that are not spill handles", () => {
    const store = new ToolResultSpillStore({ rootDir });
    expect(store.write("task-1", new Map([["../escape", "x"]]))).toBe(false);
    const result = store.read("task-1", "../../etc/passwd");
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("Not a tool result handle");
  });

  it("keeps the parts of one result in one file and serves each by its handle", () => {
    const store = new ToolResultSpillStore({ rootDir });
    const parts = new Map([
      ["sp0123456789ab.0", "stdout text"],
      ["sp0123456789ab.1", "stderr text"],
    ]);
    expect(store.write("task-1", parts)).toBe(true);
    const [taskDir] = fs.readdirSync(rootDir);
    expect(fs.readdirSync(path.join(rootDir, taskDir!))).toEqual(["sp0123456789ab.json"]);
    expect(page(store.read("task-1", "sp0123456789ab.0")).content).toBe("stdout text");
    expect(page(store.read("task-1", "sp0123456789ab.1")).content).toBe("stderr text");
    expect(store.read("task-1", "sp0123456789ab.2").success).toBe(false);
    expect(store.read("task-1", "sp0123456789ab").success).toBe(false);
  });

  it("writes files only the user can read", () => {
    const store = new ToolResultSpillStore({ rootDir });
    store.write("task-1", new Map([["sp0123456789ab", "x"]]));
    const [taskDir] = fs.readdirSync(rootDir);
    const file = path.join(rootDir, taskDir!, "sp0123456789ab.json");
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("expires a task's spills when it finishes", () => {
    const store = new ToolResultSpillStore({ rootDir });
    store.write("task-1", new Map([["sp0123456789ab", "x"]]));
    store.write("task-2", new Map([["sp0123456789ab", "y"]]));
    store.expireTask("task-1");
    expect(store.read("task-1", "sp0123456789ab").success).toBe(false);
    expect(page(store.read("task-2", "sp0123456789ab")).content).toBe("y");
  });

  it("expires spills after 24 hours", () => {
    let now = Date.now();
    const store = new ToolResultSpillStore({ rootDir, now: () => now });
    store.write("task-1", new Map([["sp0123456789ab", "x"]]));
    expect(store.read("task-1", "sp0123456789ab").success).toBe(true);
    now += SPILL_TTL_MS + 60_000;
    const late = store.read("task-1", "sp0123456789ab");
    expect(late.success === false && late.expired).toBe(true);

    store.write("task-3", new Map([["sp0123456789ab", "z"]]));
    now += SPILL_TTL_MS + 60_000;
    expect(store.sweepExpired()).toBe(1);
  });

  it("evicts a task's oldest spills to stay under its cap", () => {
    const store = new ToolResultSpillStore({ rootDir, maxTaskBytes: 2_500 });
    store.write("task-1", new Map([["sp000000000001", "a".repeat(1_000)]]));
    const [taskDir] = fs.readdirSync(rootDir);
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(path.join(rootDir, taskDir!, "sp000000000001.json"), old, old);
    store.write("task-1", new Map([["sp000000000002", "b".repeat(1_000)]]));
    store.write("task-1", new Map([["sp000000000003", "c".repeat(1_000)]]));
    expect(store.read("task-1", "sp000000000001").success).toBe(false);
    expect(store.read("task-1", "sp000000000002").success).toBe(true);
    expect(store.read("task-1", "sp000000000003").success).toBe(true);
    // A single result larger than the whole cap is not kept.
    expect(store.write("task-1", new Map([["sp000000000004", "d".repeat(3_000)]]))).toBe(false);
  });

  it("keeps the start of an over-long part and says the rest was not kept", () => {
    const store = new ToolResultSpillStore({ rootDir, maxPartChars: 100 });
    store.write("task-1", new Map([["sp0123456789ab", "x".repeat(250)]]));
    const kept = page(store.read("task-1", "sp0123456789ab", 0, 1_000));
    expect(kept.content.startsWith("x".repeat(100))).toBe(true);
    expect(kept.content).toContain("150 more chars of this result were not kept");
  });

  it("reports an offset past the end", () => {
    const store = new ToolResultSpillStore({ rootDir });
    store.write("task-1", new Map([["sp0123456789ab", "abc"]]));
    const result = store.read("task-1", "sp0123456789ab", 10);
    expect(result.success === false && result.error).toContain("past the end");
  });
});
