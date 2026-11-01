import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpillTools } from "../spill-tools";
import { ToolResultSpillStore } from "../../tool-result-spill-store";

let rootDir: string;
let store: ToolResultSpillStore;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-spill-tools-"));
  store = new ToolResultSpillStore({ rootDir });
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe("SpillTools", () => {
  it("defines tool_result_read with a when-to-use description", () => {
    const [definition] = SpillTools.getToolDefinitions();
    expect(definition?.name).toBe("tool_result_read");
    expect(definition?.description).toContain("Use it when");
    expect(definition?.input_schema.required).toEqual(["handle"]);
  });

  it("returns pages of this task's spill with the call for the next page", () => {
    const text = "0123456789".repeat(1_000);
    store.write("task-1", new Map([["sp0123456789ab", text]]));
    const tools = new SpillTools("task-1", store);

    const first = tools.read({ handle: "sp0123456789ab", offset: 100, length: 50 });
    expect(first).toMatchObject({
      success: true,
      offset: 100,
      length: 50,
      next_offset: 150,
      content: text.slice(100, 150),
    });
    expect(first.note).toContain('tool_result_read(handle="sp0123456789ab", offset=150)');

    const last = tools.read({ handle: "sp0123456789ab", offset: text.length - 10 });
    expect(last).toMatchObject({ success: true, next_offset: null, note: "End of this result." });
  });

  it("cannot read another task's spill and explains an expired handle", () => {
    store.write("task-1", new Map([["sp0123456789ab", "private"]]));
    const other = new SpillTools("task-2", store).read({ handle: "sp0123456789ab" });
    expect(other).toMatchObject({ success: false, expired: true });
    expect(String(other.error)).toContain("Run the original tool again");
  });

  it("rejects a missing or malformed handle", () => {
    const tools = new SpillTools("task-1", store);
    expect(tools.read({})).toMatchObject({ success: false });
    expect(tools.read({ handle: "../../etc/passwd" })).toMatchObject({ success: false });
  });

  it("expires the task's spills only once the task has finished", () => {
    store.write("task-1", new Map([["sp0123456789ab", "x"]]));
    const tools = new SpillTools("task-1", store);
    tools.expireIfTaskFinished("executing");
    tools.expireIfTaskFinished(undefined);
    expect(tools.read({ handle: "sp0123456789ab" }).success).toBe(true);
    tools.expireIfTaskFinished("completed");
    expect(tools.read({ handle: "sp0123456789ab" }).success).toBe(false);
  });
});
