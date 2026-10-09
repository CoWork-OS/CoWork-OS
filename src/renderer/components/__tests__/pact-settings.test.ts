import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PactGrantView } from "../../../shared/pact";
import {
  buildPactIdentityUpdate,
  isPactGrantConnected,
  PactSettingsLoadFailure,
} from "../PactSettings";

function grant(overrides: Partial<PactGrantView> = {}): PactGrantView {
  return {
    id: "grant-1",
    businessId: "business-1",
    businessName: "Example Co.",
    scopes: [],
    state: "active",
    createdAt: 1_000,
    ...overrides,
  };
}

describe("PactSettings", () => {
  it("renders a retryable error instead of loading forever when the first load fails", () => {
    const markup = renderToStaticMarkup(
      React.createElement(PactSettingsLoadFailure, {
        message: "PACT is unavailable.",
        onRetry: () => {},
      }),
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not load PACT settings: PACT is unavailable.");
    expect(markup).toContain(">Retry</button>");
    expect(markup).not.toContain("Loading PACT settings");
  });

  it("does not show an active grant past its lifetime as connected", () => {
    expect(isPactGrantConnected(grant(), 5_000)).toBe(true);
    expect(isPactGrantConnected(grant({ grantExpiresAt: 6_000 }), 5_000)).toBe(true);
    expect(isPactGrantConnected(grant({ grantExpiresAt: 5_000 }), 5_000)).toBe(false);
    expect(isPactGrantConnected(grant({ state: "expired" }), 5_000)).toBe(false);
  });

  it("keeps the saved signer auth mode when saving identity", () => {
    expect(
      buildPactIdentityUpdate({
        deployment: "self_hosted",
        issuer: " https://pa.example.com ",
        signerUrl: "https://signer.example.com",
        current: { deployment: "self_hosted", authMode: "device_key" },
      }),
    ).toEqual({
      deployment: "self_hosted",
      issuer: "https://pa.example.com",
      signerUrl: "https://signer.example.com",
      authMode: "device_key",
    });
    expect(
      buildPactIdentityUpdate({
        deployment: "managed",
        issuer: "",
        signerUrl: "",
        current: { deployment: "none" },
      }),
    ).toEqual({ deployment: "managed", authMode: "credential" });
  });
});
