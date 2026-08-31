import { describe, expect, it } from "vitest";

import { evaluateDomainCompletion, getLoopGuardrailConfig } from "../completion-checks";

describe("completion-checks loop guardrails", () => {
  it("uses tighter follow-up lock thresholds for code-domain tasks", () => {
    const config = getLoopGuardrailConfig("code");
    expect(config.followUpLockMinStreak).toBe(10);
    expect(config.followUpLockMinToolCalls).toBe(10);
  });
});

describe("evaluateDomainCompletion", () => {
  // ── Not-last-step: always passes ────────────────────────────────────
  it("passes when isLastStep=false regardless of text", () => {
    expect(
      evaluateDomainCompletion({
        domain: "research",
        isLastStep: false,
        assistantText: "",
        hadAnyToolSuccess: false,
      }),
    ).toEqual({ failed: false });
  });

  // ── Code/operations: always passes ──────────────────────────────────
  it("passes for code domain with no text and no tool success", () => {
    expect(
      evaluateDomainCompletion({
        domain: "code",
        isLastStep: true,
        assistantText: "",
        hadAnyToolSuccess: false,
      }),
    ).toEqual({ failed: false });
  });

  // ── No tool success, no text ─────────────────────────────────────────
  it("passes for non-code domain with no text and no tool success (graceful)", () => {
    expect(
      evaluateDomainCompletion({
        domain: "general",
        isLastStep: true,
        assistantText: "",
        hadAnyToolSuccess: false,
      }),
    ).toEqual({ failed: false });
  });

  // ── Tool success + no text → always fails ────────────────────────────
  it("fails when tools succeeded but response is empty", () => {
    const result = evaluateDomainCompletion({
      domain: "research",
      isLastStep: true,
      assistantText: "",
      hadAnyToolSuccess: true,
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/summary/i);
  });

  // ── Research domain: tool success + substantive text → passes ────────
  it("passes for research domain when tools succeeded and response has findings", () => {
    const result = evaluateDomainCompletion({
      domain: "research",
      isLastStep: true,
      assistantText: "Found 3 relevant sources. According to the data, the trend is upward.",
      hadAnyToolSuccess: true,
    });
    expect(result.failed).toBe(false);
  });

  // ── Research domain: tool success + 'done' → still fails ─────────────
  it("fails for research domain when tools succeeded but response is just 'done'", () => {
    const result = evaluateDomainCompletion({
      domain: "research",
      isLastStep: true,
      assistantText: "done",
      hadAnyToolSuccess: true,
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/findings/i);
  });

  it("fails for research domain when tools succeeded but response is 'completed.'", () => {
    const result = evaluateDomainCompletion({
      domain: "research",
      isLastStep: true,
      assistantText: "completed.",
      hadAnyToolSuccess: true,
    });
    expect(result.failed).toBe(true);
  });

  // ── Writing domain: tool success + 'done' → still fails ──────────────
  it("fails for writing domain when tools succeeded but response is just 'finished'", () => {
    const result = evaluateDomainCompletion({
      domain: "writing",
      isLastStep: true,
      assistantText: "finished",
      hadAnyToolSuccess: true,
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/content/i);
  });

  // ── General domain: tool success + 'done' → passes (tool evidence suffices) ──
  it("passes for general domain when tools succeeded even with 'done' response", () => {
    const result = evaluateDomainCompletion({
      domain: "general",
      isLastStep: true,
      assistantText: "done",
      hadAnyToolSuccess: true,
    });
    expect(result.failed).toBe(false);
  });

  it("passes for a concise general-domain result when prior tool execution already succeeded", () => {
    const result = evaluateDomainCompletion({
      domain: "general",
      isLastStep: true,
      assistantText: "hello world",
      hadAnyToolSuccess: false,
      hadPriorToolSuccess: true,
      stepDescription: "Return the result directly.",
      taskIntent: "run command 'echo hello world'",
    });
    expect(result.failed).toBe(false);
  });

  it("fails for a general-domain status-only reply when only prior tool execution succeeded", () => {
    const result = evaluateDomainCompletion({
      domain: "general",
      isLastStep: true,
      assistantText: "done",
      hadAnyToolSuccess: false,
      hadPriorToolSuccess: true,
      stepDescription: "Return the result directly.",
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/actual result|next step/i);
  });

  // ── No tool success: NON_SUBSTANTIVE_RESPONSES still blocked ─────────
  it("fails when no tool success and response is a non-substantive phrase", () => {
    const result = evaluateDomainCompletion({
      domain: "general",
      isLastStep: true,
      assistantText: "all set",
      hadAnyToolSuccess: false,
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/brief/i);
  });

  it("passes for a concise literal reply when the task explicitly asks for direct output", () => {
    const result = evaluateDomainCompletion({
      domain: "general",
      isLastStep: true,
      assistantText: "42",
      hadAnyToolSuccess: false,
      stepDescription: "Return the result directly.",
      taskIntent: "Answer with exactly 42.",
    });
    expect(result.failed).toBe(false);
  });

  it("passes for a concise literal reply when the step asks for an exact quoted output", () => {
    const result = evaluateDomainCompletion({
      domain: "general",
      isLastStep: true,
      assistantText: "hello world",
      hadAnyToolSuccess: false,
      stepDescription: "Output is exactly `hello world`",
      taskIntent: 'run command "echo hello world"',
    });
    expect(result.failed).toBe(false);
  });

  it("passes for a concise literal reply when success is phrased as printed output", () => {
    const result = evaluateDomainCompletion({
      domain: "general",
      isLastStep: true,
      assistantText: "hello world",
      hadAnyToolSuccess: false,
      stepDescription: "Return the result clearly.",
      taskIntent:
        "You want the command run in the current session context, and success means it prints `hello world`.",
    });
    expect(result.failed).toBe(false);
  });

  it("passes for a concise literal reply when the step asks for an exact quoted exit code", () => {
    const result = evaluateDomainCompletion({
      domain: "general",
      isLastStep: true,
      assistantText: "0",
      hadAnyToolSuccess: false,
      stepDescription: "Exit code is `0`",
      taskIntent: 'run command "echo hello world"',
    });
    expect(result.failed).toBe(false);
  });

  // ── Research quality gate without tool success ────────────────────────
  it("fails for research domain without sufficient signal even with longer text", () => {
    const result = evaluateDomainCompletion({
      domain: "research",
      isLastStep: true,
      assistantText: "The topic is interesting and I looked into it a bit.",
      hadAnyToolSuccess: false,
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/findings/i);
  });

  it("passes for research domain with findings signal and sufficient length", () => {
    const result = evaluateDomainCompletion({
      domain: "research",
      isLastStep: true,
      assistantText:
        "According to three sources, the evidence strongly supports the conclusion that the market grew 12% in 2025.",
      hadAnyToolSuccess: false,
    });
    expect(result.failed).toBe(false);
  });
});
