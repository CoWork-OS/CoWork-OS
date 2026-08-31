/**
 * Classifies desktop apps for computer-use consent tiers and sentinel warnings.
 * Aligns with Claude-style guidance: browsers often view-only risk, terminals IDEs click-focused, etc.
 */

import type { AppAccessLevel } from "../security/app-permission-manager";

export type AppRiskClass =
  | "browser"
  | "terminal_ide"
  | "finder"
  | "system_settings"
  | "trading"
  | "generic";

export interface AppRiskProfile {
  riskClass: AppRiskClass;
  /** Maximum tier we suggest in the consent UI (user may still be warned). */
  maxSuggestedLevel: AppAccessLevel;
  /** Shown when approving control of high-blast-radius apps. */
  sentinelWarning?: string;
}

const BROWSER_BUNDLE_PREFIXES = [
  "com.google.Chrome",
  "com.brave.Browser",
  "org.mozilla.firefox",
  "com.apple.Safari",
  "company.thebrowser.Browser", // Arc
  "com.microsoft.edgemac",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
];

const TERMINAL_IDE_BUNDLE_PREFIXES = [
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "com.todesktop.230313mzl4w4u92", // Cursor
  "com.microsoft.VSCode",
  "com.jetbrains",
  "com.apple.dt.Xcode",
  "dev.warp.Warp-stable",
  "co.zeit.hyper",
  "com.github.atom",
];

const TRADING_NAME_HINTS =
  /\b(robinhood|interactive brokers|ibkr|etrade|schwab|fidelity|coinbase|kraken|binance|tradingview|thinkorswim|tastytrade)\b/i;

function bundleStartsWithAny(bundleId: string, prefixes: string[]): boolean {
  const b = bundleId.trim().toLowerCase();
  return prefixes.some((p) => b.startsWith(p.toLowerCase()));
}

/**
 * Infer risk profile from bundle id and localized app name.
 */
export function classifyApp(bundleId: string, appName: string): AppRiskProfile {
  const name = (appName || "").trim();
  const bundle = (bundleId || "").trim();

  if (bundle === "com.apple.finder" || name.toLowerCase() === "finder") {
    return {
      riskClass: "finder",
      maxSuggestedLevel: "full_control",
      sentinelWarning:
        "Finder can read or write many files on disk. Only approve if this task requires Finder automation.",
    };
  }

  if (
    bundle === "com.apple.systempreferences" ||
    bundle.startsWith("com.apple.Settings") ||
    /system settings|system preferences/i.test(name)
  ) {
    return {
      riskClass: "system_settings",
      maxSuggestedLevel: "full_control",
      sentinelWarning:
        "System Settings can change macOS configuration. Only approve if you intend to allow settings changes.",
    };
  }

  if (
    bundleStartsWithAny(bundle, BROWSER_BUNDLE_PREFIXES) ||
    /\b(chrome|safari|firefox|brave|edge|opera)\b/i.test(name)
  ) {
    return {
      riskClass: "browser",
      maxSuggestedLevel: "view_only",
      sentinelWarning:
        "Browsers may show sensitive logged-in pages. Prefer view-only (screenshot/hover) unless you need clicks in this session.",
    };
  }

  if (
    bundleStartsWithAny(bundle, TERMINAL_IDE_BUNDLE_PREFIXES) ||
    /\b(terminal|iterm|vscode|code|cursor|xcode|warp)\b/i.test(name)
  ) {
    return {
      riskClass: "terminal_ide",
      maxSuggestedLevel: "click_only",
      sentinelWarning:
        "Terminals and IDEs are high-impact: clicks can run commands or edit files. Prefer click-only (no typing) unless you fully trust this task.",
    };
  }

  if (TRADING_NAME_HINTS.test(name) || /trading|broker/i.test(bundle)) {
    return {
      riskClass: "trading",
      maxSuggestedLevel: "view_only",
      sentinelWarning:
        "Trading platforms may expose financial data. Prefer view-only unless interaction is required.",
    };
  }

  return {
    riskClass: "generic",
    maxSuggestedLevel: "full_control",
  };
}

export function formatAccessLevelForUi(level: AppAccessLevel): string {
  switch (level) {
    case "view_only":
      return "view-only (screenshot & hover)";
    case "click_only":
      return "click-only (mouse, no typing)";
    case "full_control":
      return "full control (mouse & keyboard)";
    default:
      return level;
  }
}
