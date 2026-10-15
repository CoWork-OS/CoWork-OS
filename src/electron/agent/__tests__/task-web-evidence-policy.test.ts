import { describe, expect, it } from "vitest";
import { needsTaskWebEvidence } from "../task-web-evidence-policy";

describe("task web evidence requirements", () => {
  it("does not require network evidence for Android Settings search acceptance", () => {
    expect(
      needsTaskWebEvidence(
        "Android Settings Search Acceptance Test",
        "On emulator-5554, tap Settings search, type a QA query, verify com.google.android.settings.intelligence and capture a screenshot using application_operation phone.android.action.",
      ),
    ).toBe(false);
  });
  it.each([
    "On Android, tap search and find today's news, then capture a screenshot.",
    "Use Android to search the web for phone-harness documentation and capture a screenshot.",
    "Search online for Android compatibility, then tap the emulator.",
    "Use web_search to research Android and capture a screenshot.",
  ])("keeps evidence required for actual external research: %s", (prompt) => {
    expect(needsTaskWebEvidence("Android test", prompt)).toBe(true);
  });
  it("preserves existing word boundaries, generic research and creation behavior", () => {
    expect(needsTaskWebEvidence("Researcher", "Read a local file")).toBe(false);
    expect(needsTaskWebEvidence("Research", "Search for alternatives")).toBe(true);
    expect(needsTaskWebEvidence("News app", "Build an app showing today's news")).toBe(false);
  });
});
