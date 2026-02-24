import type { AgentCapability } from "../../electron/preload";

interface PersonaTemplateData {
  id: string;
  version: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  category: string;
  role: {
    capabilities: AgentCapability[];
    autonomyLevel: string;
    personalityId: string;
    systemPrompt: string;
    soul: string;
  };
  heartbeat: {
    enabled: boolean;
    intervalMinutes: number;
    staggerOffset: number;
  };
  cognitiveOffload: {
    primaryCategories: string[];
    proactiveTasks: Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      enabled: boolean;
    }>;
  };
  skills: Array<{ skillId: string; reason: string; required: boolean }>;
  tags: string[];
  seniorityRange: string[];
  industryAgnostic: boolean;
}

export type { PersonaTemplateData };

const CAPABILITY_LABELS: Record<string, string> = {
  code: "Code",
  review: "Review",
  research: "Research",
  test: "Test",
  document: "Document",
  plan: "Plan",
  design: "Design",
  analyze: "Analyze",
  ops: "DevOps",
  security: "Security",
  write: "Write",
  communicate: "Communicate",
  market: "Marketing",
  manage: "Manage",
  product: "Product",
};

const OFFLOAD_LABELS: Record<string, string> = {
  "context-switching": "Context Switching",
  "status-reporting": "Status Reporting",
  "information-triage": "Info Triage",
  "decision-preparation": "Decision Prep",
  documentation: "Documentation",
  "review-preparation": "Review Prep",
  "dependency-tracking": "Dep Tracking",
  "compliance-checks": "Compliance",
  "knowledge-curation": "Knowledge",
  "routine-automation": "Automation",
};

interface PersonaTemplateCardProps {
  template: PersonaTemplateData;
  onActivate: (template: PersonaTemplateData) => void;
}

export function PersonaTemplateCard({ template, onActivate }: PersonaTemplateCardProps) {
  const proactiveTasks = template.cognitiveOffload?.proactiveTasks ?? [];
  const capabilities = template.role?.capabilities ?? [];
  const primaryCategories = template.cognitiveOffload?.primaryCategories ?? [];
  const skills = template.skills ?? [];
  const enabledProactiveTasks = proactiveTasks.filter((t) => t.enabled);

  return (
    <div className="pt-card" onClick={() => onActivate(template)}>
      <div className="pt-card-header">
        <span className="pt-card-icon">{template.icon}</span>
        <span className="pt-card-name">{template.name}</span>
      </div>

      <p className="pt-card-description">{template.description}</p>

      <div className="pt-card-tags">
        {capabilities.slice(0, 4).map((cap) => (
          <span key={cap} className="pt-tag">
            {CAPABILITY_LABELS[cap] || cap}
          </span>
        ))}
        {capabilities.length > 4 && <span className="pt-tag">+{capabilities.length - 4}</span>}
      </div>

      <div className="pt-card-footer">
        <span className="pt-card-meta">
          {enabledProactiveTasks.length} tasks &middot; {skills.length} skills &middot;{" "}
          {primaryCategories
            .slice(0, 2)
            .map((c) => OFFLOAD_LABELS[c] || c)
            .join(", ")}
        </span>
        <span className="pt-card-action">Activate &rarr;</span>
      </div>
    </div>
  );
}
