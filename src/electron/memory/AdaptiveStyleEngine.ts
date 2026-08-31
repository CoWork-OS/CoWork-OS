/**
 * AdaptiveStyleEngine — Learns user communication preferences from observed patterns
 *
 * Observes user messages and feedback signals over time, then gradually adjusts
 * the PersonalityManager's ResponseStylePreferences to match. All changes are
 * rate-limited (max N shifts per week), auditable, and admin-disableable via
 * GuardrailSettings.adaptiveStyleEnabled.
 *
 * Signals observed:
 *  - Message length distribution → responseLength preference
 *  - Emoji frequency → emojiUsage preference
 *  - Technical vocabulary density → explanationDepth preference
 *  - Explicit feedback ("too verbose", "more detail") → direct style adjustment
 *
 * Enterprise value:
 *  - Reduces correction overhead as the agent learns team communication norms
 *  - All adaptations are auditable and rate-limited by admin-configurable guardrails
 */

import {
  type EmojiUsage,
  type ExplanationDepth,
  type ResponseLength,
  type ResponseStylePreferences,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { GuardrailManager } from "../guardrails/guardrail-manager";
import { PersonalityManager } from "../settings/personality-manager";

// ─── Types ────────────────────────────────────────────────────────────

export interface StyleSignal {
  dimension: keyof ResponseStylePreferences;
  direction: "increase" | "decrease";
  strength: number; // 0-1
  source: "message_pattern" | "feedback" | "correction";
  observedAt: number;
}

export interface AdaptationRecord {
  dimension: keyof ResponseStylePreferences;
  fromValue: string;
  toValue: string;
  reason: string;
  appliedAt: number;
}

interface AdaptiveStyleState {
  /** Rolling window of recent user message lengths. */
  messageLengths: number[];
  /** Count of messages containing emoji in the observation window. */
  emojiMessageCount: number;
  /** Count of messages with high technical density in the window. */
  technicalMessageCount: number;
  /** Total messages observed in the current window. */
  totalMessages: number;
  /** Accumulated signals waiting to be applied. */
  pendingSignals: StyleSignal[];
  /** History of applied adaptations for audit trail. */
  adaptationHistory: AdaptationRecord[];
  /** Epoch ms of last adaptation application. */
  lastAdaptationAt: number;
  /** Number of adaptations applied this week (resets weekly). */
  weeklyAdaptationCount: number;
  /** Epoch ms of current week start. */
  weekStart: number;
}

// ─── Constants ────────────────────────────────────────────────────────

const OBSERVATION_WINDOW = 50; // Last N messages
const MIN_MESSAGES_FOR_ADAPTATION = 15; // Need enough signal before acting
const SIGNAL_THRESHOLD = 0.6; // Minimum accumulated signal strength to trigger
const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes between adaptation checks
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Emoji regex pattern — covers common emoji ranges */
const EMOJI_PATTERN =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

/** Technical vocabulary indicators */
const TECHNICAL_PATTERNS = [
  /\b(api|sdk|cli|sql|http|json|xml|yaml|css|html|jwt|oauth|ssl|tls)\b/i,
  /\b(function|class|interface|module|import|export|async|await|promise)\b/i,
  /\b(deploy|compile|runtime|debug|stack|heap|thread|mutex|semaphore)\b/i,
  /\b(docker|kubernetes|terraform|ansible|nginx|redis|postgres|mongo)\b/i,
  /\b(algorithm|complexity|recursion|iteration|binary|hash|tree|graph)\b/i,
];

// ─── Ordered Scales ──────────────────────────────────────────────────

const EMOJI_SCALE: EmojiUsage[] = ["none", "minimal", "moderate", "expressive"];
const LENGTH_SCALE: ResponseLength[] = ["terse", "balanced", "detailed"];
const DEPTH_SCALE: ExplanationDepth[] = ["expert", "balanced", "teaching"];

// ─── Helpers ──────────────────────────────────────────────────────────

function getDefaultState(): AdaptiveStyleState {
  return {
    messageLengths: [],
    emojiMessageCount: 0,
    technicalMessageCount: 0,
    totalMessages: 0,
    pendingSignals: [],
    adaptationHistory: [],
    lastAdaptationAt: 0,
    weeklyAdaptationCount: 0,
    weekStart: getWeekStart(),
  };
}

function getWeekStart(): number {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day; // Sunday-based
  return new Date(now.getFullYear(), now.getMonth(), diff, 0, 0, 0, 0).getTime();
}

function countEmojiInText(text: string): number {
  const matches = text.match(new RegExp(EMOJI_PATTERN.source, "gu"));
  return matches ? matches.length : 0;
}

function technicalDensity(text: string): number {
  if (!text || text.length < 20) return 0;
  let matchCount = 0;
  for (const pattern of TECHNICAL_PATTERNS) {
    if (pattern.test(text)) matchCount++;
  }
  return matchCount / TECHNICAL_PATTERNS.length;
}

function shiftOnScale<T>(scale: T[], current: T, direction: "increase" | "decrease"): T | null {
  const idx = scale.indexOf(current);
  if (idx === -1) return null;
  const newIdx = direction === "increase" ? idx + 1 : idx - 1;
  if (newIdx < 0 || newIdx >= scale.length) return null;
  return scale[newIdx];
}

// ─── Main Engine ──────────────────────────────────────────────────────

export class AdaptiveStyleEngine {
  /**
   * Observe a user message and accumulate style signals.
   * Called after each user message in daemon.ts.
   */
  static observe(message: string): void {
    if (!this.isEnabled()) return;

    const text = String(message || "").trim();
    if (!text || text.length < 5) return;

    const state = this.loadState();
    this.resetWeekIfNeeded(state);

    // Track message length (rolling window)
    state.messageLengths.push(text.length);
    if (state.messageLengths.length > OBSERVATION_WINDOW) {
      state.messageLengths.shift();
    }

    // Track emoji usage
    if (countEmojiInText(text) > 0) {
      state.emojiMessageCount++;
    }

    // Track technical vocabulary density
    if (technicalDensity(text) > 0.3) {
      state.technicalMessageCount++;
    }

    state.totalMessages++;
    this.saveState(state);

    // Check if we should attempt adaptation (debounced)
    if (
      state.totalMessages >= MIN_MESSAGES_FOR_ADAPTATION &&
      Date.now() - state.lastAdaptationAt > DEBOUNCE_MS
    ) {
      this.maybeAdapt();
    }
  }

  /**
   * Process an explicit feedback signal (e.g., "too verbose", "more detail").
   * These have higher weight than pattern observations.
   */
  static observeFeedback(decision?: string, reason?: string): void {
    if (!this.isEnabled()) return;

    const feedback = String(reason || "")
      .trim()
      .toLowerCase();
    if (!feedback) return;

    const state = this.loadState();
    this.resetWeekIfNeeded(state);

    // Direct style signals from feedback
    if (/\b(concise|shorter|too long|brief|verbose|wordy)\b/.test(feedback)) {
      state.pendingSignals.push({
        dimension: "responseLength",
        direction: "decrease",
        strength: 0.8,
        source: "feedback",
        observedAt: Date.now(),
      });
    }

    if (/\b(more detail|detailed|deeper|elaborate|expand)\b/.test(feedback)) {
      state.pendingSignals.push({
        dimension: "responseLength",
        direction: "increase",
        strength: 0.8,
        source: "feedback",
        observedAt: Date.now(),
      });
    }

    if (/\b(emoji|emojis|smiley)\b/.test(feedback)) {
      const direction =
        /\b(no|stop|fewer|less|without|remove|don't|disable)\b.*\b(emoji|emojis)\b/.test(feedback)
          ? "decrease"
          : "increase";
      state.pendingSignals.push({
        dimension: "emojiUsage",
        direction,
        strength: 0.9,
        source: "feedback",
        observedAt: Date.now(),
      });
    }

    if (/\b(too technical|simpler|explain more|eli5|beginner)\b/.test(feedback)) {
      state.pendingSignals.push({
        dimension: "explanationDepth",
        direction: "increase", // more teaching
        strength: 0.7,
        source: "feedback",
        observedAt: Date.now(),
      });
    }

    if (/\b(skip basics|i know|expert|advanced|don't explain)\b/.test(feedback)) {
      state.pendingSignals.push({
        dimension: "explanationDepth",
        direction: "decrease", // more expert
        strength: 0.7,
        source: "feedback",
        observedAt: Date.now(),
      });
    }

    this.saveState(state);
    this.maybeAdapt();
  }

  /**
   * Analyse accumulated signals and apply style adjustments if warranted.
   * Respects rate limits from GuardrailSettings.
   */
  static maybeAdapt(): void {
    if (!this.isEnabled()) return;

    const state = this.loadState();
    this.resetWeekIfNeeded(state);

    const guardrails = GuardrailManager.loadSettings();
    const maxDrift = guardrails.adaptiveStyleMaxDriftPerWeek ?? 1;

    if (state.weeklyAdaptationCount >= maxDrift) return;

    const currentStyle = this.getCurrentStyle();
    const adaptations: Array<{
      dimension: keyof ResponseStylePreferences;
      newValue: string;
      reason: string;
    }> = [];

    // ── Process pending feedback signals (high priority) ──────────

    const feedbackSignals = state.pendingSignals.filter((s) => s.source === "feedback");
    for (const signal of feedbackSignals) {
      if (state.weeklyAdaptationCount + adaptations.length >= maxDrift) break;

      const result = this.applySignalToStyle(currentStyle, signal);
      if (result) {
        adaptations.push(result);
      }
    }

    // ── Process pattern-based signals (lower priority) ────────────

    if (
      state.totalMessages >= MIN_MESSAGES_FOR_ADAPTATION &&
      state.weeklyAdaptationCount + adaptations.length < maxDrift
    ) {
      const patternAdaptation = this.derivePatternSignal(state, currentStyle);
      if (patternAdaptation) {
        adaptations.push(patternAdaptation);
      }
    }

    // ── Apply adaptations ─────────────────────────────────────────

    if (adaptations.length === 0) {
      // Clear processed feedback signals even if no adaptation
      state.pendingSignals = state.pendingSignals.filter((s) => s.source !== "feedback");
      this.saveState(state);
      return;
    }

    const styleUpdate: Partial<ResponseStylePreferences> = {};
    for (const adaptation of adaptations) {
      (styleUpdate as Record<string, string>)[adaptation.dimension] = adaptation.newValue;

      state.adaptationHistory.push({
        dimension: adaptation.dimension,
        fromValue: String(currentStyle[adaptation.dimension]),
        toValue: adaptation.newValue,
        reason: adaptation.reason,
        appliedAt: Date.now(),
      });
    }

    // Keep history manageable
    if (state.adaptationHistory.length > 100) {
      state.adaptationHistory = state.adaptationHistory.slice(-50);
    }

    PersonalityManager.setResponseStyle(styleUpdate);
    state.weeklyAdaptationCount += adaptations.length;
    state.lastAdaptationAt = Date.now();
    state.pendingSignals = state.pendingSignals.filter((s) => s.source !== "feedback");
    this.saveState(state);
  }

  /**
   * Get the full adaptation history for audit/display purposes.
   */
  static getAdaptationHistory(): AdaptationRecord[] {
    return this.loadState().adaptationHistory;
  }

  /**
   * Get current observation stats for the evolution dashboard.
   */
  static getObservationStats(): {
    totalMessages: number;
    weeklyAdaptations: number;
    maxWeeklyDrift: number;
    enabled: boolean;
    lastAdaptationAt: number;
  } {
    const state = this.loadState();
    const guardrails = GuardrailManager.loadSettings();
    return {
      totalMessages: state.totalMessages,
      weeklyAdaptations: state.weeklyAdaptationCount,
      maxWeeklyDrift: guardrails.adaptiveStyleMaxDriftPerWeek ?? 1,
      enabled: this.isEnabled(),
      lastAdaptationAt: state.lastAdaptationAt,
    };
  }

  /**
   * Reset all accumulated state. Useful for testing or admin reset.
   */
  static reset(): void {
    this.saveState(getDefaultState());
  }

  // ── Private ─────────────────────────────────────────────────────────

  private static isEnabled(): boolean {
    try {
      const guardrails = GuardrailManager.loadSettings();
      return guardrails.adaptiveStyleEnabled === true;
    } catch {
      return false;
    }
  }

  private static getCurrentStyle(): ResponseStylePreferences {
    const defaults: ResponseStylePreferences = {
      emojiUsage: "minimal",
      responseLength: "balanced",
      codeCommentStyle: "moderate",
      explanationDepth: "balanced",
    };
    try {
      const settings = PersonalityManager.loadSettings();
      return { ...defaults, ...settings.responseStyle };
    } catch {
      return defaults;
    }
  }

  private static applySignalToStyle(
    current: ResponseStylePreferences,
    signal: StyleSignal,
  ): { dimension: keyof ResponseStylePreferences; newValue: string; reason: string } | null {
    switch (signal.dimension) {
      case "emojiUsage": {
        const shifted = shiftOnScale(EMOJI_SCALE, current.emojiUsage, signal.direction);
        if (shifted) {
          return {
            dimension: "emojiUsage",
            newValue: shifted,
            reason: `${signal.source}: user ${signal.direction === "increase" ? "wants more" : "wants fewer"} emojis`,
          };
        }
        return null;
      }
      case "responseLength": {
        const shifted = shiftOnScale(LENGTH_SCALE, current.responseLength, signal.direction);
        if (shifted) {
          return {
            dimension: "responseLength",
            newValue: shifted,
            reason: `${signal.source}: user prefers ${signal.direction === "increase" ? "more detailed" : "shorter"} responses`,
          };
        }
        return null;
      }
      case "explanationDepth": {
        const shifted = shiftOnScale(DEPTH_SCALE, current.explanationDepth, signal.direction);
        if (shifted) {
          return {
            dimension: "explanationDepth",
            newValue: shifted,
            reason: `${signal.source}: user prefers ${signal.direction === "increase" ? "more teaching" : "more expert-level"} explanations`,
          };
        }
        return null;
      }
      default:
        return null;
    }
  }

  private static derivePatternSignal(
    state: AdaptiveStyleState,
    currentStyle: ResponseStylePreferences,
  ): { dimension: keyof ResponseStylePreferences; newValue: string; reason: string } | null {
    if (state.messageLengths.length < MIN_MESSAGES_FOR_ADAPTATION) return null;

    // ── Response length: infer from user's message length distribution ──
    const avgLength = state.messageLengths.reduce((a, b) => a + b, 0) / state.messageLengths.length;
    // Short messages (<80 chars avg) suggest user prefers brevity
    if (avgLength < 80 && currentStyle.responseLength !== "terse") {
      const shifted = shiftOnScale(LENGTH_SCALE, currentStyle.responseLength, "decrease");
      if (shifted) {
        return {
          dimension: "responseLength",
          newValue: shifted,
          reason: `message_pattern: user avg message length is ${Math.round(avgLength)} chars, suggesting preference for brevity`,
        };
      }
    }
    // Long messages (>300 chars avg) suggest user wants detail
    if (avgLength > 300 && currentStyle.responseLength !== "detailed") {
      const shifted = shiftOnScale(LENGTH_SCALE, currentStyle.responseLength, "increase");
      if (shifted) {
        return {
          dimension: "responseLength",
          newValue: shifted,
          reason: `message_pattern: user avg message length is ${Math.round(avgLength)} chars, suggesting preference for detail`,
        };
      }
    }

    // ── Emoji: infer from user's emoji frequency ──
    const emojiRate = state.emojiMessageCount / state.totalMessages;
    if (emojiRate > 0.4 && EMOJI_SCALE.indexOf(currentStyle.emojiUsage) < 2) {
      const shifted = shiftOnScale(EMOJI_SCALE, currentStyle.emojiUsage, "increase");
      if (shifted) {
        return {
          dimension: "emojiUsage",
          newValue: shifted,
          reason: `message_pattern: ${Math.round(emojiRate * 100)}% of user messages contain emoji`,
        };
      }
    }
    if (emojiRate < 0.05 && EMOJI_SCALE.indexOf(currentStyle.emojiUsage) > 0) {
      const shifted = shiftOnScale(EMOJI_SCALE, currentStyle.emojiUsage, "decrease");
      if (shifted) {
        return {
          dimension: "emojiUsage",
          newValue: shifted,
          reason: `message_pattern: user rarely uses emoji (${Math.round(emojiRate * 100)}%)`,
        };
      }
    }

    // ── Technical depth: infer from vocabulary ──
    const techRate = state.technicalMessageCount / state.totalMessages;
    if (techRate > 0.6 && currentStyle.explanationDepth !== "expert") {
      const shifted = shiftOnScale(DEPTH_SCALE, currentStyle.explanationDepth, "decrease");
      if (shifted) {
        return {
          dimension: "explanationDepth",
          newValue: shifted,
          reason: `message_pattern: ${Math.round(techRate * 100)}% of messages use technical vocabulary`,
        };
      }
    }

    return null;
  }

  private static resetWeekIfNeeded(state: AdaptiveStyleState): void {
    const currentWeekStart = getWeekStart();
    if (state.weekStart < currentWeekStart) {
      state.weekStart = currentWeekStart;
      state.weeklyAdaptationCount = 0;
    }
  }

  private static loadState(): AdaptiveStyleState {
    try {
      const stored =
        SecureSettingsRepository.getInstance().load<AdaptiveStyleState>("adaptive-style-engine");
      if (stored) return { ...getDefaultState(), ...stored };
    } catch {
      // fresh start — repository may not be initialized yet
    }
    return getDefaultState();
  }

  private static saveState(state: AdaptiveStyleState): void {
    try {
      SecureSettingsRepository.getInstance().save("adaptive-style-engine", state);
    } catch {
      // best-effort — don't crash observation on save failure
    }
  }
}
