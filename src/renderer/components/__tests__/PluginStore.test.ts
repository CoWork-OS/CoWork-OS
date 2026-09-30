import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { PluginStore } from "../PluginStore";

describe("PluginStore browser mutation controls", () => {
  it("renders create and URL import disabled with desktop guidance", () => {
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: { desktopMethods: { searchPackRegistry: true } },
    });

    const markup = renderToStaticMarkup(React.createElement(PluginStore, { onClose: () => {} }));

    expect(markup).toContain('disabled="" title="Create packs in the desktop app"');
    expect(markup).toContain('disabled="" title="Import packs in the desktop app"');
    expect(markup).toContain(
      "Browse the pack catalog here. Installing, importing, or creating packs is available in the desktop app.",
    );
  });

  it("guards every install, import, and create path against missing browser methods", () => {
    const componentPath = fileURLToPath(new URL("../PluginStore.tsx", import.meta.url));
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("if (!canImportFromUrl)");
    expect(source).toContain("if (!canScaffoldPack)");
    expect(source).toContain("!installMethod || !hasHostMethod(installMethod)");
    expect(source).toContain("disabled={!canScaffoldPack}");
    expect(source).toContain("disabled={!canImportFromUrl}");
    expect(source).toContain("disabled={!canInstallEntry || installing === entry.id}");
  });
});
