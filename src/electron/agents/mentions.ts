import type { AgentRole } from "../../shared/types";

const normalizeMentionToken = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const buildAgentMentionIndex = (roles: AgentRole[]) => {
  const index = new Map<string, AgentRole>();
  roles.forEach((role) => {
    const baseTokens = [
      role.name,
      role.displayName,
      role.name.replace(/[_-]+/g, ""),
      role.displayName.replace(/\s+/g, ""),
      role.displayName.replace(/\s+/g, "_"),
      role.displayName.replace(/\s+/g, "-"),
    ];
    baseTokens.forEach((token) => {
      const normalized = normalizeMentionToken(token);
      if (normalized) {
        index.set(normalized, role);
      }
    });
  });
  return index;
};

const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  code: [
    "code",
    "implement",
    "build",
    "develop",
    "feature",
    "api",
    "backend",
    "frontend",
    "refactor",
    "bug",
    "fix",
  ],
  review: ["review", "audit", "best practices", "quality", "lint"],
  test: ["test", "testing", "qa", "unit", "integration", "e2e", "regression", "coverage"],
  design: ["design", "ui", "ux", "wireframe", "mockup", "figma", "layout", "visual", "brand"],
  ops: [
    "deploy",
    "ci",
    "cd",
    "devops",
    "infra",
    "infrastructure",
    "docker",
    "kubernetes",
    "pipeline",
    "monitor",
  ],
  security: ["security", "vulnerability", "threat", "audit", "compliance", "encryption"],
  research: [
    "research",
    "investigate",
    "compare",
    "comparison",
    "competitive",
    "competitor",
    "benchmark",
    "study",
  ],
  analyze: ["analyze", "analysis", "data", "metrics", "insights", "report", "trend", "dashboard"],
  plan: ["plan", "strategy", "roadmap", "architecture", "outline", "spec"],
  document: ["document", "documentation", "docs", "guide", "manual", "readme", "spec"],
  write: ["write", "draft", "copy", "blog", "post", "article", "content", "summary"],
  communicate: ["email", "support", "customer", "communication", "outreach", "reply", "respond"],
  market: ["marketing", "growth", "campaign", "social", "seo", "launch", "newsletter", "ads"],
  manage: ["manage", "project", "timeline", "milestone", "coordination", "sprint", "backlog"],
  product: ["product", "feature", "user story", "requirements", "prioritize", "mvp"],
};

const scoreAgentForTask = (role: AgentRole, text: string) => {
  const lowerText = text.toLowerCase();
  let score = 0;
  const roleText = `${role.name} ${role.displayName} ${role.description ?? ""}`.toLowerCase();
  const tokens = roleText.split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  tokens.forEach((token) => {
    if (lowerText.includes(token)) {
      score += 1;
    }
  });

  if (role.capabilities) {
    role.capabilities.forEach((capability) => {
      const keywords = CAPABILITY_KEYWORDS[capability];
      if (keywords && keywords.some((keyword) => lowerText.includes(keyword))) {
        score += 3;
      }
    });
  }

  return score;
};

const MAX_AUTO_AGENTS = 4;

const selectBestAgentsForTask = (text: string, roles: AgentRole[], maxAgents = MAX_AUTO_AGENTS) => {
  if (roles.length === 0) return roles;
  const scored = roles
    .map((role) => ({ role, score: scoreAgentForTask(role, text) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.role.sortOrder ?? 0) - (b.role.sortOrder ?? 0);
    });

  const withScore = scored.filter((entry) => entry.score > 0);
  if (withScore.length > 0) {
    const maxScore = withScore[0].score;
    const threshold = Math.max(1, maxScore - 2);
    const selected = withScore
      .filter((entry) => entry.score >= threshold)
      .slice(0, maxAgents)
      .map((entry) => entry.role);
    return selected.length > 0
      ? selected
      : withScore.slice(0, maxAgents).map((entry) => entry.role);
  }

  const leads = roles
    .filter((role) => role.autonomyLevel === "lead")
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  if (leads.length > 0) {
    return leads.slice(0, maxAgents);
  }

  return roles.slice(0, Math.min(maxAgents, roles.length));
};

export const extractMentionedRoles = (text: string, roles: AgentRole[]) => {
  const normalizedText = text.toLowerCase();
  const useSmartSelection =
    /\B@everybody\b/.test(normalizedText) ||
    /\B@all\b/.test(normalizedText) ||
    /\B@everyone\b/.test(normalizedText);

  const index = buildAgentMentionIndex(roles);
  const matches = new Map<string, AgentRole>();

  const regex = /@([a-zA-Z0-9][a-zA-Z0-9 _-]{0,50})/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1].replace(/[.,:;!?)]*$/, "").trim();
    const token = normalizeMentionToken(raw);
    const role = index.get(token);
    if (role) {
      matches.set(role.id, role);
    }
  }

  if (matches.size > 0) {
    if (useSmartSelection) {
      const merged = new Map<string, AgentRole>();
      matches.forEach((role) => merged.set(role.id, role));
      const selected = selectBestAgentsForTask(text, roles, MAX_AUTO_AGENTS);
      selected.forEach((role) => {
        if (merged.size < MAX_AUTO_AGENTS) {
          merged.set(role.id, role);
        }
      });
      return Array.from(merged.values()).slice(0, MAX_AUTO_AGENTS);
    }
    return Array.from(matches.values());
  }

  const normalizedWithAt = text.toLowerCase().replace(/[^a-z0-9@]/g, "");

  index.forEach((role, token) => {
    if (normalizedWithAt.includes(`@${token}`)) {
      matches.set(role.id, role);
    }
  });

  if (useSmartSelection) {
    return selectBestAgentsForTask(text, roles, MAX_AUTO_AGENTS);
  }

  return Array.from(matches.values());
};
