import { describe, expect, it } from "vitest";
import { hasLocalPreviewDevScript, hasSharedSessionActivity } from "../session-sidebar-visibility";

const member = (
  id: string,
  role: "owner" | "reviewer" = "owner",
  status: "active" | "revoked" = "active",
) => ({
  id,
  contextId: "context-1",
  principalId: id,
  displayName: id,
  role,
  status,
  joinedAt: 1,
  updatedAt: 1,
});

describe("session sidebar visibility", () => {
  it("does not treat the local owner as a shared session", () => {
    expect(
      hasSharedSessionActivity({
        members: [member("owner")],
        invites: [],
        actor: member("owner"),
      }),
    ).toBe(false);
  });

  it("shows collaboration after an invite or another active member", () => {
    const owner = member("owner");
    expect(
      hasSharedSessionActivity({
        members: [owner],
        invites: [{ id: "invite-1", expiresAt: Date.now() + 60_000 } as Any],
        actor: owner,
      }),
    ).toBe(true);
    expect(
      hasSharedSessionActivity({
        members: [owner, member("reviewer", "reviewer")],
        invites: [],
        actor: owner,
      }),
    ).toBe(true);
  });

  it("recognizes only a non-empty package dev script", () => {
    expect(hasLocalPreviewDevScript({ scripts: { dev: "vite" } })).toBe(true);
    expect(hasLocalPreviewDevScript({ scripts: { dev: "  npm run start" } })).toBe(true);
    expect(hasLocalPreviewDevScript({ scripts: { start: "vite" } })).toBe(false);
    expect(hasLocalPreviewDevScript({ scripts: { dev: "" } })).toBe(false);
    expect(hasLocalPreviewDevScript(null)).toBe(false);
  });
});
