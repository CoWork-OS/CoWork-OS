import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PrivateBrowserPromptDialog } from "../BrowserWorkbench/PrivateBrowserPrompt";
import { savedVerificationCodeCommand } from "../BrowserWorkbench/SavedLoginsMenu";
import type { BrowserVaultItem } from "../../../shared/browser-vault";

describe("private browser prompt", () => {
  it.each(["login", "payment", "code", "card_code", "unlock"] as const)(
    "renders %s as a dedicated masked dialog",
    (kind) => {
      const html = renderToStaticMarkup(
        React.createElement(PrivateBrowserPromptDialog, {
          prompt: {
            id: "r",
            taskId: "t",
            sessionId: "default",
            origin: "https://shop.example",
            kind,
            source: "bitwarden",
            expiresAt: 1000,
          },
          onRespond: vi.fn(),
        }),
      );
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain('type="password"');
      expect(html).toContain('autoComplete="off"');
      expect(html).toContain("https://shop.example");
      expect(html).not.toContain("textarea");
    },
  );
  it.each(["login", "payment", "address"] as const)(
    "offers one-use %s input when encrypted storage is unavailable",
    (kind) => {
      const html = renderToStaticMarkup(
        React.createElement(PrivateBrowserPromptDialog, {
          prompt: {
            id: "r",
            taskId: "t",
            sessionId: "default",
            origin: "https://shop.example",
            kind,
            canRemember: false,
            expiresAt: 1000,
          },
          onRespond: vi.fn(),
        }),
      );
      expect(html).toContain("Encrypted storage is unavailable");
      expect(html).toContain("used once and will not be saved");
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain("Save &amp; sign in");
      if (kind === "login") expect(html).toContain("Sign in once");
    },
  );
});

describe("saved verification-code actions", () => {
  const item: BrowserVaultItem = {
    id: "saved-login-id",
    kind: "login",
    source: "local",
    origin: "https://shop.example",
    allowedOrigins: ["https://shop.example"],
    label: "Shop",
  };

  it("binds the code request to the selected saved login", () => {
    expect(savedVerificationCodeCommand({ ...item, hasOtp: true })).toEqual({
      action: "enter_code",
      handle: "saved-login-id",
    });
  });

  it.each(["onepassword", "bitwarden"] as const)(
    "allows %s to resolve an authenticator omitted from its listing",
    (source) => {
      expect(savedVerificationCodeCommand({ ...item, source, id: "manager-login" })).toEqual({
        action: "enter_code",
        handle: "manager-login",
      });
    },
  );

  it("does not offer saved codes for local entries without a key or managers reporting no key", () => {
    expect(savedVerificationCodeCommand(item)).toBeNull();
    expect(
      savedVerificationCodeCommand({ ...item, source: "bitwarden", hasOtp: false }),
    ).toBeNull();
    expect(savedVerificationCodeCommand({ ...item, kind: "payment", hasOtp: true })).toBeNull();
  });
});
