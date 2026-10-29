import { describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import {
  EXPLICIT_CONSENT_KINDS,
  type ExplicitConsentKind,
} from "../../../../shared/explicit-consent";
import { EXPLICIT_CONSENT_LABELS } from "../../../../shared/bot-capabilities";
import { PermissionEngine, type PermissionEngineRequest } from "../PermissionEngine";

const workspace: Workspace = {
  id: "workspace-1",
  name: "Workspace",
  path: "/tmp/workspace",
  permissions: {
    read: true,
    write: true,
    delete: true,
    network: true,
    shell: true,
    accessProfileId: "ask_for_approval",
    accessSandboxMode: "workspace-write",
    accessApprovalPolicy: "on-request",
    accessNetworkMode: "enabled",
  },
  createdAt: Date.now(),
};

function request(input: Partial<PermissionEngineRequest>): PermissionEngineRequest {
  return { workspace, toolName: "read_file", mode: "default", rules: [], ...input };
}

/** One call per reason; the bot capability card lists these reasons as "needs your OK". */
const EXAMPLES: Record<ExplicitConsentKind, Partial<PermissionEngineRequest>> = {
  dangerous_shell: {
    toolName: "run_command",
    approvalType: "run_command",
    // sudo itself is blocked outright by guardrails, so the card never cites it.
    command: "rm build.log",
  },
  risk_gate: { toolName: "write_file", approvalType: "risk_gate" },
  delete: { toolName: "delete_file", approvalType: "delete_file", path: "/tmp/workspace/a.txt" },
  data_export: { toolName: "analyze_image", approvalType: "data_export" },
  external_service: { toolName: "post_update", approvalType: "external_service" },
  location: { toolName: "get_current_location", approvalType: "location_access" },
  protected_credential: { toolName: "request_protected_credential" },
  app_action: { toolName: "gmail_action" },
  voice_call: { toolName: "voice_call" },
  unconfigured_connector: { toolName: "mcp_tracker_create_issue" },
};

describe("explicit consent kinds", () => {
  it.each(EXPLICIT_CONSENT_KINDS)("%s is a reason the engine reports, and it asks", (kind) => {
    const call = request(EXAMPLES[kind]);
    expect(PermissionEngine.explicitConsentKinds(call)).toContain(kind);
    expect(PermissionEngine.evaluate(call).decision).toBe("ask");
  });

  it("reports no reason for an ordinary workspace read", () => {
    expect(PermissionEngine.explicitConsentKinds(request({ toolName: "read_file" }))).toEqual([]);
  });

  it("words every reason for the card", () => {
    for (const kind of EXPLICIT_CONSENT_KINDS) {
      expect(EXPLICIT_CONSENT_LABELS[kind]).toMatch(/\S/);
    }
  });
});
