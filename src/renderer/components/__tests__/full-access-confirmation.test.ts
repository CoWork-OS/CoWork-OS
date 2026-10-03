import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
function storage() {
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
  };
}

afterEach(() => {
  store.clear();
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});

describe("first-time Full access confirmation", () => {
  it("requires acknowledgement even when Full access was previously remembered", async () => {
    storage();
    store.set("cowork:new-task-access-profile", "full_access");
    const { hasConfirmedFullAccess } = await import("../FullAccessConfirmationDialog");
    expect(hasConfirmedFullAccess()).toBe(false);
  });

  it("persists explicit confirmation across app sessions", async () => {
    storage();
    const first = await import("../FullAccessConfirmationDialog");
    expect(first.hasConfirmedFullAccess()).toBe(false);
    first.confirmFullAccess();
    vi.resetModules();
    const next = await import("../FullAccessConfirmationDialog");
    expect(next.hasConfirmedFullAccess()).toBe(true);
  });

  it("keeps confirmation for the session when storage is unavailable", async () => {
    const { confirmFullAccess, hasConfirmedFullAccess } =
      await import("../FullAccessConfirmationDialog");
    expect(hasConfirmedFullAccess()).toBe(false);
    confirmFullAccess();
    expect(hasConfirmedFullAccess()).toBe(true);
  });

  it("explains authority and risks with an accessible cancellable dialog", async () => {
    const { FullAccessConfirmationDialog } = await import("../FullAccessConfirmationDialog");
    const html = renderToStaticMarkup(
      React.createElement(FullAccessConfirmationDialog, {
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    for (const text of [
      "Turn on Full access?",
      "Files and folders",
      "Terminal commands",
      "Internet and connected apps",
      "computer use",
      "prompt injection",
      "Cancel",
      "Confirm",
      "Explicit deny rules",
    ])
      expect(html).toContain(text);
  });
});
