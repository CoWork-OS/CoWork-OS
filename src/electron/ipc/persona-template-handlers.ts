import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import type { ActivatePersonaTemplateRequest, PersonaTemplateCategory } from "../../shared/types";
import type { PersonaTemplateService } from "../agents/PersonaTemplateService";
import { rateLimiter } from "../utils/rate-limiter";

/**
 * Rate limit check helper
 */
function checkRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    throw new Error(`Rate limit exceeded for ${channel}`);
  }
}

/**
 * Dependencies for Persona Template handlers
 */
export interface PersonaTemplateDeps {
  personaTemplateService: PersonaTemplateService;
}

/**
 * Set up Persona Template IPC handlers for the Digital Twin system
 */
export function setupPersonaTemplateHandlers(deps: PersonaTemplateDeps): void {
  const { personaTemplateService } = deps;

  // List all persona templates, optionally filtered
  ipcMain.handle(
    IPC_CHANNELS.PERSONA_TEMPLATE_LIST,
    async (_, filter?: { category?: PersonaTemplateCategory; tag?: string }) => {
      return personaTemplateService.listTemplates(filter);
    },
  );

  // Get a single persona template by ID
  ipcMain.handle(IPC_CHANNELS.PERSONA_TEMPLATE_GET, async (_, id: string) => {
    if (!id || typeof id !== "string") {
      throw new Error("Template ID is required");
    }
    return personaTemplateService.getTemplate(id);
  });

  // Activate (instantiate) a persona template into an AgentRole
  ipcMain.handle(
    IPC_CHANNELS.PERSONA_TEMPLATE_ACTIVATE,
    async (_, request: ActivatePersonaTemplateRequest) => {
      checkRateLimit(IPC_CHANNELS.PERSONA_TEMPLATE_ACTIVATE);

      if (!request || !request.templateId) {
        throw new Error("Template ID is required for activation");
      }

      return personaTemplateService.activate(request);
    },
  );

  // Preview what will be created without actually creating it
  ipcMain.handle(IPC_CHANNELS.PERSONA_TEMPLATE_PREVIEW, async (_, templateId: string) => {
    if (!templateId || typeof templateId !== "string") {
      throw new Error("Template ID is required");
    }
    return personaTemplateService.previewActivation(templateId);
  });

  // Get all categories with counts
  ipcMain.handle(IPC_CHANNELS.PERSONA_TEMPLATE_GET_CATEGORIES, async () => {
    return personaTemplateService.getCategories();
  });
}
