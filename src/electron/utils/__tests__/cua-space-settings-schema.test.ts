import { describe, expect, it } from "vitest";
import { CuaSpaceSettingsSchema } from "../validation";

describe("CuaSpaceSettingsSchema", () => {
  it("accepts partial updates and a null token", () => {
    expect(CuaSpaceSettingsSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(CuaSpaceSettingsSchema.parse({ token: null })).toEqual({ token: null });
  });

  it("rejects unknown fields and wrong types from the renderer", () => {
    expect(CuaSpaceSettingsSchema.safeParse({ tokenConfigured: true }).success).toBe(false);
    expect(CuaSpaceSettingsSchema.safeParse({ enabled: "true" }).success).toBe(false);
    expect(CuaSpaceSettingsSchema.safeParse({ token: "x".repeat(4001) }).success).toBe(false);
  });
});
