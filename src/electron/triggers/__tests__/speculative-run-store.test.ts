import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { SpeculativeRun } from "../../../shared/types";
import {
  FileSpeculativeRunStore,
  MAX_STORED_SPECULATIVE_RUNS,
  boundSpeculativeRuns,
} from "../speculative-run-store";

const dirs: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speculative-runs-"));
  dirs.push(dir);
  return path.join(dir, "nested", "speculative-runs.json");
}

function run(id: string, startedAt: number, status: SpeculativeRun["status"] = "discarded") {
  return {
    id,
    triggerId: "t",
    triggerName: "T",
    workspaceId: "ws",
    status,
    outcome: status === "running" ? "running" : "not_reproduced",
    delivery: "draft_only",
    destination: "origin_thread",
    maxDiffLines: 200,
    issueExcerpt: "x",
    origin: { source: "channel_message" },
    startedAt,
    deadlineAt: startedAt + 1,
  } satisfies SpeculativeRun;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("FileSpeculativeRunStore", () => {
  it("round-trips runs and starts empty without a file", async () => {
    const store = new FileSpeculativeRunStore(tempFile());
    expect(await store.load()).toEqual([]);
    await store.save([run("a", 1), run("b", 2)]);
    expect((await store.load()).map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("treats a damaged file as an empty history", async () => {
    const file = tempFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(await new FileSpeculativeRunStore(file).load()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ runs: [{ id: 1 }, run("ok", 1)] }));
    expect((await new FileSpeculativeRunStore(file).load()).map((entry) => entry.id)).toEqual([
      "ok",
    ]);
  });

  it("keeps the newest runs and never drops a running one", () => {
    const runs = Array.from({ length: MAX_STORED_SPECULATIVE_RUNS + 5 }, (_, index) =>
      run(`r${index}`, index + 10),
    );
    runs.push(run("old-running", 0, "running"));
    const bounded = boundSpeculativeRuns(runs);
    expect(bounded).toHaveLength(MAX_STORED_SPECULATIVE_RUNS);
    expect(bounded.some((entry) => entry.id === "old-running")).toBe(true);
    expect(bounded[0].id).toBe(`r${MAX_STORED_SPECULATIVE_RUNS + 4}`);
  });
});
