import type { AgentTemplate } from "../../shared/types";
import { BUILTIN_AGENT_TEMPLATES } from "./agent-templates";

export class AgentTemplateService {
  list(): AgentTemplate[] {
    return [...BUILTIN_AGENT_TEMPLATES];
  }

  get(id: string): AgentTemplate | undefined {
    return BUILTIN_AGENT_TEMPLATES.find((template) => template.id === id);
  }
}

