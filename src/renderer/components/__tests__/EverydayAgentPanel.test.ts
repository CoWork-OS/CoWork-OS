import { describe, expect, it } from "vitest";
import {
  buildEverydayAgentPlanSteps,
  buildEverydayAgentPriorityItems,
  classifyEverydayAgentRecovery,
  getEverydayAgentStatus,
  isEverydayAgentConsentRequired,
  isEverydayAgentUuid,
  updateEverydayAgentTemporaryMode,
} from "../EverydayAgentPanel";
import {
  EVERYDAY_AGENT_CAPABILITY_BUNDLES,
  type EverydayActionReceipt,
  type EverydayAgentProfileResult,
  type EverydayCapabilityBundle,
  type EverydayCapabilitySetting,
  type EverydayPauseScope,
  type ProactiveSuggestion,
} from "../../../shared/types";

const now = 1_700_000_000_000;

function capabilitySettings(): Record<EverydayCapabilityBundle, EverydayCapabilitySetting> {
  return Object.fromEntries(
    EVERYDAY_AGENT_CAPABILITY_BUNDLES.map((bundle) => [
      bundle.id,
      { enabled: bundle.defaultEnabled },
    ]),
  ) as Record<EverydayCapabilityBundle, EverydayCapabilitySetting>;
}

function profileResult({
  enabled = true,
  compiledEnabled = true,
  blocked = false,
  pauseScopes = [],
}: {
  enabled?: boolean;
  compiledEnabled?: boolean;
  blocked?: boolean;
  pauseScopes?: EverydayPauseScope[];
} = {}): EverydayAgentProfileResult {
  return {
    profile: {
      id: "11111111-1111-4111-8111-111111111111",
      enabled,
      acceptedConsentVersion: 1,
      capabilitySettings: capabilitySettings(),
      connectorAllowlists: {},
      workspaceScopes: [],
      accountScopes: {},
      approvalPosture: "review_first",
      memoryPolicy: {
        reviewRequired: true,
        allowPromptVisibleMemory: false,
        suppressPrivateContent: true,
        allowExternalMirror: false,
        retentionDays: 30,
        allowedWorkspaceIds: [],
      },
      activeHours: { enabled: false, timezone: "UTC", windows: [] },
      retention: {
        receiptsDays: 30,
        previewsDays: 30,
        connectorCacheDays: 7,
        memoryCandidateDays: 30,
        routineProvenanceDays: 90,
      },
      browserProfilePolicy: {
        mode: "visible_ephemeral",
        preferVisibleBrowser: true,
        allowRealBrowserAttach: false,
        retainProfileMetadata: false,
      },
      pauseScopes,
      revokedCapabilities: [],
      heartbeatCadenceMinutes: 60,
      maxConcurrentBackgroundWork: 1,
      createdAt: now,
      updatedAt: now,
    },
    compiledPolicy: {
      enabled: compiledEnabled,
      profileId: "11111111-1111-4111-8111-111111111111",
      allowedCapabilities: ["inbox", "calendar", "browser", "docs", "memory", "automations"],
      blockedCapabilities: [],
      pausedScopes: pauseScopes,
      approvalPosture: "review_first",
      reviewOnly: true,
      visibleBrowserRequired: true,
      allowRealBrowserAttach: false,
      alwaysRequireApproval: [
        "data_export",
        "execute_sensitive",
        "destructive",
        "spend",
        "credential_sensitive",
      ],
      permissionRules: [],
      workflowTargets: [],
      routineEligibility: [],
      adminPolicy: {
        blocked,
        blockedBundles: [],
        forceReviewOnly: false,
        maxHeartbeatCadenceMinutes: 60,
        maxConcurrentBackgroundWork: 1,
      },
    },
  };
}

function receipt(status: EverydayActionReceipt["status"]): EverydayActionReceipt {
  return {
    id: `receipt-${status}`,
    profileId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    capability: "inbox",
    riskClass: "execute_sensitive",
    status,
    title: "Draft reply",
    summary: "A staged reply needs review.",
    sourceSignals: ["inbox"],
    toolCalls: [],
    externalIds: [],
    idempotencyKey: `key-${status}`,
    createdAt: now,
    updatedAt: now,
  };
}

function suggestion(): ProactiveSuggestion {
  return {
    id: "suggestion-1",
    type: "follow_up",
    title: "Follow up with client",
    description: "Prepare a follow-up draft.",
    actionPrompt: "Draft a follow-up.",
    confidence: 0.8,
    urgency: "high",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    createdAt: now,
    expiresAt: now + 1000,
    dismissed: false,
    actedOn: false,
  };
}

describe("EverydayAgentPanel console state", () => {
  it("classifies enabled, paused, disabled, and admin-blocked states", () => {
    expect(getEverydayAgentStatus(profileResult())).toBe("enabled");
    expect(
      getEverydayAgentStatus(
        profileResult({
          compiledEnabled: false,
          pauseScopes: [{ kind: "global", pausedAt: now }],
        }),
      ),
    ).toBe("paused");
    expect(getEverydayAgentStatus(profileResult({ enabled: false, compiledEnabled: false }))).toBe(
      "disabled",
    );
    expect(getEverydayAgentStatus(profileResult({ blocked: true, compiledEnabled: false }))).toBe(
      "blocked",
    );
  });

  it("prioritizes approvals and receipts ahead of suggestions", () => {
    const items = buildEverydayAgentPriorityItems({
      result: profileResult(),
      receipts: [receipt("previewed")],
      suggestions: [suggestion()],
      memoryCandidateCount: 2,
    });

    expect(items[0]?.actionKind).toBe("receipt");
    expect(items[0]?.title).toBe("Draft reply");
    expect(items.findIndex((item) => item.actionKind === "suggestion")).toBeGreaterThan(
      items.findIndex((item) => item.actionKind === "receipt"),
    );
  });

  it("surfaces paused and admin-blocked intervention before ordinary work", () => {
    const pausedItems = buildEverydayAgentPriorityItems({
      result: profileResult({
        compiledEnabled: false,
        pauseScopes: [{ kind: "global", pausedAt: now }],
      }),
      receipts: [receipt("executed")],
      suggestions: [],
      memoryCandidateCount: 0,
    });
    const blockedItems = buildEverydayAgentPriorityItems({
      result: profileResult({ blocked: true, compiledEnabled: false }),
      receipts: [receipt("previewed")],
      suggestions: [],
      memoryCandidateCount: 0,
    });

    expect(pausedItems[0]?.actionKind).toBe("resume");
    expect(blockedItems[0]?.id).toBe("admin-blocked");
  });

  it("keeps the memory IPC guard strict about UUID inputs", () => {
    expect(isEverydayAgentUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isEverydayAgentUuid("profile-local")).toBe(false);
    expect(isEverydayAgentUuid(undefined)).toBe(false);
  });

  it("does not require the consent modal after the current version was declined", () => {
    const declined = profileResult({ enabled: false, compiledEnabled: false });
    declined.profile.acceptedConsentVersion = 0;
    declined.profile.declinedConsentVersion = 1;
    declined.profile.consentDeclinedAt = now;
    const missingDecision = profileResult({ enabled: false, compiledEnabled: false });
    missingDecision.profile.acceptedConsentVersion = 0;

    expect(isEverydayAgentConsentRequired(declined)).toBe(false);
    expect(isEverydayAgentConsentRequired(missingDecision)).toBe(true);
  });

  it("updates a temporary run mode without changing sibling modes", () => {
    expect(
      updateEverydayAgentTemporaryMode(
        {
          noMemory: false,
          disposableBrowser: true,
          readOnly: false,
        },
        "readOnly",
        true,
      ),
    ).toEqual({
      noMemory: false,
      disposableBrowser: true,
      readOnly: true,
    });
  });

  it("classifies recoverable auth failures into connector repair actions", () => {
    const item = classifyEverydayAgentRecovery({
      ...receipt("failed"),
      summary: "OAuth token expired while reading mailbox.",
      retryState: { attempt: 1, lastError: "missing Gmail scope" },
    });

    expect(item?.actionLabel).toBe("Reconnect app");
    expect(item?.tone).toBe("warn");
  });

  it("builds plan review steps with approval posture for sensitive previews", () => {
    const steps = buildEverydayAgentPlanSteps({
      status: "enabled",
      busy: null,
      preview: {
        id: "preview-1",
        profileId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        capability: "inbox",
        riskClass: "execute_sensitive",
        title: "Send follow-up",
        action: "Send a follow-up email",
        sourceEvidence: ["inbox"],
        target: { destination: "client@example.test" },
        proposedMutation: "Send an email",
        affectedObjects: ["message-draft"],
        rollbackAvailable: false,
        approvalRequired: true,
        approvalReason: "Email sends require approval.",
        idempotencyKey: "preview-key",
        status: "pending",
        createdAt: now,
        expiresAt: now + 1000,
      },
      suggestions: [],
      receipts: [],
    });

    expect(steps.some((step) => step.posture === "approval")).toBe(true);
  });
});
