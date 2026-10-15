/**
 * Form and model logic for Workday agent setup in MCP settings: the admin
 * connection form and the editable agent definition (skills and their tools).
 * Main validates everything again; these helpers keep the panel honest and
 * the stored admin secret out of the renderer (a blank field keeps it).
 */
import type {
  WorkdayAdminConnectionRequest,
  WorkdayAgentExecutionMode,
  WorkdayAgentModel,
  WorkdayAgentResource,
  WorkdayAgentSaveResult,
  WorkdayAgentSkill,
} from "../../shared/types";

export interface WorkdayAdminForm {
  tenantHost: string;
  servicesHost: string;
  /** False while the services host follows the tenant host. */
  servicesHostEdited: boolean;
  clientId: string;
  clientSecret: string;
  usePkce: boolean;
}

/** The saved admin connection as settings show it; the secret arrives masked. */
export interface WorkdayAdminDisplay {
  tenantHost?: string;
  servicesHost?: string;
  clientId?: string;
  clientSecret?: string;
  usePkce?: boolean;
}

export const EMPTY_WORKDAY_ADMIN_FORM: WorkdayAdminForm = {
  tenantHost: "",
  servicesHost: "",
  servicesHostEdited: false,
  clientId: "",
  clientSecret: "",
  usePkce: false,
};

/** The host part of what the person typed (they may paste an https origin). */
function bareHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/+$/, "");
}

/** odpimpl.wd119.myworkday.com -> odpimpl-services1.wd119.myworkday.com ("" until it has a domain). */
export function deriveServicesHost(tenantHost: string): string {
  const host = bareHost(tenantHost);
  const labels = host.split(".");
  if (labels.length < 3 || labels.some((label) => !label)) return "";
  if (labels[0].endsWith("-services1")) return host;
  return [`${labels[0]}-services1`, ...labels.slice(1)].join(".");
}

export function adminFormFromServer(admin?: WorkdayAdminDisplay): {
  form: WorkdayAdminForm;
  storedSecret: boolean;
} {
  if (!admin?.tenantHost) return { form: { ...EMPTY_WORKDAY_ADMIN_FORM }, storedSecret: false };
  const derived = deriveServicesHost(admin.tenantHost);
  const servicesHost = admin.servicesHost || derived;
  return {
    form: {
      tenantHost: admin.tenantHost,
      servicesHost,
      servicesHostEdited: servicesHost !== derived,
      clientId: admin.clientId ?? "",
      clientSecret: "",
      usePkce: Boolean(admin.usePkce),
    },
    storedSecret: Boolean(admin.clientSecret),
  };
}

/** Typing a tenant host keeps the services host in step until the person edits it. */
export function withTenantHost(form: WorkdayAdminForm, tenantHost: string): WorkdayAdminForm {
  return {
    ...form,
    tenantHost,
    servicesHost: form.servicesHostEdited ? form.servicesHost : deriveServicesHost(tenantHost),
  };
}

export function withServicesHost(form: WorkdayAdminForm, servicesHost: string): WorkdayAdminForm {
  return {
    ...form,
    servicesHost,
    // Clearing the field goes back to the derived host.
    servicesHostEdited: Boolean(servicesHost.trim()),
  };
}

export function adminFormReady(form: WorkdayAdminForm, storedSecret: boolean): boolean {
  return Boolean(
    form.tenantHost.trim() && form.clientId.trim() && (form.clientSecret.trim() || storedSecret),
  );
}

/** The request main validates. A blank secret is left out, so the saved one is kept. */
export function adminConnectionRequest(
  serverId: string,
  form: WorkdayAdminForm,
): WorkdayAdminConnectionRequest {
  const servicesHost = bareHost(form.servicesHost);
  const derived = deriveServicesHost(form.tenantHost);
  return {
    serverId,
    tenantHost: bareHost(form.tenantHost),
    ...(servicesHost && servicesHost !== derived ? { servicesHost } : {}),
    clientId: form.clientId.trim(),
    ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}),
    usePkce: form.usePkce,
  };
}

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

export const SKILL_ID_PATTERN = /^[a-z0-9_]{1,64}$/;
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_./-]{1,128}$/;

export function newAgentModel(): WorkdayAgentModel {
  return {
    name: "CoWork",
    description: "CoWork OS desktop agent",
    version: "1.0",
    skills: [],
  };
}

/** "Time Off Balances" -> "time_off_balances". */
export function skillIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export interface NewSkillForm {
  id: string;
  name: string;
  description: string;
  executionMode: WorkdayAgentExecutionMode;
}

export const EMPTY_NEW_SKILL: NewSkillForm = {
  id: "",
  name: "",
  description: "",
  executionMode: "Delegate",
};

export function addSkill(
  model: WorkdayAgentModel,
  form: NewSkillForm,
): { model: WorkdayAgentModel } | { error: string } {
  const name = form.name.trim();
  const id = form.id.trim() || skillIdFromName(name);
  if (!name) return { error: "Give the skill a name" };
  if (name.length > 100) return { error: "Skill names are at most 100 characters" };
  if (!SKILL_ID_PATTERN.test(id))
    return { error: "Skill IDs use lowercase letters, digits and _ (up to 64)" };
  if (model.skills.some((skill) => skill.id === id))
    return { error: `A skill with ID ${id} already exists` };
  const skill: WorkdayAgentSkill = {
    id,
    name,
    description: form.description.trim(),
    executionMode: form.executionMode,
    tools: [],
  };
  return { model: { ...model, skills: [...model.skills, skill] } };
}

function mapSkill(
  model: WorkdayAgentModel,
  skillId: string,
  change: (skill: WorkdayAgentSkill) => WorkdayAgentSkill,
): WorkdayAgentModel {
  return {
    ...model,
    skills: model.skills.map((skill) => (skill.id === skillId ? change(skill) : skill)),
  };
}

export function removeSkill(model: WorkdayAgentModel, skillId: string): WorkdayAgentModel {
  return { ...model, skills: model.skills.filter((skill) => skill.id !== skillId) };
}

export function setSkillMode(
  model: WorkdayAgentModel,
  skillId: string,
  executionMode: WorkdayAgentExecutionMode,
): WorkdayAgentModel {
  return mapSkill(model, skillId, (skill) => ({ ...skill, executionMode }));
}

/** Only names Workday accepts as a tool name can be granted (SOAP/REST titles cannot). */
export function isAddableResource(resource: WorkdayAgentResource): boolean {
  return TOOL_NAME_PATTERN.test(resource.toolName);
}

export function addTool(
  model: WorkdayAgentModel,
  skillId: string,
  resource: WorkdayAgentResource,
): WorkdayAgentModel {
  if (!isAddableResource(resource)) return model;
  return mapSkill(model, skillId, (skill) =>
    skill.tools.some((tool) => tool.wid === resource.wid)
      ? skill
      : {
          ...skill,
          tools: [
            ...skill.tools,
            { toolName: resource.toolName, wid: resource.wid, description: "" },
          ],
        },
  );
}

export function removeTool(
  model: WorkdayAgentModel,
  skillId: string,
  wid: string,
): WorkdayAgentModel {
  return mapSkill(model, skillId, (skill) => ({
    ...skill,
    tools: skill.tools.filter((tool) => tool.wid !== wid),
  }));
}

export function toolCount(model: WorkdayAgentModel): number {
  return model.skills.reduce((sum, skill) => sum + skill.tools.length, 0);
}

/** Tools that can change Workday data; CoWork asks before running them. */
export function needsApproval(toolName: string): boolean {
  return /^(create|update|delete|submit|request)_/i.test(toolName);
}

/** What stops a save, checked here so the person sees it before main refuses. */
export function agentProblems(model: WorkdayAgentModel): string[] {
  const problems: string[] = [];
  if (!model.name.trim()) problems.push("Give the agent a name");
  else if (model.name.trim().length > 100) problems.push("Agent names are at most 100 characters");
  if (!model.description.trim()) problems.push("Give the agent a description");
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(model.version.trim()))
    problems.push("Version uses letters, digits, . _ and - (for example 1.0)");
  if (!model.skills.length) problems.push("Add at least one skill");
  for (const skill of model.skills) {
    if (!SKILL_ID_PATTERN.test(skill.id)) problems.push(`Skill ID ${skill.id} is not valid`);
    for (const tool of skill.tools)
      if (!TOOL_NAME_PATTERN.test(tool.toolName) || !/^[0-9a-f]{32}$/.test(tool.wid))
        problems.push(`${tool.toolName || "A tool"} in ${skill.name} has no valid name or WID`);
  }
  return problems;
}

/** The definition sent to main, trimmed. */
export function agentRequest(model: WorkdayAgentModel): WorkdayAgentModel {
  return {
    ...(model.id ? { id: model.id } : {}),
    name: model.name.trim(),
    description: model.description.trim(),
    version: model.version.trim(),
    ...(model.url?.trim() ? { url: model.url.trim() } : {}),
    ...(model.documentationUrl?.trim() ? { documentationUrl: model.documentationUrl.trim() } : {}),
    skills: model.skills.map((skill) => ({
      ...skill,
      name: skill.name.trim(),
      description: skill.description.trim(),
      tools: skill.tools.map((tool) => ({ ...tool, description: tool.description.trim() })),
    })),
  };
}

/** One line per tool main could not find in the tenant's catalog. */
export function missingToolLines(
  result: Extract<WorkdayAgentSaveResult, { status: "missing_tools" }>,
): string[] {
  return result.missing.map((tool) =>
    tool.reason === "name_mismatch"
      ? `${tool.toolName} (${tool.wid}): the WID belongs to a different tool`
      : `${tool.toolName} (${tool.wid}): not found in this tenant's tool catalog`,
  );
}
