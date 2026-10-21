import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const host = vi.hoisted(() => ({ available: true }));
vi.mock("../../host/browser-capabilities", () => ({
  hasHostMethods: () => host.available,
}));

import { CuaSpaceSettings } from "../CuaSpaceSettings";

describe("CuaSpaceSettings", () => {
  it("renders a write-only token field and the Space toggle", () => {
    host.available = true;
    const html = renderToStaticMarkup(React.createElement(CuaSpaceSettings));
    expect(html).toContain("Cua Space");
    expect(html).toMatch(
      /id="cua-space-token"[^>]*type="password"|type="password"[^>]*id="cua-space-token"/,
    );
    expect(html).toContain("Run Computer Use in this Cua Space");
    expect(html).toContain("Test connection");
  });

  it("renders nothing where the host cannot reach the settings API", () => {
    host.available = false;
    expect(renderToStaticMarkup(React.createElement(CuaSpaceSettings))).toBe("");
  });
});
