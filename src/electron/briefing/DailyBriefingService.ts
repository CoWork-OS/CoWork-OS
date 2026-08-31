/**
 * DailyBriefingService — generates unified morning briefings by composing
 * data from tasks, memory, suggestions, priorities, cron jobs, and daily logs.
 *
 * Can be scheduled via CronService or triggered on-demand.
 */

import { randomUUID } from "crypto";
import {
  Briefing,
  BriefingConfig,
  BriefingSection,
  BriefingItem,
  BriefingSectionType,
  DailyBriefingServiceDeps,
  DEFAULT_BRIEFING_CONFIG,
} from "./types";
import type { MailboxDigestSnapshot } from "../../shared/mailbox";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export class DailyBriefingService {
  private deps: DailyBriefingServiceDeps;
  private configs: Map<string, BriefingConfig> = new Map();
  private latestBriefings: Map<string, Briefing> = new Map();
  private db: Any;

  private static readonly LOW_SIGNAL_PATTERNS = [
    /^step (completed|failed):/i,
    /^tool result for /i,
    /^subconscious:/i,
    /^review recent heartbeat outcomes$/i,
    /^i found prior references/i,
    /^current focus suggests/i,
    /^this open loop is active/i,
    /^routine:/i,
    /\b(run_command|get_file_info|read_file|grep)\b/i,
  ];

  private static readonly BACKGROUND_TASK_PATTERNS = [
    /^subconscious:/i,
    /^heartbeat/i,
    /^verify:/i,
    /^review recent heartbeat outcomes$/i,
    /^step (completed|failed):/i,
    /^tool result for /i,
  ];

  private static readonly GENERIC_FOCUS_PATTERNS = [
    /\b(electron|codex|cursor|vs code|visual studio code|utm|chrome|edge|safari|terminal)\b/i,
    /\bco-?work os\b/i,
  ];

  private static readonly META_ACTION_PATTERNS = [
    /^prepare routine context/i,
    /^assemble a chief-of-staff briefing/i,
    /^capture current focus/i,
    /^organize next work session/i,
    /^prepare .*context/i,
    /\b(browser context|active app|current focus)\b/i,
  ];

  constructor(deps: DailyBriefingServiceDeps, db?: Any) {
    this.deps = deps;
    this.db = db;
    this.ensureSchema();
  }

  // ── Main generation ─────────────────────────────────────────────

  async generateBriefing(
    workspaceId: string,
    configOverride?: Partial<BriefingConfig>,
  ): Promise<Briefing> {
    const config = { ...this.getConfig(workspaceId), ...configOverride };
    const sections: BriefingSection[] = [];

    try {
      await this.deps.refreshSuggestions?.(workspaceId);
    } catch (err) {
      this.log("[DailyBriefing] refreshSuggestions skipped:", err);
    }

    const sectionGenerators: Record<
      BriefingSectionType,
      () => BriefingSection | Promise<BriefingSection>
    > = {
      task_summary: () => this.buildTaskSummary(workspaceId),
      awareness_digest: () => this.buildAwarenessDigest(workspaceId),
      active_suggestions: () => this.buildSuggestions(workspaceId),
      priority_review: () => this.buildPriorities(workspaceId),
      memory_highlights: () => this.buildMemoryHighlights(workspaceId),
      upcoming_jobs: () => this.buildUpcomingJobs(workspaceId),
      open_loops: () => this.buildOpenLoops(workspaceId),
      mailbox_summary: () => this.buildMailboxSummary(workspaceId),
      evolution_metrics: () => this.buildEvolutionMetrics(workspaceId),
    };

    for (const [sectionType, generator] of Object.entries(sectionGenerators)) {
      const enabled = config.enabledSections[sectionType as BriefingSectionType] ?? true;
      try {
        const section = await generator();
        section.enabled = enabled;
        if (enabled && section.items.length > 0) {
          sections.push(section);
        }
      } catch (err) {
        this.log(`[DailyBriefing] Error generating ${sectionType}:`, err);
      }
    }

    const briefing: Briefing = {
      id: randomUUID(),
      workspaceId,
      generatedAt: Date.now(),
      sections,
      delivered: false,
    };

    this.latestBriefings.set(workspaceId, briefing);
    this.saveBriefingToDB(briefing);

    // Auto-deliver if configured
    if (config.deliveryChannelType && config.deliveryChannelId && this.deps.deliverToChannel) {
      try {
        const text = this.formatBriefingAsText(briefing);
        await this.deps.deliverToChannel({
          channelType: config.deliveryChannelType,
          channelId: config.deliveryChannelId,
          text,
        });
        briefing.delivered = true;
        this.saveBriefingToDB(briefing);
      } catch (err) {
        this.log("[DailyBriefing] Failed to deliver:", err);
      }
    }

    return briefing;
  }

  renderBriefingAsText(briefing: Briefing): string {
    return this.formatBriefingAsText(briefing);
  }

  getLatestBriefing(workspaceId: string): Briefing | undefined {
    return this.latestBriefings.get(workspaceId) || this.loadLatestFromDB(workspaceId);
  }

  // ── Section builders ────────────────────────────────────────────

  private formatWorkspaceLabel(item: Any): string | null {
    if (typeof item?.workspaceName === "string" && item.workspaceName.trim()) {
      return item.workspaceName.trim();
    }
    if (typeof item?.workspaceId === "string" && item.workspaceId.trim()) {
      return item.workspaceId.trim();
    }
    return null;
  }

  private prefixWorkspace(item: Any, text: string): string {
    const label = this.formatWorkspaceLabel(item);
    return label ? `[${label}] ${text}` : text;
  }

  private stripWorkspacePrefix(text: string): string {
    return String(text || "")
      .trim()
      .replace(/^\[[^\]]+\]\s*/, "")
      .replace(/\s+/g, " ");
  }

  private joinWorkspaceLabels(...items: Any[]): string | undefined {
    const labels = new Set<string>();
    for (const item of items) {
      const label = this.formatWorkspaceLabel(item);
      if (label) labels.add(label);
    }
    return labels.size > 0 ? [...labels].join(", ") : undefined;
  }

  private cleanLabel(text: string | undefined): string {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/\s+—\s+$/, "")
      .trim();
  }

  private stripMarkdownFormatting(text: string | undefined): string {
    return String(text || "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/__(.*?)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
  }

  private normalizeSemanticText(text: string | undefined): string {
    return this.cleanLabel(this.stripMarkdownFormatting(text))
      .replace(/(^|:\s*)\[[^\]]+\]\s*/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isLowSignalText(text: string | undefined): boolean {
    const normalized = this.cleanLabel(text);
    if (!normalized) return true;
    return DailyBriefingService.LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  private isBackgroundTask(title: string | undefined): boolean {
    const normalized = this.cleanLabel(this.stripWorkspacePrefix(title || ""));
    if (!normalized) return true;
    return DailyBriefingService.BACKGROUND_TASK_PATTERNS.some((pattern) =>
      pattern.test(normalized),
    );
  }

  private isGenericFocus(text: string | undefined): boolean {
    const normalized = this.cleanLabel(text);
    if (!normalized) return true;
    if (/^all workspaces$/i.test(normalized)) return true;
    return DailyBriefingService.GENERIC_FOCUS_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  private isMetaActionText(text: string | undefined): boolean {
    const normalized = this.normalizeSemanticText(text);
    if (!normalized) return true;
    return DailyBriefingService.META_ACTION_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  private parsePriorityLines(raw: string): string[] {
    const lines = raw.split(/\r?\n/);
    const currentHeadingIndex = lines.findIndex((line) => /^##\s+current\s*$/i.test(line.trim()));
    const selected: string[] = [];
    if (currentHeadingIndex >= 0) {
      for (const line of lines.slice(currentHeadingIndex + 1)) {
        if (/^##\s+/.test(line.trim())) break;
        selected.push(line);
      }
    } else {
      selected.push(...lines);
    }
    return selected
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => this.stripMarkdownFormatting(line.replace(/^[-*\d.]+\s*/, "").trim()))
      .filter(Boolean);
  }

  private priorityScore(text: string, originalIndex: number): number {
    const normalized = text.toLowerCase();
    let score = 30 - originalIndex;
    if (
      /\b(today|this week|now|urgent|block|blocked|release|ship|fix|test|docs|review|follow up|resolve|publish|launch|cleanup|stability|polish)\b/.test(
        normalized,
      )
    ) {
      score += 8;
    }
    if (
      /^(fix|ship|review|resolve|publish|launch|document|test|clean|organize|follow up|finish)\b/.test(
        normalized,
      )
    ) {
      score += 4;
    }
    if (
      /\b(marketplace|ecosystem|sustainability|enterprise|partnership|mobile companion|licensing|multi-tenant)\b/.test(
        normalized,
      )
    ) {
      score -= 8;
    }
    if (text.length > 120) score -= 3;
    if (text.length <= 72) score += 2;
    return score;
  }

  private isUsefulAwarenessItem(item: Any): boolean {
    const title = this.normalizeSemanticText(
      this.stripWorkspacePrefix(item?.title || item?.label || ""),
    );
    const detail = this.cleanLabel(item?.detail || item?.description || "");
    if (!title) return false;
    if (this.isLowSignalText(title)) return false;
    if (detail && this.isLowSignalText(detail)) return false;
    if (this.isMetaActionText(title) || this.isMetaActionText(detail)) return false;
    const source = String(item?.source || "").toLowerCase();
    const tags = Array.isArray(item?.tags)
      ? item.tags.map((tag: unknown) => String(tag).toLowerCase())
      : [];
    if ((source === "apps" || source === "browser") && this.isGenericFocus(`${title} ${detail}`)) {
      return false;
    }
    if (source === "apps" || source === "browser") {
      return tags.includes("deadline") || tags.includes("workflow") || tags.includes("context");
    }
    return true;
  }

  private isUsefulSuggestion(item: Any): boolean {
    const title = this.normalizeSemanticText(item?.title || item?.label || item?.description || "");
    const detail = this.normalizeSemanticText(item?.description || item?.detail || "");
    if (!title) return false;
    if (this.isLowSignalText(title)) return false;
    if (detail && this.isLowSignalText(detail)) return false;
    if (this.isMetaActionText(title) || this.isMetaActionText(detail)) return false;
    if (this.isGenericFocus(`${title} ${detail}`)) return false;
    return /^(review|fix|ship|follow up|resolve|publish|finish|check|update|triage|prepare|draft|test|clean|optimize)/i.test(
      title,
    );
  }

  private decisionScore(decision: Any): number {
    const title = this.normalizeSemanticText(this.stripWorkspacePrefix(decision?.title || ""));
    const detail = this.normalizeSemanticText(
      this.stripWorkspacePrefix(decision?.description || ""),
    );
    let score = 0;
    if (!title || this.isLowSignalText(title)) return -100;
    if (detail && this.isLowSignalText(detail)) return -100;
    if (this.isMetaActionText(title) || this.isMetaActionText(detail)) return -100;
    if (decision?.priority === "high") score += 10;
    if (
      /\b(block|blocked|urgent|risk|deadline|security|follow up|review|finish|ship|fix)\b/i.test(
        `${title} ${detail}`,
      )
    ) {
      score += 6;
    }
    if (title.length <= 96) score += 2;
    return score;
  }

  private outcomeScore(task: Any): number {
    const title = this.normalizeSemanticText(task?.title || "");
    let score = 0;
    if (!title || this.isBackgroundTask(title) || this.isLowSignalText(title)) return -100;
    if (
      /^(fix|ship|release|publish|deploy|build|implement|refactor|document|add|remove|resolve|launch|clean)/i.test(
        title,
      )
    ) {
      score += 8;
    }
    if (task?.workspaceName) score += 1;
    if (title.length <= 90) score += 2;
    return score;
  }

  private goalScore(goal: Any): number {
    const title = this.normalizeSemanticText(goal?.title || "");
    if (!title || this.isLowSignalText(title)) return -100;
    if (this.isMetaActionText(title)) return -100;
    let score = 0;
    if (goal?.status === "blocked") score += 10;
    if (goal?.status === "active") score += 3;
    score += Math.round((goal?.confidence || 0) * 5);
    if (title.length <= 110) score += 2;
    return score;
  }

  private evolutionHasEnoughSignal(snapshot: Any): boolean {
    const byId = new Map<string, { value?: number }>(
      (snapshot?.metrics || []).map((metric: Any) => [
        String(metric?.id || ""),
        metric as { value?: number },
      ]),
    );
    return (
      Number(byId.get("knowledge_growth")?.value || 0) > 0 ||
      Number(byId.get("task_success_rate")?.value || 0) > 0 ||
      Number(byId.get("adaptation_velocity")?.value || 0) > 0 ||
      Number(byId.get("correction_rate")?.value || 0) > 0
    );
  }

  private dedupeBriefingItems(items: Any[], keyFn: (item: Any) => string, limit?: number): Any[] {
    const map = new Map<string, Any>();
    for (const item of items) {
      const key = keyFn(item);
      if (!key) continue;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...item });
        continue;
      }
      const mergedWorkspaceName = this.joinWorkspaceLabels(existing, item);
      if (mergedWorkspaceName) {
        existing.workspaceName = mergedWorkspaceName;
      }
      if (!existing.detail && item.detail) existing.detail = item.detail;
      if (!existing.link && item.link) existing.link = item.link;
      if (!existing.status && item.status) existing.status = item.status;
      if (typeof existing.relevanceScore === "number" && typeof item.relevanceScore === "number") {
        if (item.relevanceScore > existing.relevanceScore) {
          existing.relevanceScore = item.relevanceScore;
        }
      }
      if (typeof existing.confidence === "number" && typeof item.confidence === "number") {
        if (item.confidence > existing.confidence) {
          existing.confidence = item.confidence;
        }
      }
    }
    return [...map.values()].slice(0, limit ?? map.size);
  }

  private buildTaskSummary(workspaceId: string): BriefingSection {
    const since = Date.now() - TWENTY_FOUR_HOURS_MS;
    const tasks = this.deps.getRecentTasks(workspaceId, since);

    const completed = tasks.filter((t: Any) => t.status === "completed");
    const failed = tasks.filter((t: Any) => t.status === "failed");
    const pending = tasks.filter((t: Any) => t.status === "pending" || t.status === "queued");
    const running = tasks.filter((t: Any) => t.status === "running" || t.status === "executing");
    const notableFailed = failed.filter((task: Any) => !this.isBackgroundTask(task.title));
    const backgroundFailedCount = failed.length - notableFailed.length;
    const workspaceCount = new Set(
      tasks.map((task: Any) => this.formatWorkspaceLabel(task)).filter(Boolean),
    ).size;

    const items: BriefingItem[] = [];
    if (completed.length > 0)
      items.push({
        label: `${completed.length} completed${workspaceCount > 1 ? ` across ${workspaceCount} workspaces` : ""}`,
        status: "completed",
      });
    if (running.length > 0)
      items.push({ label: `${running.length} in progress`, status: "running" });
    if (pending.length > 0) items.push({ label: `${pending.length} pending`, status: "pending" });
    if (failed.length > 0)
      items.push({
        label: `${failed.length} failed`,
        status: "failed",
        detail:
          [
            notableFailed.length > 0 ? notableFailed.map((t: Any) => t.title).join(", ") : null,
            backgroundFailedCount > 0
              ? `${backgroundFailedCount} background automation failure${backgroundFailedCount === 1 ? "" : "s"}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      });

    const notableCompleted = completed
      .filter((task: Any) => !this.isBackgroundTask(task.title))
      .sort((a: Any, b: Any) => this.outcomeScore(b) - this.outcomeScore(a));
    const backgroundCompletedCount = completed.length - notableCompleted.length;
    for (const t of this.dedupeBriefingItems(
      notableCompleted.slice(0, 20),
      (item) => this.stripWorkspacePrefix(item.title || ""),
      3,
    )) {
      items.push({
        label: this.prefixWorkspace(t, t.title),
        status: "completed",
        link: { taskId: t.id },
      });
    }
    if (backgroundCompletedCount > 0) {
      items.push({
        label: `${backgroundCompletedCount} background automation task${backgroundCompletedCount === 1 ? "" : "s"} completed`,
        status: "info",
      });
    }

    return { type: "task_summary", title: "Executive Summary", items, enabled: true };
  }

  private buildMemoryHighlights(workspaceId: string): BriefingSection {
    const memories = this.dedupeBriefingItems(
      [
        ...this.deps.searchMemory(workspaceId, "recent learning insight", 5),
        ...this.deps.searchMemory(workspaceId, "workflow pattern", 5),
        ...this.deps.searchMemory(workspaceId, "preference correction", 5),
        ...this.deps.searchMemory(workspaceId, "constraint", 5),
      ].filter((memory: Any) => {
        const type = String(memory?.type || "");
        if (
          ![
            "preference",
            "constraint",
            "timing_preference",
            "workflow_pattern",
            "correction_rule",
          ].includes(type)
        ) {
          return false;
        }
        const text = memory?.summary || memory?.content || memory?.snippet || "";
        return !this.isLowSignalText(text);
      }),
      (item) =>
        `${item.id || ""}::${this.stripWorkspacePrefix(item.summary || item.content || item.snippet || "")}`,
      6,
    );
    const items: BriefingItem[] = this.dedupeBriefingItems(
      memories.map((m: Any) => ({
        ...m,
        label: this.prefixWorkspace(m, m.summary || m.content?.slice(0, 100) || "Memory item"),
      })),
      (item) => this.stripWorkspacePrefix(item.label || item.summary || item.content || ""),
      5,
    ).map((m: Any) => ({
      label: `${this.describeMemoryType(m.type)} ${m.label}`.trim(),
      detail:
        [m.workspaceName ? `Workspaces: ${m.workspaceName}` : null, this.memoryTypeDetail(m.type)]
          .filter(Boolean)
          .join(" · ") || undefined,
      status: "info" as const,
    }));
    return { type: "memory_highlights", title: "Durable Changes", items, enabled: true };
  }

  private buildSuggestions(workspaceId: string): BriefingSection {
    const suggestions = [...this.deps.getActiveSuggestions(workspaceId)].sort((a: Any, b: Any) => {
      const urgencyScore = (value: string | undefined) =>
        value === "high" ? 3 : value === "medium" ? 2 : value === "low" ? 1 : 0;
      const deliveryScore = (value: string | undefined) =>
        value === "nudge" ? 3 : value === "inbox" ? 2 : value === "briefing" ? 1 : 0;
      const combinedA =
        urgencyScore(a.urgency) * 10 +
        deliveryScore(a.recommendedDelivery) * 5 +
        (a.confidence || 0);
      const combinedB =
        urgencyScore(b.urgency) * 10 +
        deliveryScore(b.recommendedDelivery) * 5 +
        (b.confidence || 0);
      return combinedB - combinedA;
    });
    const items: BriefingItem[] = this.dedupeBriefingItems(
      suggestions
        .filter((s: Any) => this.isUsefulSuggestion(s))
        .slice(0, 20)
        .map((s: Any) => ({
          ...s,
          label: this.prefixWorkspace(s, s.title || s.description),
        })),
      (item) =>
        `${this.normalizeSemanticText(item.label || item.title || "")}::${this.normalizeSemanticText(
          item.detail || item.description || "",
        )}`,
      3,
    ).map((s: Any) => ({
      label: this.stripMarkdownFormatting(s.label),
      detail: [s.description || "", s.workspaceName ? `Workspaces: ${s.workspaceName}` : null]
        .filter(Boolean)
        .join(" · "),
      status: "info" as const,
    }));
    return { type: "active_suggestions", title: "Recommended Next Actions", items, enabled: true };
  }

  private describeMemoryType(type: string | undefined): string {
    switch (type) {
      case "preference":
        return "Preference:";
      case "constraint":
        return "Constraint:";
      case "timing_preference":
        return "Timing preference:";
      case "workflow_pattern":
        return "Workflow pattern:";
      case "correction_rule":
        return "Correction learned:";
      default:
        return "";
    }
  }

  private memoryTypeDetail(type: string | undefined): string | undefined {
    switch (type) {
      case "preference":
        return "Companion-learned preference";
      case "constraint":
        return "Companion-learned constraint";
      case "timing_preference":
        return "Attention and interruption pattern";
      case "workflow_pattern":
        return "Promoted reusable workflow signal";
      case "correction_rule":
        return "Suppression rule from user correction";
      default:
        return undefined;
    }
  }

  private buildPriorities(workspaceId: string): BriefingSection {
    const raw = this.deps.getPriorities(workspaceId);
    if (!raw) return { type: "priority_review", title: "Priorities", items: [], enabled: true };
    const lines = this.parsePriorityLines(raw);
    const ranked = lines
      .map((line: string, index: number) => ({
        line,
        index,
        score: this.priorityScore(line, index),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const items: BriefingItem[] = this.dedupeBriefingItems(
      ranked.slice(0, 12).map(({ line }: { line: string }) => ({
        label: line.replace(/^[-*\d.]+\s*/, "").trim(),
      })),
      (item) => this.stripWorkspacePrefix(item.label || ""),
      5,
    ).map((item: Any) => ({
      label: item.label,
      detail: item.workspaceName ? `Workspaces: ${item.workspaceName}` : undefined,
      status: "info" as const,
    }));
    const hiddenCount = Math.max(0, lines.length - items.length);
    if (hiddenCount > 0) {
      items.push({
        label: `${hiddenCount} lower-immediacy priorities hidden`,
        detail: "Showing the most action-ready priorities first.",
        status: "info",
      });
    }
    return { type: "priority_review", title: "Strategic Priorities", items, enabled: true };
  }

  private async buildUpcomingJobs(workspaceId: string): Promise<BriefingSection> {
    const jobs = await this.deps.getUpcomingJobs(workspaceId, 5);
    const items: BriefingItem[] = jobs.map((j: Any) => {
      const nextRun = j.state?.nextRunAtMs
        ? new Date(j.state.nextRunAtMs).toLocaleTimeString()
        : "—";
      return {
        label: this.prefixWorkspace(j, j.name || j.taskTitle || "Scheduled job"),
        detail: `${j.workspaceName ? `Workspace: ${j.workspaceName} · ` : ""}Next: ${nextRun}`,
        status: "pending" as const,
      };
    });
    return { type: "upcoming_jobs", title: "Upcoming Scheduled Jobs", items, enabled: true };
  }

  private buildOpenLoops(workspaceId: string): BriefingSection {
    const loops = this.deps.getOpenLoops(workspaceId);
    const items: BriefingItem[] = this.dedupeBriefingItems(
      loops.slice(0, 20).map((line: string) => ({
        label: line.replace(/^[-*]+\s*/, "").trim(),
      })),
      (item) => this.stripWorkspacePrefix(item.label || ""),
      8,
    ).map((item: Any) => ({
      label: item.label,
      detail: item.workspaceName ? `Workspaces: ${item.workspaceName}` : undefined,
      status: "pending" as const,
    }));
    return { type: "open_loops", title: "Open Loops", items, enabled: true };
  }

  private async buildMailboxSummary(workspaceId: string): Promise<BriefingSection> {
    const digest = this.deps.getMailboxDigest
      ? await this.deps.getMailboxDigest(workspaceId)
      : null;
    if (!digest) {
      return { type: "mailbox_summary", title: "Inbox Summary", items: [], enabled: true };
    }

    const items: BriefingItem[] = [
      {
        label: `${digest.unreadCount} unread thread${digest.unreadCount === 1 ? "" : "s"}`,
        status: digest.unreadCount > 0 ? "pending" : "completed",
      },
      {
        label: `${digest.needsReplyCount} need${digest.needsReplyCount === 1 ? "s" : ""} reply`,
        status: digest.needsReplyCount > 0 ? "pending" : "completed",
      },
      {
        label: `${digest.overdueCommitmentCount} overdue commitment${digest.overdueCommitmentCount === 1 ? "" : "s"}`,
        status: digest.overdueCommitmentCount > 0 ? "failed" : "completed",
      },
      {
        label: `${digest.draftCount} draft${digest.draftCount === 1 ? "" : "s"} in progress`,
        status: digest.draftCount > 0 ? "info" : "completed",
      },
      {
        label: `${digest.sensitiveThreadCount} sensitive thread${digest.sensitiveThreadCount === 1 ? "" : "s"}`,
        status: digest.sensitiveThreadCount > 0 ? "info" : "completed",
      },
    ];

    if (digest.recentEventTypes.length) {
      items.push({
        label: `${digest.eventCount} mailbox event${digest.eventCount === 1 ? "" : "s"} captured`,
        detail: digest.recentEventTypes
          .map(
            (event: MailboxDigestSnapshot["recentEventTypes"][number]) =>
              `${event.type}: ${event.count}`,
          )
          .join(" · "),
        status: "info",
      });
    }

    return { type: "mailbox_summary", title: "Inbox Summary", items, enabled: true };
  }

  private async buildAwarenessDigest(workspaceId: string): Promise<BriefingSection> {
    try {
      const summary = await this.deps.getAwarenessSummary?.(workspaceId);
      const autonomyState = await this.deps.getAutonomyState?.(workspaceId);
      const autonomyDecisions = (await this.deps.getAutonomyDecisions?.(workspaceId)) || [];
      if (!summary) {
        return { type: "awareness_digest", title: "Awareness Digest", items: [], enabled: true };
      }

      const items: BriefingItem[] = [];
      const riskSignals = (summary.whatMattersNow || [])
        .filter((item: Any) => this.isUsefulAwarenessItem(item))
        .filter((item: Any) => {
          const tags = Array.isArray(item?.tags)
            ? item.tags.map((tag: unknown) => String(tag).toLowerCase())
            : [];
          const text = `${item?.title || ""} ${item?.detail || ""}`;
          return (
            tags.includes("deadline") ||
            tags.includes("due_soon") ||
            /\b(block|blocked|risk|failure|failing|timeout|urgent|deadline|error)\b/i.test(text)
          );
        })
        .slice(0, 3);
      for (const entry of riskSignals) {
        items.push({
          label: entry.title,
          detail: entry.detail,
          status: entry.tags?.includes("deadline") ? "pending" : "info",
        });
      }

      for (const entry of summary.dueSoon?.slice(0, 3) || []) {
        if (!this.isUsefulAwarenessItem(entry)) continue;
        items.push({
          label: entry.title,
          detail: entry.detail,
          status: "pending",
        });
      }

      const usefulGoals = (autonomyState?.goals || [])
        .map((goal: Any) => ({ ...goal, _score: this.goalScore(goal) }))
        .filter((goal: Any) => goal._score > 0)
        .sort((a: Any, b: Any) => b._score - a._score)
        .slice(0, 2);
      for (const goal of usefulGoals) {
        items.push({
          label: `${goal.status === "blocked" ? "Blocked goal" : "Active goal"}: ${this.normalizeSemanticText(goal.title)}`,
          detail: `Status ${goal.status}, confidence ${Math.round((goal.confidence || 0) * 100)}%`,
          status: goal.status === "blocked" ? "failed" : "info",
        });
      }

      const deduped = this.dedupeBriefingItems(
        items,
        (item) =>
          `${this.normalizeSemanticText(item.label || "")}::${this.normalizeSemanticText(item.detail || "")}`,
        4,
      ).map((item: Any) => ({
        label: this.stripMarkdownFormatting(item.label),
        detail:
          item.detail || (item.workspaceName ? `Workspaces: ${item.workspaceName}` : undefined),
        status: item.status,
      }));

      const usefulDecisions = autonomyDecisions
        .map((decision: Any) => ({ ...decision, _score: this.decisionScore(decision) }))
        .filter((decision: Any) => decision._score > 0)
        .sort((a: Any, b: Any) => b._score - a._score)
        .slice(0, 2);
      for (const decision of usefulDecisions) {
        deduped.push({
          label: `Decision needed: ${this.normalizeSemanticText(decision.title)}`,
          detail: this.normalizeSemanticText(decision.description),
          status: decision.priority === "high" ? "pending" : "info",
        });
      }

      return {
        type: "awareness_digest",
        title: "Needs Attention Today",
        items: this.dedupeBriefingItems(
          deduped,
          (item) =>
            `${this.normalizeSemanticText(item.label || "")}::${this.normalizeSemanticText(item.detail || "")}`,
          4,
        ),
        enabled: true,
      };
    } catch (error) {
      this.log("[DailyBriefing] buildAwarenessDigest skipped:", error);
      return { type: "awareness_digest", title: "Awareness Digest", items: [], enabled: true };
    }
  }

  /** Max ms to wait for evolution metrics before skipping the section. */
  private static readonly EVOLUTION_METRICS_TIMEOUT_MS = 5_000;

  private async buildEvolutionMetrics(workspaceId: string): Promise<BriefingSection> {
    try {
      const { EvolutionMetricsService } = await import("../memory/EvolutionMetricsService");

      // Guard against a slow computeSnapshot stalling the entire briefing pipeline.
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("EvolutionMetricsService timed out")),
          DailyBriefingService.EVOLUTION_METRICS_TIMEOUT_MS,
        ),
      );
      const snapshot = await Promise.race([
        EvolutionMetricsService.computeSnapshot(workspaceId),
        timeoutPromise,
      ]);
      if (!this.evolutionHasEnoughSignal(snapshot)) {
        return { type: "evolution_metrics", title: "Agent Evolution", items: [], enabled: true };
      }

      const items: BriefingItem[] = snapshot.metrics.map((m) => ({
        label: `${m.label}: ${m.value}${m.unit}`,
        detail: m.detail,
        status:
          m.trend === "improving"
            ? ("completed" as const)
            : m.trend === "declining"
              ? ("failed" as const)
              : ("info" as const),
      }));
      items.push({
        label: `Overall Evolution Score: ${snapshot.overallScore}/100`,
        status: "info",
      });
      return { type: "evolution_metrics", title: "Agent Evolution", items, enabled: true };
    } catch (err) {
      this.log("[DailyBriefing] buildEvolutionMetrics skipped:", (err as Error)?.message ?? err);
      return { type: "evolution_metrics", title: "Agent Evolution", items: [], enabled: true };
    }
  }

  // ── Config management ───────────────────────────────────────────

  getConfig(workspaceId: string): BriefingConfig {
    const cached = this.configs.get(workspaceId);
    if (cached) return cached;
    const loaded = this.loadConfigFromDB(workspaceId);
    if (loaded) {
      this.configs.set(workspaceId, loaded);
      return loaded;
    }
    return { ...DEFAULT_BRIEFING_CONFIG };
  }

  saveConfig(workspaceId: string, config: BriefingConfig): void {
    this.configs.set(workspaceId, config);
    this.saveConfigToDB(workspaceId, config);
  }

  // ── Text formatting ─────────────────────────────────────────────

  private formatBriefingAsText(briefing: Briefing): string {
    const lines = [
      `Good morning! Here's your daily briefing for ${new Date(briefing.generatedAt).toLocaleDateString()}:\n`,
    ];

    for (const section of briefing.sections) {
      lines.push(`**${section.title}**`);
      for (const item of section.items) {
        const prefix =
          item.status === "completed"
            ? "✅"
            : item.status === "failed"
              ? "❌"
              : item.status === "running"
                ? "🔄"
                : item.status === "pending"
                  ? "⏳"
                  : "ℹ️";
        lines.push(`${prefix} ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // ── Database persistence ────────────────────────────────────────

  private ensureSchema(): void {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS briefing_config (
          workspace_id TEXT PRIMARY KEY,
          schedule_time TEXT DEFAULT '08:00',
          enabled_sections TEXT DEFAULT '{}',
          delivery_channel_type TEXT,
          delivery_channel_id TEXT,
          enabled INTEGER DEFAULT 0,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS briefings (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          generated_at INTEGER NOT NULL,
          sections TEXT NOT NULL,
          delivered INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_briefings_workspace ON briefings(workspace_id, generated_at DESC);
      `);
    } catch {
      // Tables already exist
    }
  }

  private saveBriefingToDB(briefing: Briefing): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO briefings (id, workspace_id, generated_at, sections, delivered)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          briefing.id,
          briefing.workspaceId,
          briefing.generatedAt,
          JSON.stringify(briefing.sections),
          briefing.delivered ? 1 : 0,
        );
    } catch (err) {
      this.log("[DailyBriefing] DB save error:", err);
    }
  }

  private loadLatestFromDB(workspaceId: string): Briefing | undefined {
    if (!this.db) return undefined;
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM briefings WHERE workspace_id = ? ORDER BY generated_at DESC LIMIT 1",
        )
        .get(workspaceId) as Any;
      if (!row) return undefined;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        generatedAt: row.generated_at,
        sections: JSON.parse(row.sections || "[]"),
        delivered: !!row.delivered,
      };
    } catch {
      return undefined;
    }
  }

  private saveConfigToDB(workspaceId: string, config: BriefingConfig): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO briefing_config
         (workspace_id, schedule_time, enabled_sections, delivery_channel_type, delivery_channel_id, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workspaceId,
          config.scheduleTime,
          JSON.stringify(config.enabledSections),
          config.deliveryChannelType || null,
          config.deliveryChannelId || null,
          config.enabled ? 1 : 0,
          Date.now(),
        );
    } catch (err) {
      this.log("[DailyBriefing] Config save error:", err);
    }
  }

  private loadConfigFromDB(workspaceId: string): BriefingConfig | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare("SELECT * FROM briefing_config WHERE workspace_id = ?")
        .get(workspaceId) as Any;
      if (!row) return null;
      return {
        scheduleTime: row.schedule_time || "08:00",
        enabledSections: JSON.parse(row.enabled_sections || "{}"),
        deliveryChannelType: row.delivery_channel_type || undefined,
        deliveryChannelId: row.delivery_channel_id || undefined,
        enabled: !!row.enabled,
      };
    } catch {
      return null;
    }
  }

  private log(...args: unknown[]): void {
    if (this.deps.log) this.deps.log(...args);
    else console.log(...args);
  }
}
