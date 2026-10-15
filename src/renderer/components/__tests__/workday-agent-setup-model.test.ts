import { describe, expect, it } from "vitest";
import type { WorkdayAgentResource } from "../../../shared/types";
import {
  addSkill,
  addTool,
  adminConnectionRequest,
  adminFormFromServer,
  adminFormReady,
  agentProblems,
  agentRequest,
  deriveServicesHost,
  EMPTY_NEW_SKILL,
  EMPTY_WORKDAY_ADMIN_FORM,
  isAddableResource,
  missingToolLines,
  needsApproval,
  newAgentModel,
  removeSkill,
  removeTool,
  setSkillMode,
  skillIdFromName,
  toolCount,
  withServicesHost,
  withTenantHost,
} from "../workday-agent-setup-model";

const SERVER_ID = "6f0c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";
const ABSENCE: WorkdayAgentResource = {
  wid: "3cf962648a6a10001482cdbe30920000",
  toolName: "find_absence_balances",
  kind: "mcp",
};

describe("Workday admin connection form", () => {
  it("derives the services host until the person edits it", () => {
    expect(deriveServicesHost("odpimpl.wd119.myworkday.com")).toBe(
      "odpimpl-services1.wd119.myworkday.com",
    );
    expect(deriveServicesHost("https://odpimpl.wd119.myworkday.com/")).toBe(
      "odpimpl-services1.wd119.myworkday.com",
    );
    expect(deriveServicesHost("odpimpl")).toBe("");
    let form = withTenantHost(EMPTY_WORKDAY_ADMIN_FORM, "odpimpl.wd119.myworkday.com");
    expect(form.servicesHost).toBe("odpimpl-services1.wd119.myworkday.com");
    form = withServicesHost(form, "custom-services1.wd119.myworkday.com");
    form = withTenantHost(form, "other.wd119.myworkday.com");
    expect(form.servicesHost).toBe("custom-services1.wd119.myworkday.com");
    form = withServicesHost(form, "");
    form = withTenantHost(form, "odpimpl.wd119.myworkday.com");
    expect(form.servicesHost).toBe("odpimpl-services1.wd119.myworkday.com");
  });

  it("prefills from saved settings without the secret and keeps it when blank", () => {
    const { form, storedSecret } = adminFormFromServer({
      tenantHost: "odpimpl.wd119.myworkday.com",
      clientId: "admin-client",
      clientSecret: "***configured***",
      usePkce: true,
    });
    expect(storedSecret).toBe(true);
    expect(form.clientSecret).toBe("");
    expect(form.servicesHost).toBe("odpimpl-services1.wd119.myworkday.com");
    expect(form.servicesHostEdited).toBe(false);
    expect(adminFormReady(form, storedSecret)).toBe(true);
    expect(adminFormReady(form, false)).toBe(false);
    expect(adminConnectionRequest(SERVER_ID, form)).toEqual({
      serverId: SERVER_ID,
      tenantHost: "odpimpl.wd119.myworkday.com",
      clientId: "admin-client",
      usePkce: true,
    });
    const override = adminConnectionRequest(SERVER_ID, {
      ...form,
      servicesHost: "wd2-impl-services1.workday.com",
      clientSecret: " new-secret ",
    });
    expect(override.servicesHost).toBe("wd2-impl-services1.workday.com");
    expect(override.clientSecret).toBe("new-secret");
    expect(adminFormFromServer(undefined).storedSecret).toBe(false);
  });
});

describe("Workday agent model", () => {
  it("adds skills with derived, validated, unique IDs", () => {
    expect(skillIdFromName(" Time Off Balances! ")).toBe("time_off_balances");
    let model = newAgentModel();
    expect(model).toMatchObject({ name: "CoWork", version: "1.0", skills: [] });
    const added = addSkill(model, { ...EMPTY_NEW_SKILL, name: "Time Off Balances" });
    if (!("model" in added)) throw new Error(added.error);
    model = added.model;
    expect(model.skills[0]).toMatchObject({ id: "time_off_balances", executionMode: "Delegate" });
    expect(addSkill(model, { ...EMPTY_NEW_SKILL, name: "Time off balances" })).toEqual({
      error: "A skill with ID time_off_balances already exists",
    });
    expect(addSkill(model, { ...EMPTY_NEW_SKILL, name: "X", id: "Bad Id" })).toHaveProperty(
      "error",
    );
    expect(addSkill(model, EMPTY_NEW_SKILL)).toEqual({ error: "Give the skill a name" });
    model = setSkillMode(model, "time_off_balances", "Ambient");
    expect(model.skills[0]!.executionMode).toBe("Ambient");
    expect(removeSkill(model, "time_off_balances").skills).toEqual([]);
  });

  it("adds and removes tools once per skill, and only valid tool names", () => {
    const added = addSkill(newAgentModel(), { ...EMPTY_NEW_SKILL, name: "Time Off" });
    if (!("model" in added)) throw new Error(added.error);
    let model = addTool(added.model, "time_off", ABSENCE);
    model = addTool(model, "time_off", ABSENCE);
    expect(model.skills[0]!.tools).toEqual([
      { toolName: "find_absence_balances", wid: ABSENCE.wid, description: "" },
    ]);
    expect(toolCount(model)).toBe(1);
    const operation: WorkdayAgentResource = {
      wid: "0123456789abcdef0123456789abcdef",
      toolName: "Get Workers",
      kind: "operation",
    };
    expect(isAddableResource(operation)).toBe(false);
    expect(addTool(model, "time_off", operation)).toBe(model);
    expect(toolCount(removeTool(model, "time_off", ABSENCE.wid))).toBe(0);
  });

  it("flags tools that change data and problems that block a save", () => {
    for (const name of [
      "create_worker_preferred_name_change",
      "update_x",
      "delete_y",
      "submit_time_off",
      "request_absence",
    ])
      expect(needsApproval(name)).toBe(true);
    expect(needsApproval("find_absence_balances")).toBe(false);
    expect(agentProblems(newAgentModel())).toEqual(["Add at least one skill"]);
    const added = addSkill(
      { ...newAgentModel(), name: " ", version: "1 0" },
      { ...EMPTY_NEW_SKILL, name: "Skill" },
    );
    if (!("model" in added)) throw new Error(added.error);
    expect(agentProblems(added.model)).toEqual([
      "Give the agent a name",
      "Version uses letters, digits, . _ and - (for example 1.0)",
    ]);
  });

  it("trims the request and explains missing tools", () => {
    const added = addSkill(
      { ...newAgentModel(), name: " CoWork ", url: " " },
      { ...EMPTY_NEW_SKILL, name: "Time Off" },
    );
    if (!("model" in added)) throw new Error(added.error);
    const request = agentRequest(addTool(added.model, "time_off", ABSENCE));
    expect(request.name).toBe("CoWork");
    expect(request).not.toHaveProperty("url");
    expect(
      missingToolLines({
        status: "missing_tools",
        missing: [
          { toolName: "a_b", wid: ABSENCE.wid, reason: "not_found" },
          { toolName: "c_d", wid: ABSENCE.wid, reason: "name_mismatch" },
        ],
      }),
    ).toEqual([
      `a_b (${ABSENCE.wid}): not found in this tenant's tool catalog`,
      `c_d (${ABSENCE.wid}): the WID belongs to a different tool`,
    ]);
  });
});
