/**
 * swarm_note (docs/memory-repo-phase5-design.md §2): a peer note in the task's swarm folder.
 * A real MemoryRepoService (git) and a fake daemon with a small task tree.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwarmTools, SWARM_NOTE_TOOL } from "../swarm-tools";
import { MemoryRepoService } from "../../../memory/repo/MemoryRepoService";
import { clearSwarmCache, swarmSlug } from "../../../memory/repo/memory-repo-swarm";
import { runWithMemoryRepoAccess } from "../../../security/memory-repo-access";
import { evaluateToolPolicy } from "../../tool-policy-engine";
import { getWorkerRoleSpec, resolveWorkerRoleAgentConfig } from "../../runtime/worker-role-registry";
import { CONTEXT_TOOL_RESTRICTIONS, TOOL_RISK_LEVELS, type Task, type Workspace } from "../../../../shared/types";
import type { AgentDaemon } from "../../daemon";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithGit = hasGit() ? describe : describe.skip;

const ROOT_ID = "a1b2c3d4-0000-4000-8000-000000000001";
const SLUG = swarmSlug("Why is search slow?", ROOT_ID);
const PREFIX = `swarms/${SLUG}`;

const tasks: Partial<Task>[] = [
  { id: ROOT_ID, title: "Why is search slow?", userPrompt: "Find out why search is slow" },
  { id: "child-1", title: "Profile the index", parentTaskId: ROOT_ID, workerRole: "researcher" },
  { id: "verifier-1", title: "Check the fix", parentTaskId: ROOT_ID, workerRole: "verifier" },
  { id: "lonely", title: "Alone" },
];

function fakeDaemon(sources: Array<Record<string, unknown>> = []) {
  return {
    logEvent: vi.fn(),
    getTaskById: vi.fn(async (id: string) => tasks.find((task) => task.id === id) as Task | undefined),
    getChildTasks: vi.fn(async (id: string) => tasks.filter((task) => task.parentTaskId === id) as Task[]),
    findTeamRunByRootTaskId: vi.fn(() => null),
    listRecentSensitiveSources: vi.fn(() => sources),
  } as unknown as AgentDaemon;
}

const workspace = { id: "ws-1", name: "Workspace", path: "/tmp/ws" } as Workspace;

describe("swarm_note definition and policy", () => {
  it("defines one tool that says when to use it", () => {
    const [tool] = SwarmTools.getToolDefinitions();
    expect(tool.name).toBe(SWARM_NOTE_TOOL);
    expect(tool.description).toMatch(/Use it when/);
    expect(tool.input_schema.required).toEqual(["kind", "text"]);
  });

  it("crosses the plan gate only for verified swarm members", () => {
    expect(evaluateToolPolicy(SWARM_NOTE_TOOL, { executionMode: "plan" }).decision).toBe("deny");
    expect(
      evaluateToolPolicy(SWARM_NOTE_TOOL, { executionMode: "plan", swarmMember: true }).decision,
    ).toBe("allow");
    expect(
      evaluateToolPolicy(SWARM_NOTE_TOOL, { executionMode: "chat", swarmMember: true }).decision,
    ).toBe("deny");
  });

  it("is denied to verifiers but kept for researchers and shared contexts deny it", () => {
    expect(getWorkerRoleSpec("verifier").toolRestrictions).toContain(SWARM_NOTE_TOOL);
    expect(resolveWorkerRoleAgentConfig("verifier").toolRestrictions).toContain(SWARM_NOTE_TOOL);
    expect(resolveWorkerRoleAgentConfig("researcher").toolRestrictions).not.toContain(SWARM_NOTE_TOOL);
    expect(CONTEXT_TOOL_RESTRICTIONS.group.deniedTools).toContain(SWARM_NOTE_TOOL);
    expect(CONTEXT_TOOL_RESTRICTIONS.public.deniedTools).toContain(SWARM_NOTE_TOOL);
    expect(TOOL_RISK_LEVELS.swarm_note).toBe("write");
  });
});

describeWithGit("SwarmTools.note", () => {
  let base: string;
  let service: MemoryRepoService;

  beforeEach(async () => {
    clearSwarmCache();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tools-"));
    service = new MemoryRepoService({ root: path.join(base, "CoWork Memory"), runtime: "desktop" });
    await service.start();
    MemoryRepoService.setInstance(service);
  });

  afterEach(() => {
    MemoryRepoService.setInstance(null);
    fs.rmSync(base, { recursive: true, force: true });
  });

  const note = (taskId: string, input: unknown, swarmPrefix: string | null = PREFIX, daemon = fakeDaemon()) =>
    runWithMemoryRepoAccess({ readAllowed: false, swarmPrefix }, () =>
      new SwarmTools(workspace, daemon, taskId).note(input),
    );

  it("writes a finding to the task's swarm folder", async () => {
    const result = await note("child-1", {
      kind: "finding",
      text: "p95 latency of /search is 420 ms with the result cache off",
      sources: ["bench/search.log", 42],
    });
    expect(result).toMatchObject({ success: true, action: "inserted", file: `${PREFIX}/findings.md` });
    const text = fs.readFileSync(path.join(service.root, PREFIX, "findings.md"), "utf8");
    expect(text).toContain("author: researcher");
    expect(text).toContain("source: cowork://tasks/child-1");
    expect(text).toContain("sources: bench/search.log");
    expect(text).not.toContain("tainted");
  });

  it("marks notes from a task that read untrusted content", async () => {
    const daemon = fakeDaemon([{ trustLevel: "untrusted", sourceKind: "web" }]);
    const result = await note(
      ROOT_ID,
      { kind: "question", text: "Has anyone profiled the tokenizer on staging?" },
      PREFIX,
      daemon,
    );
    expect(result).toMatchObject({ success: true, tainted: true, file: `${PREFIX}/questions.md` });
    expect(fs.readFileSync(path.join(service.root, PREFIX, "questions.md"), "utf8")).toContain(
      "author: lead",
    );
  });

  it("refuses outside a swarm scope, for verifiers, for a mismatched scope and bad input", async () => {
    const input = { kind: "finding", text: "The cache key ignores the locale entirely" };
    expect(await note("child-1", input, null)).toMatchObject({ success: false, reason: "not_in_swarm" });
    expect(await note("verifier-1", input)).toMatchObject({ success: false, reason: "verifier" });
    expect(await note("lonely", input)).toMatchObject({ success: false, reason: "not_in_swarm" });
    expect(await note("child-1", input, "swarms/other-ffffffff")).toMatchObject({
      success: false,
      reason: "not_in_swarm",
    });
    expect(await note("child-1", { kind: "rumour", text: "x" })).toMatchObject({
      success: false,
      reason: "invalid_input",
    });
    expect(await note("child-1", { kind: "finding", text: "" })).toMatchObject({ success: false });
    expect(fs.existsSync(path.join(service.root, "swarms"))).toBe(false);
  });
});
