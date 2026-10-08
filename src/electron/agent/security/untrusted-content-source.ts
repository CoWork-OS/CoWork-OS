/**
 * Taint for content that did not come from the user's workspace (docs/memory-repo-phase1-design.md
 * §7.3 item 2): web pages, browser pages, mailbox messages, channel history and business-agent
 * replies (PACT, `business://<interface origin>`). Tools that hand
 * such text to the model record it as a sensitive source read; `isUntrustedExternalSource`
 * then classifies the task as having read untrusted content, so an agent memory write after it
 * goes to the memory repo's `inbox.md`, and permission prompts show the recent untrusted read.
 */
import type { SensitiveSourceRef } from "../../../shared/types";

export type UntrustedContentChannel = "web" | "browser" | "mailbox" | "channel" | "business";

/** The part of a URL worth showing: no credentials, query or fragment. */
function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(raw || "")
      .split(/[?#]/)[0]
      .slice(0, 300);
  }
}

/**
 * A sensitive-source ref for external content. `location` is a URL (web, browser) or a
 * pseudo path such as `mailbox://<thread>` or `channel://<channel>/<chat>`.
 */
export function untrustedContentSource(
  channel: UntrustedContentChannel,
  location: string,
  tool: string,
): SensitiveSourceRef {
  const isUrl = channel === "web" || channel === "browser";
  return {
    path: isUrl ? displayUrl(location) : String(location || `${channel}://`).slice(0, 300),
    sourceKind: "unknown",
    trustLevel: "untrusted",
    sourceLabel: channel,
    metadata: { tool },
  };
}

/** Structural slice of the daemon the tools call. */
interface SensitiveSourceRecorder {
  recordSensitiveSourceRead?(taskId: string, source: SensitiveSourceRef): void;
}

/** Record an untrusted read for the task; never throws (taint is best effort for the tool). */
export function recordUntrustedContentRead(
  daemon: SensitiveSourceRecorder | null | undefined,
  taskId: string,
  channel: UntrustedContentChannel,
  location: string,
  tool: string,
): void {
  try {
    daemon?.recordSensitiveSourceRead?.(taskId, untrustedContentSource(channel, location, tool));
  } catch {
    // A missing runtime (finished task, test daemon) must not fail the read itself.
  }
}
