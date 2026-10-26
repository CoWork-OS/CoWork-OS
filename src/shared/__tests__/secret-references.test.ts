import { describe, expect, it } from "vitest";
import {
  looksLikeSecretReference,
  parseSecretReference,
  secretReferenceSourceLabel,
} from "../secret-references";

describe("parseSecretReference", () => {
  it.each([undefined, "", "sk-or-v1-abc", "https://example.com", 42])(
    "leaves a plain value alone: %s",
    (value) => {
      expect(parseSecretReference(value)).toBeNull();
      expect(looksLikeSecretReference(value)).toBe(false);
    },
  );

  it.each([
    "op://Private/OpenAI/credential",
    "op://Private/OpenAI/API/credential",
    "op://Private/GitHub/one-time password?attribute=otp",
    "  op://Shared/Anthropic key/credential  ",
  ])("accepts the 1Password reference %s", (value) => {
    expect(parseSecretReference(value)).toEqual({
      ok: true,
      reference: { source: "onepassword", raw: value.trim() },
    });
  });

  it.each(["op://Private", "op://Private/OpenAI", "op://Private//credential", "op://a/b/c/d/e"])(
    "rejects the malformed 1Password reference %s",
    (value) => {
      expect(parseSecretReference(value)).toMatchObject({ ok: false, source: "onepassword" });
    },
  );

  it("reads a Bitwarden Secrets Manager secret id", () => {
    expect(parseSecretReference("bws://3F2504E0-4F89-11D3-9A0C-0305E82C3301")).toEqual({
      ok: true,
      reference: {
        source: "bitwarden-secrets-manager",
        raw: "bws://3F2504E0-4F89-11D3-9A0C-0305E82C3301",
        secretId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      },
    });
    expect(parseSecretReference("bws://openai")).toMatchObject({ ok: false });
  });

  it("reads a Bitwarden item and field, defaulting to the password", () => {
    expect(parseSecretReference("bw://OpenAI API/password")).toMatchObject({
      ok: true,
      reference: { source: "bitwarden", item: "OpenAI API", field: "password" },
    });
    expect(parseSecretReference("bw://OpenAI")).toMatchObject({
      ok: true,
      reference: { item: "OpenAI", field: "password" },
    });
    expect(parseSecretReference("bw://8d2c-11/API token")).toMatchObject({
      ok: true,
      reference: { item: "8d2c-11", field: "API token" },
    });
  });

  it.each(["bw://", "bw://-h/password", "bw://OpenAI/--raw", "bw://OpenAI/"])(
    "rejects a Bitwarden reference that could read as a flag or is empty: %s",
    (value) => {
      expect(parseSecretReference(value)).toMatchObject({ ok: false, source: "bitwarden" });
    },
  );

  it("rejects control characters and overlong references", () => {
    expect(parseSecretReference("op://Private/OpenAI/cred\nential")).toMatchObject({ ok: false });
    expect(parseSecretReference(`op://Private/${"x".repeat(600)}/credential`)).toMatchObject({
      ok: false,
    });
  });

  it("labels a reference by its vault", () => {
    expect(secretReferenceSourceLabel("op://a/b/c")).toBe("1Password");
    expect(secretReferenceSourceLabel("BW://item/password")).toBe("Bitwarden");
    expect(secretReferenceSourceLabel("sk-123")).toBeNull();
  });
});
