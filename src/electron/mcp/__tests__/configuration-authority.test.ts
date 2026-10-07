import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { mcpConfigurationCurrent } from "../configuration-authority";
import { recordOAuthRefresh } from "../../security/oauth-refresh-proof";
const fixture = () => ({
  id: randomUUID(),
  name: "Fixture",
  enabled: true,
  transport: "streamable-http" as const,
  url: "https://fixture.invalid/mcp",
  auth: {
    type: "bearer" as const,
    token: randomUUID(),
    refreshToken: "refresh",
    clientId: "client",
    clientSecret: "secret",
    tokenUrl: "https://fixture.invalid/token",
  },
});
it("accepts a proven refresh while preserving every noncredential field", () => {
  const admitted = fixture(),
    current = { ...admitted, auth: { ...admitted.auth, token: "new", refreshToken: "rotated" } };
  expect(mcpConfigurationCurrent(admitted, current)).toBe(false);
  recordOAuthRefresh(admitted.auth, current.auth);
  expect(mcpConfigurationCurrent(admitted, current)).toBe(true);
  for (const update of [
    { enabled: false },
    { url: "https://other.invalid" },
    { defaultToolsApprovalMode: "auto" },
    { headers: { extra: "different" } },
    { id: "other" },
  ])
    expect(mcpConfigurationCurrent(admitted, { ...current, ...update } as Any)).toBe(false);
});
it("does not accept a manual credential edit or a removed server", () => {
  const admitted = fixture();
  expect(
    mcpConfigurationCurrent(admitted, { ...admitted, auth: { ...admitted.auth, token: "manual" } }),
  ).toBe(false);
  expect(mcpConfigurationCurrent(admitted, undefined)).toBe(false);
  expect(mcpConfigurationCurrent(undefined, undefined)).toBe(true);
});
