import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildAgentSecurityHookPayload } from "../NumbatEventAdapter";
import { invokeNumbatHook } from "../NumbatHookClient";
import { resolveNumbatBinary } from "../NumbatBinaryResolver";

const runtimeManifest = path.join(process.cwd(), "build", "numbat", "manifest.json");
const runtimeAvailable = fs.existsSync(runtimeManifest);
const temporaryRoot = runtimeAvailable
  ? fs.mkdtempSync(path.join(os.tmpdir(), "cowork-numbat-runtime-test-"))
  : "";

afterAll(() => {
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe.skipIf(!runtimeAvailable)("pinned Numbat runtime", () => {
  const payload = buildAgentSecurityHookPayload({
    hookEventName: "PreToolUse",
    taskId: "runtime-test-task",
    sessionId: "runtime-test-session",
    workspacePath: temporaryRoot,
    toolCallId: "runtime-test-tool",
    toolName: "run_command",
    toolInput: { command: "rm -rf /" },
  });
  const rulesDir = path.join(
    process.cwd(),
    "build",
    "numbat",
    "rules",
    "cowork-recommended",
  );

  it("observes a matching action without overriding CoWork in monitor mode", async () => {
    const response = await invokeNumbatHook({
      binary: resolveNumbatBinary(),
      payload,
      mode: "monitor",
      ruleProfile: "recommended",
      customRuleDirs: [],
      recommendedRulesDir: rulesDir,
      outputFile: path.join(temporaryRoot, "monitor.ndjson"),
      stateDb: path.join(temporaryRoot, "monitor.db"),
      timeoutMs: 5_000,
    });

    expect(response).toEqual(
      expect.objectContaining({
        decision: "no_override",
        health: "ok",
      }),
    );
    expect(fs.readFileSync(path.join(temporaryRoot, "monitor.ndjson"), "utf8")).toContain(
      '"source_agent":"cowork-os"',
    );
  });

  it("returns a deny control decision for the same action in enforce mode", async () => {
    const response = await invokeNumbatHook({
      binary: resolveNumbatBinary(),
      payload,
      mode: "enforce",
      ruleProfile: "recommended",
      customRuleDirs: [],
      recommendedRulesDir: rulesDir,
      outputFile: path.join(temporaryRoot, "enforce.ndjson"),
      stateDb: path.join(temporaryRoot, "enforce.db"),
      timeoutMs: 5_000,
    });

    expect(response).toEqual(
      expect.objectContaining({
        decision: "deny",
        health: "ok",
      }),
    );
    expect(response.reason).toContain("Blocked by CoWork OS agent security rule");
  });
});
