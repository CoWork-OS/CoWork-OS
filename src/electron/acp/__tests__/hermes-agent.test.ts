/**
 * A local Hermes Agent install as an ACP agent: finding the `hermes` command, the command
 * acpx starts, the registry card, and the acpx arguments for a Hermes task.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AcpxRuntimeUnavailableError,
  assertAcpxExecutionAuthority,
  buildAcpxCommandArgs,
} from "../../agent/AcpxRuntimeRunner";
import { ACPAgentRegistry } from "../agent-registry";
import { findHermesExecutable, hermesAcpCommand, hermesAgentCard } from "../hermes-agent";
import type { ExternalRuntimeConfig, WorkspacePermissions } from "../../../shared/types";

const files = (...existing: string[]) => {
  const set = new Set(existing);
  return (file: string) => set.has(file);
};

const HERMES_RUNTIME: ExternalRuntimeConfig = {
  kind: "acpx",
  agent: "hermes",
  sessionMode: "persistent",
  outputMode: "json",
  permissionMode: "approve-reads",
};

describe("finding Hermes", () => {
  it("prefers HERMES_BIN, then PATH, then the installer's locations", () => {
    const home = "/home/sam";
    expect(
      findHermesExecutable({
        env: { HERMES_BIN: "/opt/hermes", PATH: "/usr/bin" },
        homedir: home,
        platform: "linux",
        isFile: files("/opt/hermes", "/usr/bin/hermes"),
      }),
    ).toBe("/opt/hermes");
    expect(
      findHermesExecutable({
        env: { PATH: "/usr/local/bin:/usr/bin" },
        homedir: home,
        platform: "linux",
        isFile: files("/usr/bin/hermes", path.join(home, ".local", "bin", "hermes")),
      }),
    ).toBe("/usr/bin/hermes");
    expect(
      findHermesExecutable({
        env: { PATH: "/usr/bin" },
        homedir: home,
        platform: "darwin",
        isFile: files(path.join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes")),
      }),
    ).toBe(path.join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes"));
  });

  it("does not fall back when HERMES_BIN points at nothing", () => {
    expect(
      findHermesExecutable({
        env: { HERMES_BIN: "/missing", PATH: "/usr/bin" },
        homedir: "/home/sam",
        platform: "linux",
        isFile: files("/usr/bin/hermes"),
      }),
    ).toBeNull();
  });

  it("quotes a path with spaces in the acp command", () => {
    expect(
      hermesAcpCommand({
        env: { HERMES_BIN: "/Users/sam/My Tools/hermes" },
        isFile: () => true,
      }),
    ).toBe('"/Users/sam/My Tools/hermes" acp');
    expect(
      hermesAcpCommand({ env: { PATH: "" }, homedir: "/nowhere", isFile: () => false }),
    ).toBeNull();
  });

  it("lists a Hermes card only when Hermes is installed", () => {
    expect(
      hermesAgentCard({ env: { PATH: "" }, homedir: "/nowhere", isFile: () => false }),
    ).toBeNull();
    const card = hermesAgentCard({ env: { HERMES_BIN: "/opt/hermes" }, isFile: () => true });
    expect(card).toMatchObject({
      id: "runtime:hermes",
      origin: "local",
      externalRuntimeAgent: "hermes",
      status: "available",
    });
    expect(card?.localRoleId).toBeUndefined();
  });
});

describe("Hermes in the ACP registry", () => {
  it("lists runtime agents beside roles and finds them by id", () => {
    const card = hermesAgentCard({ env: { HERMES_BIN: "/opt/hermes" }, isFile: () => true });
    const registry = new ACPAgentRegistry(undefined, { runtimeAgents: () => (card ? [card] : []) });
    expect(registry.discover({ query: "hermes" }, []).map((agent) => agent.id)).toEqual([
      "runtime:hermes",
    ]);
    expect(registry.getAgent("runtime:hermes", [])?.externalRuntimeAgent).toBe("hermes");
  });

  it("lists none unless the app passes a source", () => {
    expect(new ACPAgentRegistry().getAllAgents([])).toEqual([]);
  });
});

describe("acpx arguments for Hermes", () => {
  it("starts Hermes as a raw ACP agent command instead of a built-in agent name", () => {
    const args = buildAcpxCommandArgs({
      cwd: "/work",
      runtimeConfig: HERMES_RUNTIME,
      commandArgs: ["sessions", "ensure", "--name", "cowork-1"],
      resolveHermesCommand: () => "/opt/hermes acp",
    });
    expect(args).toEqual([
      "--format",
      "json",
      "--json-strict",
      "--cwd",
      "/work",
      "--approve-reads",
      "--non-interactive-permissions",
      "fail",
      "--agent",
      "/opt/hermes acp",
      "sessions",
      "ensure",
      "--name",
      "cowork-1",
    ]);
    expect(args).not.toContain("hermes");
  });

  it("reports Hermes as unavailable when it is not installed", () => {
    expect(() =>
      buildAcpxCommandArgs({
        cwd: "/work",
        runtimeConfig: HERMES_RUNTIME,
        commandArgs: ["prompt"],
        resolveHermesCommand: () => null,
      }),
    ).toThrow(AcpxRuntimeUnavailableError);
  });

  it("keeps rejecting bounded access profiles, as for every external runtime", () => {
    const bounded = {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: true,
      accessSandboxMode: "workspace-write",
      accessProfileScoped: true,
      accessNetworkMode: "enabled",
    } as unknown as WorkspacePermissions;
    const runtime = {
      requireSandboxForShell: false,
      network: { defaultAction: "allow", allowedDomains: [], blockedDomains: [] },
    } as unknown as Parameters<typeof assertAcpxExecutionAuthority>[1];
    expect(() => assertAcpxExecutionAuthority(bounded, runtime)).toThrow(
      /cannot enforce this task's access boundary/,
    );
  });
});
