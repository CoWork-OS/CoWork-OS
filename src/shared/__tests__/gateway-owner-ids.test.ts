import { describe, expect, it } from "vitest";
import {
  MAX_GATEWAY_OWNER_IDS,
  gatewayOwnerIdHint,
  parseGatewayOwnerIds,
  validateGatewayOwnerIds,
} from "../gateway-owner-ids";

describe("gateway owner ids", () => {
  it("splits, trims and dedupes typed ids", () => {
    expect(parseGatewayOwnerIds(" 123456789 ,\nU01ABCDEF; 123456789\n\n@me:matrix.org ")).toEqual({
      ids: ["123456789", "U01ABCDEF", "@me:matrix.org"],
      invalid: [],
      tooMany: false,
    });
    expect(validateGatewayOwnerIds(["users/42", "+15551234567"])).toEqual({
      ok: true,
      ids: ["users/42", "+15551234567"],
    });
  });

  it("rejects ids with spaces or control characters, non-strings and too many ids", () => {
    expect(validateGatewayOwnerIds("has space")).toMatchObject({ ok: false });
    expect(validateGatewayOwnerIds(["ok", "bad\u0000id"])).toMatchObject({ ok: false });
    expect(validateGatewayOwnerIds([42 as unknown as string])).toMatchObject({ ok: false });
    expect(validateGatewayOwnerIds(["x".repeat(201)])).toMatchObject({ ok: false });
    const many = Array.from({ length: MAX_GATEWAY_OWNER_IDS + 1 }, (_, index) => `id-${index}`);
    expect(validateGatewayOwnerIds(many)).toMatchObject({ ok: false });
    expect(validateGatewayOwnerIds([])).toEqual({ ok: true, ids: [] });
  });

  it("explains where to find the id per channel", () => {
    expect(gatewayOwnerIdHint("slack")).toContain("member ID");
    expect(gatewayOwnerIdHint("discord")).toContain("Copy User ID");
    expect(gatewayOwnerIdHint("unknown")).toContain("Authorized Users");
  });
});
